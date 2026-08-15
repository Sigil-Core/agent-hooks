import {
  canonicalizePgCommitV1,
  compiledResponsePolicyFormat1Bytes,
  type CompiledResponsePolicyFormat1,
  type CompiledResponsePolicyVerificationContext,
  type CryptoAdapter,
} from '@sigilcore/warrant-core';
import { createNodeCryptoAdapter } from '@sigilcore/warrant-core/crypto/node';
import { describe, expect, it, vi } from 'vitest';

import {
  CALL_TOOL_RESULT_CONTENT_TYPE,
  DETERMINISTIC_RULESET_V1_DIGEST,
  RESPONSE_CLASS_CATALOG_V1_DIGEST,
  projectCallToolResult,
  verifyAndCheckResult,
  verifyResponsePolicyAuthorization,
  type CheckResultInput,
  type SigilResponsePolicyAuthorization,
} from '../src/index.js';

const PRIVATE_KEY = new Uint8Array(
  Buffer.from(
    'MC4CAQAwBQYDK2VwBCIEIMH8dHLPxVMdy32BTSw30tXWbqlL2ILzZ79GR4dEq38D',
    'base64url',
  ),
);
const PUBLIC_KEY = new Uint8Array(
  Buffer.from(
    'MCowBQYDK2VwAyEA3MbOmN4swDGZkQ-jYiOvbkoMDTpETKfGwEP7jwYyP-o',
    'base64url',
  ),
);
const encoder = new TextEncoder();

const digestHex = async (adapter: CryptoAdapter, bytes: Uint8Array): Promise<string> =>
  Array.from(await adapter.sha256(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const payload = (): CompiledResponsePolicyFormat1 => ({
  kind: 'CompiledResponsePolicy',
  formatVersion: 1,
  issuer: 'https://sign.sigil.example',
  keyId: 'sign-key-1',
  audience: 'sigil-agent-hooks',
  scope: 'mcp:result-inspect',
  tenantId: 'tenant-1',
  taskId: 'task-1',
  policyVersion: '2.2.0',
  policyHash: '3'.repeat(64),
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_300,
  revocationEpoch: 7,
  coveredTools: ['example.fetch'],
  deterministicRuleset: {
    id: 'sof-response-rules-v1',
    digest: DETERMINISTIC_RULESET_V1_DIGEST,
  },
  classCatalog: {
    id: 'sof-response-classes-v1',
    digest: RESPONSE_CLASS_CATALOG_V1_DIGEST,
  },
  bounds: {
    maxProjectionBytes: 16777216,
    maxNestingDepth: 16,
    maxFindings: 256,
    maxScannerResponseBytes: 1048576,
    scannerDeadlineMs: 2000,
    maxEnvelopeLifetimeSeconds: 300,
    clockSkewSeconds: 30,
    maxObserveWindowSeconds: 2592000,
  },
  policy: {
    deterministicRuleset: 'sof-response-rules-v1',
    webFetchTools: ['example.fetch'],
    blockClasses: ['prompt_injection'],
  },
});

interface SignedFixture {
  adapter: CryptoAdapter;
  authorization: SigilResponsePolicyAuthorization;
  context: CompiledResponsePolicyVerificationContext;
}

async function signedFixture(): Promise<SignedFixture> {
  const adapter = createNodeCryptoAdapter();
  const sign = adapter.signEd25519;
  if (!sign) throw new Error('Node Warrant Core adapter must support Ed25519 signing.');
  const compiled = payload();
  const header = canonicalizePgCommitV1({
    alg: 'EdDSA',
    kid: compiled.keyId,
    typ: 'sof-compiled-response-policy+jws',
  });
  const headerSegment = Buffer.from(header, 'utf8').toString('base64url');
  const payloadBytes = compiledResponsePolicyFormat1Bytes(compiled);
  const payloadSegment = Buffer.from(payloadBytes).toString('base64url');
  const signature = await sign(
    PRIVATE_KEY,
    encoder.encode(`${headerSegment}.${payloadSegment}`),
  );
  const compactJws = `${headerSegment}.${payloadSegment}.${Buffer.from(signature).toString('base64url')}`;
  return {
    adapter,
    authorization: {
      compactJws,
      compiledPolicyDigest: await digestHex(adapter, payloadBytes),
      envelopeDigest: await digestHex(adapter, encoder.encode(compactJws)),
    },
    context: {
      publicKey: PUBLIC_KEY,
      issuer: compiled.issuer,
      keyId: compiled.keyId,
      tenantId: compiled.tenantId,
      taskId: compiled.taskId,
      policyHash: compiled.policyHash,
      revocationEpoch: compiled.revocationEpoch,
      deterministicRulesetDigest: DETERMINISTIC_RULESET_V1_DIGEST,
      classCatalogDigest: RESPONSE_CLASS_CATALOG_V1_DIGEST,
      now: compiled.issuedAt,
    },
  };
}

function resultInput(): Omit<CheckResultInput, 'verifiedPolicy'> {
  const projected = projectCallToolResult({
    content: [{ type: 'text', text: 'ordinary output' }],
  });
  if (!projected.ok) throw new Error(projected.reason);
  const trustedBindings = {
    authorizationBinding: '4'.repeat(64),
    requestIdDigest: '5'.repeat(64),
    requestDigest: '6'.repeat(64),
    resultDigest: '7'.repeat(64),
  };
  return {
    trustedBindings,
    authorizationBinding: trustedBindings.authorizationBinding,
    executionId: '0123456789abcdef0123456789abcdef',
    requestIdDigest: trustedBindings.requestIdDigest,
    requestDigest: trustedBindings.requestDigest,
    resultDigest: trustedBindings.resultDigest,
    contentType: CALL_TOOL_RESULT_CONTENT_TYPE,
    idempotencyKey: 'result:once',
    tool: 'example.fetch',
    tenantId: 'tenant-1',
    taskId: 'task-1',
    policyHash: '3'.repeat(64),
    projection: projected.projection,
    nowUnixSeconds: 1_800_000_000,
  };
}

describe('Policy 2.2 signed-envelope verification', () => {
  it('returns only the Warrant Core verified payload', async () => {
    const fixture = await signedFixture();
    const verified = await verifyResponsePolicyAuthorization(
      fixture.adapter,
      fixture.authorization,
      fixture.context,
    );
    expect(verified).toMatchObject(payload());
    expect(verified.compiledPolicyDigest).toBe(
      fixture.authorization.compiledPolicyDigest,
    );
  });

  it('rejects authorization accessors without invoking them', async () => {
    const fixture = await signedFixture();
    let getterCalls = 0;
    const authorization = {
      compiledPolicyDigest: fixture.authorization.compiledPolicyDigest,
      envelopeDigest: fixture.authorization.envelopeDigest,
    } as Record<string, unknown>;
    Object.defineProperty(authorization, 'compactJws', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return fixture.authorization.compactJws;
      },
    });
    await expect(
      verifyResponsePolicyAuthorization(
        fixture.adapter,
        authorization as unknown as SigilResponsePolicyAuthorization,
        fixture.context,
      ),
    ).rejects.toThrow('authorization is malformed');
    expect(getterCalls).toBe(0);
  });

  it.each([
    ['tenant binding', (fixture: SignedFixture) => ({
      ...fixture,
      context: { ...fixture.context, tenantId: 'attacker-tenant' },
    })],
    ['expiry', (fixture: SignedFixture) => ({
      ...fixture,
      context: { ...fixture.context, now: payload().expiresAt + 31 },
    })],
    ['compiled digest', (fixture: SignedFixture) => ({
      ...fixture,
      authorization: {
        ...fixture.authorization,
        compiledPolicyDigest: '8'.repeat(64),
      },
    })],
    ['envelope digest', (fixture: SignedFixture) => ({
      ...fixture,
      authorization: {
        ...fixture.authorization,
        envelopeDigest: '9'.repeat(64),
      },
    })],
    ['signature tamper', (fixture: SignedFixture) => ({
      ...fixture,
      authorization: {
        ...fixture.authorization,
        compactJws: `${fixture.authorization.compactJws.slice(0, -1)}${
          fixture.authorization.compactJws.endsWith('A') ? 'B' : 'A'
        }`,
      },
    })],
  ] as const)('fails closed for hostile %s input', async (_name, mutate) => {
    const hostile = mutate(await signedFixture());
    const decision = await verifyAndCheckResult({
      adapter: hostile.adapter,
      authorization: hostile.authorization,
      trustedContext: hostile.context,
      result: resultInput(),
    });
    expect(decision).toMatchObject({
      disposition: 'BLOCK',
      reason: 'envelope_invalid',
    });
  });

  it('verifies and evaluates locally with zero response egress', async () => {
    const fixture = await signedFixture();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const decision = await verifyAndCheckResult({
      adapter: fixture.adapter,
      authorization: fixture.authorization,
      trustedContext: fixture.context,
      result: resultInput(),
    });
    expect(decision).toMatchObject({ disposition: 'ALLOW', reason: 'none' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
