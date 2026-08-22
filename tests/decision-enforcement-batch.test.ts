import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDecisionKeyCacheForTests,
  verifyAuthorizationResponse,
  type AuthorizationVerificationContext,
  type DecisionJwk,
  type DecisionVerificationReason,
} from '../src/decision.js';

interface BatchVector {
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
    reason?: DecisionVerificationReason;
    enforceDecision?: string;
  };
}

interface BatchFixture {
  publicJwk: DecisionJwk;
  rotationPublicJwk: DecisionJwk;
  context: Omit<AuthorizationVerificationContext, 'mode'>;
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
  vectors: BatchVector[];
}

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/contract-fixtures/v1/decision-records.json'),
  'utf8',
)) as BatchFixture;

const bodyFor = (vector: BatchVector): Record<string, unknown> => ({
  status: vector.status,
  ...(vector.decisionRecord === null
    ? {}
    : { decision_record: fixture.tokens[vector.decisionRecord] }),
  ...(vector.attestation === null
    ? {}
    : { intent_attestation: fixture.tokens[vector.attestation] }),
  ...(vector.status === 'PENDING' ? { hold_id: 'hold-fixture-1' } : {}),
});

const contextFor = (
  vector: BatchVector,
): AuthorizationVerificationContext => ({
  ...fixture.context,
  mode: 'enforce',
  surface: vector.surface ?? 'authorize',
  execution: vector.execution ?? true,
  pinnedJwk: vector.keySet === 'rotation_overlap' ? undefined : fixture.publicJwk,
});

const mutateCompactJws = (
  token: string,
  mutation: BatchFixture['malformedJoseVectors'][number]['mutation'],
): string => {
  const [header, payload, signature] = token.split('.');
  switch (mutation) {
    case 'append_segment': return `${token}.extra`;
    case 'pad_header': return `${header}=.${payload}.${signature}`;
    case 'invalid_header_character': return `!${token.slice(1)}`;
    case 'oversize': return `${token}${'x'.repeat(8 * 1024)}`;
    case 'extra_header': {
      const mutatedHeader = Buffer.from(JSON.stringify({
        alg: 'EdDSA',
        kid: fixture.publicJwk.kid,
        typ: 'sof-decision+jws',
        crit: ['b64'],
      })).toString('base64url');
      return `${mutatedHeader}.${payload}.${signature}`;
    }
    case 'duplicate_header': {
      const mutatedHeader = Buffer.from(
        `{"alg":"EdDSA","alg":"none","kid":"${fixture.publicJwk.kid}","typ":"sof-decision+jws"}`,
      ).toString('base64url');
      return `${mutatedHeader}.${payload}.${signature}`;
    }
  }
};

afterEach(() => {
  vi.restoreAllMocks();
  clearDecisionKeyCacheForTests();
});

describe('Wave 3 deterministic enforcement batch', () => {
  it('runs 29 cases with three required zero-failure counters', async () => {
    let unexpectedVerificationFailures = 0;
    let tamperAccepts = 0;
    let legacyPathFallbacks = 0;
    let reasonCodeMismatches = 0;
    let negativeDecisionMismatches = 0;
    let validCases = 0;
    let negativeCases = 0;

    for (const vector of fixture.vectors) {
      clearDecisionKeyCacheForTests();
      if (vector.keySet === 'rotation_overlap') {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
          keys: [fixture.publicJwk, fixture.rotationPublicJwk],
        }), { status: 200 }));
      }
      const result = await verifyAuthorizationResponse(bodyFor(vector), contextFor(vector));
      const expectedDecision = vector.expected.decision ?? vector.expected.enforceDecision;
      const isValid = vector.expected.reason === undefined;
      if (isValid) {
        validCases += 1;
        if (
          result.decision !== expectedDecision ||
          result.reason !== undefined ||
          result.authorization?.kind !== vector.expected.capability
        ) unexpectedVerificationFailures += 1;
      } else {
        negativeCases += 1;
        if (result.decision === 'ALLOWED' || result.authorization !== undefined) tamperAccepts += 1;
        if (result.reason !== vector.expected.reason) reasonCodeMismatches += 1;
        if (result.decision !== expectedDecision) negativeDecisionMismatches += 1;
      }
      if (result.authorization?.kind === 'legacy-unverified') legacyPathFallbacks += 1;
      vi.restoreAllMocks();
    }

    const validVector = fixture.vectors.find((vector) => vector.id === 'valid_allowed');
    if (validVector === undefined) throw new Error('valid_allowed fixture is missing');
    for (const malformed of fixture.malformedJoseVectors) {
      clearDecisionKeyCacheForTests();
      const body = bodyFor(validVector);
      const sourceToken = fixture.tokens[malformed.source];
      if (sourceToken === undefined) {
        throw new Error(`${malformed.source} malformed-JOSE source token is missing`);
      }
      body['decision_record'] = mutateCompactJws(
        sourceToken,
        malformed.mutation,
      );
      const result = await verifyAuthorizationResponse(body, contextFor(validVector));
      negativeCases += 1;
      if (result.decision === 'ALLOWED' || result.authorization !== undefined) tamperAccepts += 1;
      if (result.reason !== 'malformed') reasonCodeMismatches += 1;
      if (result.decision !== 'DENIED') negativeDecisionMismatches += 1;
      if (result.authorization?.kind === 'legacy-unverified') legacyPathFallbacks += 1;
    }

    const receipt = {
      schema: 'sigil-agent-hooks-enforcement-batch/v1',
      consumerVersion: '0.10.0',
      mode: 'enforce',
      totalCases: validCases + negativeCases,
      validCases,
      negativeCases,
      unexpectedVerificationFailures,
      tamperAccepts,
      legacyPathFallbacks,
      reasonCodeMismatches,
      negativeDecisionMismatches,
    };
    console.info(JSON.stringify(receipt));
    expect(receipt).toEqual({
      schema: 'sigil-agent-hooks-enforcement-batch/v1',
      consumerVersion: '0.10.0',
      mode: 'enforce',
      totalCases: 29,
      validCases: 7,
      negativeCases: 22,
      unexpectedVerificationFailures: 0,
      tamperAccepts: 0,
      legacyPathFallbacks: 0,
      reasonCodeMismatches: 0,
      negativeDecisionMismatches: 0,
    });
  });
});
