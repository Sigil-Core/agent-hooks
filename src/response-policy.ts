import type {
  CompiledResponsePolicyVerificationContext,
  CryptoAdapter,
  VerifiedCompiledResponsePolicyFormat1,
} from '@sigilcore/warrant-core';

import {
  checkResult,
  type CheckResultInput,
  type ResponseDecisionV1,
} from './check-result.js';
import type { SigilResponsePolicyAuthorization } from './types.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

const loadWarrantCoreVerifier = async () => {
  const warrantCore = await import('@sigilcore/warrant-core');
  return warrantCore.verifyCompiledResponsePolicyFormat1;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const digestHex = async (
  adapter: CryptoAdapter,
  bytes: Uint8Array,
): Promise<string> => {
  const digest = await adapter.sha256(bytes);
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new TypeError('Crypto adapter returned an invalid SHA-256 digest.');
  }
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const validateAuthorization = (
  value: unknown,
): SigilResponsePolicyAuthorization => {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError('Response-policy authorization must be an object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const read = (key: string): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError('Response-policy authorization is malformed.');
    }
    return descriptor.value;
  };
  const compactJws = read('compactJws');
  const compiledPolicyDigest = read('compiledPolicyDigest');
  const envelopeDigest = read('envelopeDigest');
  if (
    keys.length !== 3 ||
    !keys.every((key) =>
      key === 'compactJws' ||
      key === 'compiledPolicyDigest' ||
      key === 'envelopeDigest'
    ) ||
    typeof compactJws !== 'string' ||
    compactJws === '' ||
    typeof compiledPolicyDigest !== 'string' ||
    !HEX_64.test(compiledPolicyDigest) ||
    typeof envelopeDigest !== 'string' ||
    !HEX_64.test(envelopeDigest)
  ) {
    throw new TypeError('Response-policy authorization is malformed.');
  }
  return { compactJws, compiledPolicyDigest, envelopeDigest };
};

/**
 * Verifies Sign's compact Policy 2.2 envelope with exact Warrant Core 0.3.0.
 * Every trust binding comes from caller-supplied context; no envelope claim is
 * promoted into verification context. The response body remains local.
 */
export async function verifyResponsePolicyAuthorization(
  adapter: CryptoAdapter,
  authorization: SigilResponsePolicyAuthorization,
  trustedContext: CompiledResponsePolicyVerificationContext,
): Promise<VerifiedCompiledResponsePolicyFormat1> {
  const validated = validateAuthorization(authorization);
  const verifyCompiledResponsePolicyFormat1 = await loadWarrantCoreVerifier();
  const verified = await verifyCompiledResponsePolicyFormat1(
    adapter,
    validated.compactJws,
    trustedContext,
  );
  if (verified.compiledPolicyDigest !== validated.compiledPolicyDigest) {
    throw new TypeError('Compiled response-policy digest mismatch.');
  }
  const envelopeDigest = await digestHex(adapter, encoder.encode(validated.compactJws));
  if (envelopeDigest !== validated.envelopeDigest) {
    throw new TypeError('Compiled response-policy envelope digest mismatch.');
  }
  return verified;
}

export interface VerifyAndCheckResultInput {
  adapter: CryptoAdapter;
  authorization: SigilResponsePolicyAuthorization;
  trustedContext: CompiledResponsePolicyVerificationContext;
  result: Omit<CheckResultInput, 'verifiedPolicy'>;
}

/**
 * Verifies the signed policy, then evaluates a bounded local result. Any
 * verification or binding failure returns the same schema-closed BLOCK shape
 * as `checkResult`; it never falls back to the general checkIntent fail mode.
 */
export async function verifyAndCheckResult(
  input: VerifyAndCheckResultInput,
): Promise<ResponseDecisionV1> {
  try {
    const verifiedPolicy = await verifyResponsePolicyAuthorization(
      input.adapter,
      input.authorization,
      input.trustedContext,
    );
    return checkResult({ ...input.result, verifiedPolicy });
  } catch {
    const result = isRecord(input) && isRecord(input.result) ? input.result : {};
    return checkResult({
      ...result,
      verifiedPolicy: undefined,
    } as unknown as CheckResultInput);
  }
}

export type {
  CompiledResponsePolicyVerificationContext,
  CryptoAdapter,
  VerifiedCompiledResponsePolicyFormat1,
};
