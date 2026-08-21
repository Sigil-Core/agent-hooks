import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizationPermitsExecution,
  clearDecisionKeyCacheForTests,
  normalizeDecisionLiteral,
  verifyAuthorizationResponse,
  type AuthorizationVerificationContext,
  type DecisionJwk,
} from '../src/decision.js';
import type { SigilHookResult } from '../src/types.js';

interface FixtureVector {
  id: string;
  status: string;
  decisionRecord: string | null;
  attestation: string | null;
  surface?: AuthorizationVerificationContext['surface'];
  execution?: boolean;
  keySet?: 'rotation_overlap';
  expected: {
    decision?: string;
    capability?: string;
    reason?: string;
    warnDecision?: string;
    warnCapability?: string;
    enforceDecision?: string;
  };
}

interface DecisionFixture {
  minimumVectorCount: number;
  minimumMalformedJoseVectorCount: number;
  publicJwk: DecisionJwk;
  rotationPublicJwk: DecisionJwk;
  context: AuthorizationVerificationContext;
  tokens: Record<string, string>;
  malformedJoseVectors: Array<{
    id: string;
    source: string;
    mutation:
      | 'append_segment'
      | 'pad_header'
      | 'invalid_header_character'
      | 'oversize'
      | 'extra_header'
      | 'duplicate_header';
  }>;
  vectors: FixtureVector[];
}

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/contract-fixtures/v1/decision-records.json'),
  'utf8',
)) as DecisionFixture;

const bodyFor = (vector: FixtureVector): Record<string, unknown> => ({
  status: vector.status,
  ...(vector.decisionRecord === null
    ? {}
    : { decision_record: fixture.tokens[vector.decisionRecord] }),
  ...(vector.attestation === null
    ? {}
    : { intent_attestation: fixture.tokens[vector.attestation] }),
  ...(vector.status === 'PENDING' ? { hold_id: 'hold-fixture-1' } : {}),
});

const context = (
  mode: 'warn' | 'enforce',
  overrides: Partial<AuthorizationVerificationContext> = {},
): AuthorizationVerificationContext => ({
  ...fixture.context,
  mode,
  execution: true,
  pinnedJwk: fixture.publicJwk,
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearDecisionKeyCacheForTests();
});

describe('decision vocabulary', () => {
  it('normalizes the permanent input alias and rejects the response-policy namespace', () => {
    expect(normalizeDecisionLiteral('APPROVED')).toBe('ALLOWED');
    expect(normalizeDecisionLiteral('ALLOWED')).toBe('ALLOWED');
    expect(normalizeDecisionLiteral('DENIED')).toBe('DENIED');
    expect(normalizeDecisionLiteral('PENDING')).toBe('PENDING');
    expect(() => normalizeDecisionLiteral('ALLOW')).toThrow('malformed');
  });

  it('loads at least the frozen minimum vector count', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(fixture.minimumVectorCount);
    expect(fixture.malformedJoseVectors.length)
      .toBeGreaterThanOrEqual(fixture.minimumMalformedJoseVectorCount);
  });
});

describe('verifyAuthorizationResponse', () => {
  for (const vector of fixture.vectors.filter((item) => item.expected.decision !== undefined)) {
    it(`enforces ${vector.id}`, async () => {
      if (vector.keySet === 'rotation_overlap') {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
          keys: [fixture.publicJwk, fixture.rotationPublicJwk],
        }), { status: 200 }));
      }
      const result = await verifyAuthorizationResponse(bodyFor(vector), context('enforce', {
        surface: vector.surface ?? 'authorize',
        execution: vector.execution ?? true,
        pinnedJwk: vector.keySet === 'rotation_overlap' ? undefined : fixture.publicJwk,
      }));
      expect(result.decision).toBe(vector.expected.decision);
      expect(result.reason).toBe(vector.expected.reason);
      expect(result.authorization?.kind).toBe(vector.expected.capability);
    });
  }

  for (const vector of fixture.vectors.filter((item) => item.expected.warnDecision !== undefined)) {
    it(`applies separate warn and enforce expectations for ${vector.id}`, async () => {
      const overrides = {
        surface: vector.surface ?? 'authorize',
        execution: vector.execution ?? true,
      } as const;
      const warned = await verifyAuthorizationResponse(bodyFor(vector), context('warn', overrides));
      expect(warned).toMatchObject({
        decision: vector.expected.warnDecision,
        reason: vector.expected.reason,
        authorization: { kind: vector.expected.warnCapability },
      });

      const enforced = await verifyAuthorizationResponse(
        bodyFor(vector),
        context('enforce', overrides),
      );
      expect(enforced).toMatchObject({
        decision: vector.expected.enforceDecision,
        reason: vector.expected.reason,
      });
      expect(enforced.authorization).toBeUndefined();
    });
  }

  it('keeps legitimate unsigned legacy traffic live in warn mode', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'legacy_missing_record') as FixtureVector;
    const result = await verifyAuthorizationResponse(bodyFor(vector), context('warn'));
    expect(result).toMatchObject({
      decision: vector.expected.warnDecision,
      reason: vector.expected.reason,
      authorization: { kind: vector.expected.warnCapability },
    });
  });

  it('kills the legacy branch in enforce mode', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'legacy_missing_record') as FixtureVector;
    const result = await verifyAuthorizationResponse(bodyFor(vector), context('enforce'));
    expect(result).toMatchObject({
      decision: vector.expected.enforceDecision,
      reason: vector.expected.reason,
    });
    expect(result.authorization).toBeUndefined();
  });

  it('never counterfeits a verified capability when warn mode sees tampering', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'tampered_signature') as FixtureVector;
    const result = await verifyAuthorizationResponse(bodyFor(vector), context('warn'));
    expect(result).toMatchObject({
      decision: 'ALLOWED',
      reason: 'signature',
      authorization: { kind: 'legacy-unverified' },
    });
  });

  it('fails closed in enforce mode without a policy pin', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { expectedPolicyHash: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'policy_binding' });
  });

  it('requires a real branded capability at the execution seam', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const verified = await verifyAuthorizationResponse(bodyFor(vector), context('enforce'));
    const result = { decision: verified.decision, authorization: verified.authorization } as SigilHookResult;
    expect(authorizationPermitsExecution(result)).toBe(true);
    expect(authorizationPermitsExecution({
      decision: 'ALLOWED',
      authorization: { kind: 'verified', decision: 'ALLOWED' } as never,
    })).toBe(false);
  });

  it('uses a static pin before JWKS network discovery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(bodyFor(vector), context('enforce'));
    expect(result.authorization?.kind).toBe('verified');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-TLS origins before key discovery', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { signOrigin: 'http://sign-test.sigilcore.com' }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'audience' });
  });

  it('ignores response-supplied origins', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const body = { ...bodyFor(vector), jwks_uri: 'https://attacker.example/jwks.json' };
    const result = await verifyAuthorizationResponse(body, context('enforce'));
    expect(result.authorization?.kind).toBe('verified');
  });

  it('rejects oversized JWKS documents before parsing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ keys: [], padding: 'x'.repeat(65 * 1024) }),
      { status: 200 },
    ));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('stops an incrementally streamed JWKS as soon as the byte limit is exceeded', async () => {
    let cancelled = false;
    let chunksSent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1;
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(stream, { status: 200 }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
    // One 40 KiB chunk is below the 64 KiB limit and the second crosses it, so
    // exactly two proves both that the reader reached the limit and did not
    // request any excess data after crossing it.
    expect(chunksSent).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('bounds JWKS discovery with an AbortSignal timeout', async () => {
    let suppliedSignal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_input, init) => {
      suppliedSignal = init?.signal;
      return new Response(JSON.stringify({ keys: [fixture.publicJwk] }), { status: 200 });
    });
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result.authorization?.kind).toBe('verified');
    expect(suppliedSignal).toBeInstanceOf(AbortSignal);
  });

  it('maps an abort-driven stalled JWKS fetch to key_unavailable', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
      }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const pending = verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    controller.abort();
    await expect(pending).resolves.toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('rejects redirect failures during exact-origin JWKS discovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('redirect mode is set to error'));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it.each(fixture.malformedJoseVectors)(
    'rejects shared malformed JOSE vector $id',
    async ({ source, mutation }) => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const body = bodyFor(vector);
    const token = fixture.tokens[source];
    const [header, payload, signature] = token.split('.');
    const mutated = (() => {
      switch (mutation) {
        case 'append_segment': return `${token}.extra`;
        case 'pad_header': return `${header}=.${payload}.${signature}`;
        case 'invalid_header_character': return `!${token.slice(1)}`;
        case 'oversize': return `${token}${'x'.repeat(8 * 1024)}`;
        case 'extra_header': {
          const extraHeader = Buffer.from(JSON.stringify({
            alg: 'EdDSA',
            kid: fixture.publicJwk.kid,
            typ: 'sof-decision+jws',
            crit: ['b64'],
          })).toString('base64url');
          return `${extraHeader}.${payload}.${signature}`;
        }
        case 'duplicate_header': {
          const duplicateHeader = Buffer.from(
            `{"alg":"EdDSA","alg":"none","kid":"${fixture.publicJwk.kid}","typ":"sof-decision+jws"}`,
          ).toString('base64url');
          return `${duplicateHeader}.${payload}.${signature}`;
        }
      }
    })();
    body['decision_record'] = mutated;
    const result = await verifyAuthorizationResponse(body, context('enforce'));
    expect(result).toEqual({ decision: 'DENIED', reason: 'malformed' });
  });

  it('rejects a JWKS with duplicate kids', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      keys: [fixture.publicJwk, fixture.publicJwk],
    }), { status: 200 }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('rejects a non-array key_ops value in a JWKS', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      keys: [{ ...fixture.publicJwk, key_ops: 'verify' }],
    }), { status: 200 }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('uses valid Ed25519 keys alongside unrelated JWKS algorithms', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      keys: [
        { kty: 'RSA', kid: 'unrelated-rsa', n: 'AQAB', e: 'AQAB', use: 'sig' },
        fixture.publicJwk,
      ],
    }), { status: 200 }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const result = await verifyAuthorizationResponse(
      bodyFor(vector),
      context('enforce', { pinnedJwk: undefined }),
    );
    expect(result.authorization?.kind).toBe('verified');
  });

  it('fails safely when the Node process global is unavailable', () => {
    vi.stubGlobal('process', undefined);
    expect(() => clearDecisionKeyCacheForTests()).toThrow('Decision key cache reset is test-only');
  });

  it('honors the 300 second JWKS cache TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2033-05-18T03:33:20Z'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ keys: [fixture.publicJwk] }), { status: 200 }));
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const unpinned = context('enforce', { pinnedJwk: undefined });
    expect((await verifyAuthorizationResponse(bodyFor(vector), unpinned)).authorization?.kind).toBe('verified');
    expect((await verifyAuthorizationResponse(bodyFor(vector), unpinned)).authorization?.kind).toBe('verified');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(300_001);
    expect((await verifyAuthorizationResponse(bodyFor(vector), unpinned)).authorization?.kind).toBe('verified');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('reports advisory median verification latency over 1000 runs', async () => {
    const vector = fixture.vectors.find((item) => item.id === 'valid_allowed') as FixtureVector;
    const samples: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const started = performance.now();
      const result = await verifyAuthorizationResponse(bodyFor(vector), context('enforce'));
      expect(result.authorization?.kind).toBe('verified');
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    console.info(JSON.stringify({
      event: 'decision.verification_latency',
      samples: samples.length,
      median_ms: samples[Math.floor(samples.length / 2)],
      advisory_budget_ms: 5,
    }));
  });
});
