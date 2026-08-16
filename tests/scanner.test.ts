import { createHash } from 'node:crypto';
import type { VerifiedCompiledResponsePolicyFormat2 } from '@sigilcore/warrant-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CALL_TOOL_RESULT_CONTENT_TYPE,
  DETERMINISTIC_RULESET_V1_DIGEST,
  RESPONSE_CLASS_CATALOG_V1_DIGEST,
  SCANNER_PROTOCOL_VERSION,
  checkResultV2,
  projectCallToolResult,
  type AuthenticatedScannerTransport,
  type CheckResultV2Input,
  type ResultProjectionV1,
  type ScannerRequestV1,
} from '../src/index.js';

const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function policy(
  overrides: Partial<VerifiedCompiledResponsePolicyFormat2['policy']> = {},
): VerifiedCompiledResponsePolicyFormat2 {
  return {
    kind: 'CompiledResponsePolicy',
    formatVersion: 2,
    issuer: 'https://sign.sigilcore.test',
    keyId: 'sign-test-2',
    audience: 'sigil-agent-hooks',
    scope: 'mcp:result-inspect',
    tenantId: 'tenant-1',
    taskId: 'task-1',
    policyVersion: '2.3.0',
    policyHash: digest('policy'),
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_300,
    revocationEpoch: 4,
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
      maxProjectionBytes: 16_777_216,
      maxNestingDepth: 16,
      maxFindings: 256,
      maxScannerResponseBytes: 1_048_576,
      scannerDeadlineMs: 2_000,
      maxEnvelopeLifetimeSeconds: 300,
      clockSkewSeconds: 30,
      maxObserveWindowSeconds: 2_592_000,
    },
    policy: {
      deterministicRuleset: 'sof-response-rules-v1',
      webFetchTools: ['example.fetch'],
      ...overrides,
    },
    compiledPolicyDigest: digest('compiled policy'),
  };
}

function projection(text: string): ResultProjectionV1 {
  const projected = projectCallToolResult({ content: [{ type: 'text', text }] });
  if (!projected.ok) throw new Error(projected.reason);
  return projected.projection;
}

function input(
  verifiedPolicy: VerifiedCompiledResponsePolicyFormat2,
  projected: ResultProjectionV1,
  scanner?: CheckResultV2Input['scanner'],
): CheckResultV2Input {
  const trustedBindings = {
    executionId: '0123456789abcdef0123456789abcdef',
    authorizationBinding: digest('authorization'),
    requestIdDigest: digest('request id'),
    requestDigest: digest('request'),
    resultDigest: digest('result'),
    projectionDigest: projected.digest,
  };
  return {
    verifiedPolicy,
    trustedBindings,
    authorizationBinding: trustedBindings.authorizationBinding,
    executionId: trustedBindings.executionId,
    requestIdDigest: trustedBindings.requestIdDigest,
    requestDigest: trustedBindings.requestDigest,
    resultDigest: trustedBindings.resultDigest,
    contentType: CALL_TOOL_RESULT_CONTENT_TYPE,
    idempotencyKey: 'result:once',
    tool: 'example.fetch',
    tenantId: 'tenant-1',
    taskId: 'task-1',
    policyHash: digest('policy'),
    projection: projected,
    nowUnixSeconds: 1_800_000_010,
    ...(scanner ? { scanner } : {}),
  };
}

function finding(projected: ResultProjectionV1, text: string, className = 'pii') {
  const record = projected.records[0];
  if (!record) throw new Error('missing projection record');
  const charStart = record.value.indexOf(text);
  if (charStart < 0) throw new Error('missing finding text');
  const start = record.start + Buffer.byteLength(record.value.slice(0, charStart));
  const end = start + Buffer.byteLength(text);
  return {
    class: className,
    confidence: '0.95',
    start,
    end,
    evidenceDigest: digest(projected.bytes.subarray(start, end)),
  };
}

function response(request: ScannerRequestV1, findings: unknown[], extra = {}) {
  return {
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    executionId: request.executionId,
    policyHash: request.policyHash,
    profile: request.profile,
    contentDigest: request.contentDigest,
    contentLength: request.contentLength,
    contentType: request.contentType,
    classes: request.classes,
    scannerId: 'operator-scanner-1',
    rulesetVersion: 'operator-rules-7',
    findings,
    ...extra,
  };
}

function transport(
  build: (request: ScannerRequestV1) => unknown,
): AuthenticatedScannerTransport {
  return {
    // skipcq: JS-0116 - Scanner transports are Promise-shaped by contract; async preserves the production interface in this test double.
    async scan(request) {
      const body = build(request);
      return {
        authenticated: true,
        body: body instanceof Uint8Array
          ? body
          : new TextEncoder().encode(JSON.stringify(body)),
      };
    },
  };
}

describe('Release 2 operator scanner boundary', () => {
  it('redacts deterministic spans without exposing terminal content to the scanner', async () => {
    const projected = projection('contact alice@example.test or bob@example.test');
    const scan = vi.fn();
    const decision = await checkResultV2(input(policy({
      redactClasses: ['pii'],
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, { transport: { scan } }));

    expect(decision.disposition).toBe('REDACT');
    expect(decision.reason).toBe('redaction');
    expect(decision.redactions).toHaveLength(2);
    expect(decision.redactionPlanDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.scannerEvidence).toEqual({ status: 'skipped_terminal' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('uses authenticated scanner evidence for redaction and merges overlapping spans', async () => {
    const projected = projection('token opaque-value end');
    const first = finding(projected, 'opaque-value');
    const overlapping = {
      ...first,
      class: 'secret',
      start: first.start + 1,
      evidenceDigest: digest(projected.bytes.subarray(first.start + 1, first.end)),
    };
    const decision = await checkResultV2(input(policy({
      redactClasses: ['pii', 'secret'],
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii', 'secret'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: transport((request) => response(request, [first, overlapping])),
    }));

    expect(decision.disposition).toBe('REDACT');
    expect(decision.redactions).toEqual([{
      start: first.start,
      end: first.end,
      classes: ['pii', 'secret'],
      evidenceDigests: [first.evidenceDigest, overlapping.evidenceDigest].sort(),
    }]);
    expect(decision.scannerEvidence).toMatchObject({
      status: 'verified',
      findingCount: 2,
    });

    const reversed = await checkResultV2(input(policy({
      redactClasses: ['pii', 'secret'],
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii', 'secret'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: transport((request) => response(request, [overlapping, first])),
    }));
    expect(reversed.redactions).toEqual(decision.redactions);
    expect(reversed.redactionPlanDigest).toBe(decision.redactionPlanDigest);
  });

  it('gives block precedence over redaction for qualified scanner findings', async () => {
    const projected = projection('opaque-value');
    const decision = await checkResultV2(input(policy({
      blockClasses: ['pii'],
      redactClasses: ['pii'],
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: transport((request) => response(request, [finding(projected, 'opaque-value')])),
    }));
    expect(decision).toMatchObject({ disposition: 'BLOCK', reason: 'scanner_block' });
    expect(decision.redactions).toEqual([]);
  });

  it('records observe findings without changing disposition and emits no hosted egress', async () => {
    const projected = projection('opaque-value');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: false,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
      observe: { classes: ['pii'], until: '2027-01-15T08:00:20Z' },
    }), projected, {
      transport: transport((request) => response(request, [finding(projected, 'opaque-value')])),
    }));

    expect(decision.disposition).toBe('ALLOW');
    expect(decision.observe).toMatchObject({ active: true, findingCount: 1 });
    expect(decision.findings.at(-1)).toMatchObject({ observed: true, source: 'scanner' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('rejects an observe window more than the signed skew behind enforcer time', async () => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      observe: { classes: ['pii'], until: '2027-01-15T08:00:01Z' },
    }), projected));
    expect(decision).toMatchObject({ disposition: 'ALLOW' });

    const expiredInput = input(policy({
      observe: { classes: ['pii'], until: '2027-01-15T08:00:20Z' },
    }), projected);
    expiredInput.nowUnixSeconds = 1_800_000_100;
    const expired = await checkResultV2(expiredInput);
    expect(expired).toMatchObject({ disposition: 'BLOCK', reason: 'observe_expired' });
  });

  it.each([
    ['authentication', {
      // skipcq: JS-0116 - Scanner transports are Promise-shaped by contract; async preserves the production interface in this test double.
      async scan() { return { authenticated: false as const }; },
    }],
    ['schema', transport((request) => response(request, [], { hostile: true }))],
    ['binding', transport((request) => ({ ...response(request, []), policyHash: '0'.repeat(64) }))],
    ['class', transport((request) => response(request, [{
      class: 'malicious_url', confidence: '0.9', start: 1, end: 2,
      evidenceDigest: '0'.repeat(64),
    }]))],
  ])('blocks a required scanner on %s failure', async (reason, scannerTransport) => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, { transport: scannerTransport }));
    expect(decision).toMatchObject({
      disposition: 'BLOCK',
      reason: 'scanner_failure',
      scannerEvidence: { status: 'failed', reason, required: true },
    });
  });

  it('continues deterministic evaluation when an optional scanner fails', async () => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: false,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, { transport: {
      // skipcq: JS-0116 - Scanner transports are Promise-shaped by contract; async preserves rejection behavior in this test double.
      async scan() { throw new Error('secret failure'); },
    } }));
    expect(decision).toMatchObject({
      disposition: 'ALLOW',
      scannerEvidence: { status: 'failed', reason: 'transport', required: false },
    });
    expect(JSON.stringify(decision)).not.toContain('secret failure');
  });

  it.each([
    ['proxy', new Proxy({}, { getOwnPropertyDescriptor: () => { throw new TypeError('hostile proxy'); } })],
    ['authenticated accessor', Object.defineProperty({}, 'authenticated', {
      enumerable: true,
      get: () => true,
    })],
    ['body accessor', Object.defineProperties({}, {
      authenticated: { enumerable: true, value: true },
      body: { enumerable: true, get: () => new Uint8Array() },
    })],
  ])('contains malformed scanner transport result %s', async (_label, malformed) => {
    const projected = projection('ordinary output');
    const requiredPolicy = policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    });
    const optionalPolicy = policy({
      scanner: {
        required: false,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    });
    const scanner = {
      transport: {
        scan: () => Promise.resolve(malformed as never),
      },
    };

    await expect(checkResultV2(input(requiredPolicy, projected, scanner))).resolves.toMatchObject({
      disposition: 'BLOCK',
      reason: 'scanner_failure',
      scannerEvidence: { status: 'failed', reason: 'schema', required: true },
    });
    await expect(checkResultV2(input(optionalPolicy, projected, scanner))).resolves.toMatchObject({
      disposition: 'ALLOW',
      scannerEvidence: { status: 'failed', reason: 'schema', required: false },
    });
  });

  it.each([
    ['scannerId', 'x'.repeat(129)],
    ['scannerId', 'scanner:id'],
    ['rulesetVersion', 'x'.repeat(129)],
    ['rulesetVersion', 'ruleset/version'],
  ])('rejects unbounded or non-opaque scanner identity field %s', async (field, value) => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: transport((request) => response(request, [], { [field]: value })),
    }));

    expect(decision.scannerEvidence).toEqual({ status: 'failed', reason: 'schema', required: true });
  });

  it('enforces maxFindings across deterministic and scanner findings', async () => {
    const projected = projection('contact alice@example.test');
    const scannerFinding = finding(projected, 'alice@example.test');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: transport((request) => response(
        request,
        Array.from({ length: 256 }, () => scannerFinding),
      )),
    }));

    expect(decision).toMatchObject({
      disposition: 'BLOCK',
      reason: 'scanner_failure',
      scannerEvidence: { status: 'failed', reason: 'findings_limit', required: true },
    });
    expect(decision.findings).toHaveLength(1);
  });

  it.each([
    ['confidence', (request: ScannerRequestV1, projected: ResultProjectionV1) => {
      const item = finding(projected, 'ordinary');
      return response(request, [{ ...item, confidence: '0.8500' }]);
    }],
    ['offset', (request: ScannerRequestV1, projected: ResultProjectionV1) => {
      const item = finding(projected, 'ordinary');
      return response(request, [{ ...item, end: (projected.records[0]?.end ?? item.end) + 1 }]);
    }],
    ['evidence_digest', (request: ScannerRequestV1, projected: ResultProjectionV1) => {
      const item = finding(projected, 'ordinary');
      return response(request, [{ ...item, evidenceDigest: '0'.repeat(64) }]);
    }],
  ])('rejects hostile %s findings', async (reason, build) => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, { transport: transport((request) => build(request, projected)) }));
    expect(decision.scannerEvidence).toEqual({ status: 'failed', reason, required: true });
  });

  it('enforces response size, finding count, and deadline bounds', async () => {
    const projected = projection('ordinary output');
    const required = policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    });
    const oversized = await checkResultV2(input(required, projected, {
      transport: transport(() => new Uint8Array(1_048_577)),
    }));
    expect(oversized.scannerEvidence).toEqual({ status: 'failed', reason: 'oversize', required: true });

    const excessive = await checkResultV2(input(required, projected, {
      transport: transport((request) => response(request, Array.from({ length: 257 }, () => ({})))),
    }));
    expect(excessive.scannerEvidence).toEqual({ status: 'failed', reason: 'findings_limit', required: true });

    const deadline = await checkResultV2(input(required, projected, {
      deadlineMs: 1,
      transport: {
        // skipcq: JS-0116 - Scanner transports are Promise-shaped by contract; this callback deliberately returns a pending Promise.
        scan: async (_request, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      },
    }));
    expect(deadline.scannerEvidence).toEqual({ status: 'failed', reason: 'deadline', required: true });

    const lateResponse = await checkResultV2(input(required, projected, {
      deadlineMs: 1,
      transport: transport((request) => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 3) {
          // Force a response that resolves before the timer callback but after the deadline.
        }
        return response(request, []);
      }),
    }));
    expect(lateResponse.scannerEvidence).toEqual({
      status: 'failed', reason: 'deadline', required: true,
    });
  });

  it('binds the exact local bytes and rejects transport mutation', async () => {
    const projected = projection('ordinary output');
    const decision = await checkResultV2(input(policy({
      scanner: {
        required: true,
        profile: 'operator-presidio-v1',
        classes: ['pii'],
        minConfidence: 0.85,
      },
    }), projected, {
      transport: {
        // skipcq: JS-0116 - Scanner transports are Promise-shaped by contract; async preserves the production interface in this test double.
        async scan(request) {
          request.content[0] = (request.content[0] ?? 0) ^ 0xff;
          return {
            authenticated: true,
            body: new TextEncoder().encode(JSON.stringify(response(request, []))),
          };
        },
      },
    }));
    expect(decision.scannerEvidence).toEqual({ status: 'failed', reason: 'schema', required: true });
  });

  it('fails closed on hostile format-2 policy schema drift', async () => {
    const projected = projection('ordinary output');
    const hostile = {
      ...policy(),
      policy: { ...policy().policy, endpoint: 'https://scanner.invalid' },
    } as unknown as VerifiedCompiledResponsePolicyFormat2;
    const decision = await checkResultV2(input(hostile, projected));
    expect(decision).toMatchObject({ disposition: 'BLOCK', reason: 'envelope_invalid' });
  });

  it('fails closed without invoking malformed V2 input accessors', async () => {
    const projected = projection('ordinary output');
    const validInput = input(policy(), projected);
    let getterCalls = 0;
    const accessorPolicy = { ...validInput } as Record<string, unknown>;
    Object.defineProperty(accessorPolicy, 'verifiedPolicy', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return validInput.verifiedPolicy;
      },
    });
    const accessorNow = { ...validInput } as Record<string, unknown>;
    Object.defineProperty(accessorNow, 'nowUnixSeconds', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return validInput.nowUnixSeconds;
      },
    });
    const hostileProxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        throw new TypeError('hostile proxy');
      },
    });

    for (const malformed of [null, hostileProxy, accessorPolicy, accessorNow]) {
      const decision = await checkResultV2(malformed as unknown as CheckResultV2Input);
      expect(decision).toMatchObject({ disposition: 'BLOCK', reason: 'envelope_invalid' });
    }
    expect(getterCalls).toBe(0);
  });
});
