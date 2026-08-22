import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDecisionKeyCacheForTests,
  verifyAuthorizationResponse,
  type AuthorizationVerificationContext,
  type DecisionJwk,
} from '../src/decision.js';

interface DrillVector {
  id: string;
  status: string;
  decisionRecord: string | null;
  attestation: string | null;
  execution?: boolean;
}

interface DrillFixture {
  publicJwk: DecisionJwk;
  rotationPublicJwk: DecisionJwk;
  context: Omit<AuthorizationVerificationContext, 'mode'>;
  tokens: Record<string, string>;
  vectors: DrillVector[];
}

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/contract-fixtures/v1/decision-records.json'),
  'utf8',
)) as DrillFixture;

const vector = (id: string): DrillVector => {
  const found = fixture.vectors.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`${id} fixture is missing`);
  return found;
};

const bodyFor = (input: DrillVector): Record<string, unknown> => ({
  status: input.status,
  ...(input.decisionRecord === null
    ? {}
    : { decision_record: fixture.tokens[input.decisionRecord] }),
  ...(input.attestation === null
    ? {}
    : { intent_attestation: fixture.tokens[input.attestation] }),
});

const context = (
  overrides: Partial<AuthorizationVerificationContext> = {},
): AuthorizationVerificationContext => ({
  ...fixture.context,
  mode: 'enforce',
  execution: true,
  pinnedJwk: fixture.publicJwk,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  clearDecisionKeyCacheForTests();
});

describe('Wave 3 pre-enforcement drills', () => {
  it.each([
    ['future edge +30s', 1_999_999_970, true],
    ['future edge +31s', 1_999_999_969, false],
    ['expiry edge -30s', 2_000_000_090, true],
    ['expiry edge -31s', 2_000_000_091, false],
  ] as const)('clock-skew drill: %s', async (_label, nowUnixSeconds, accepted) => {
    const result = await verifyAuthorizationResponse(
      bodyFor(vector('valid_allowed')),
      context({ nowUnixSeconds }),
    );
    if (accepted) {
      expect(result).toMatchObject({
        decision: 'ALLOWED',
        authorization: { kind: 'verified' },
      });
      expect(result.reason).toBeUndefined();
    } else {
      expect(result).toEqual({ decision: 'DENIED', reason: 'expired' });
    }
  });

  it('cold-cache JWKS outage drill denies with key_unavailable and does not crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('simulated JWKS outage'));
    const result = await verifyAuthorizationResponse(
      bodyFor(vector('valid_allowed')),
      context({ pinnedJwk: undefined }),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('rotation-overlap drill verifies both live kids from one fetched JWKS', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      keys: [fixture.publicJwk, fixture.rotationPublicJwk],
    }), { status: 200 }));
    const first = await verifyAuthorizationResponse(
      bodyFor(vector('valid_allowed')),
      context({ pinnedJwk: undefined }),
    );
    const secondVector = vector('valid_rotation_overlap');
    const second = await verifyAuthorizationResponse(
      bodyFor(secondVector),
      context({ pinnedJwk: undefined, execution: secondVector.execution ?? false }),
    );
    expect(first).toMatchObject({ decision: 'ALLOWED', authorization: { kind: 'verified' } });
    expect(second).toEqual({ decision: 'ALLOWED' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('oversize drill rejects both a compact token and a JWKS document', async () => {
    const allowedBody = bodyFor(vector('valid_allowed'));
    allowedBody['decision_record'] = `${String(allowedBody['decision_record'])}${'x'.repeat(8 * 1024)}`;
    await expect(verifyAuthorizationResponse(allowedBody, context()))
      .resolves.toEqual({ decision: 'DENIED', reason: 'malformed' });

    clearDecisionKeyCacheForTests();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ keys: [], padding: 'x'.repeat(65 * 1024) }),
      { status: 200 },
    ));
    await expect(verifyAuthorizationResponse(
      bodyFor(vector('valid_allowed')),
      context({ pinnedJwk: undefined }),
    )).resolves.toEqual({ decision: 'DENIED', reason: 'key_unavailable' });
  });

  it('tamper drill rejects a signature change without a legacy fallback', async () => {
    const result = await verifyAuthorizationResponse(
      bodyFor(vector('tampered_signature')),
      context(),
    );
    expect(result).toEqual({ decision: 'DENIED', reason: 'signature' });
  });
});
