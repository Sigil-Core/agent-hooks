import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { readStrictJson } from './strict-json.js';
import type { SigilDecision, SigilHookResult } from './types.js';

export type DecisionVerificationMode = 'warn' | 'enforce';
export type DecisionSurface = 'authorize' | 'test_run' | 'hold_resolve';
export interface DecisionJwk {
  kty: string;
  crv: string;
  kid: string;
  x: string;
  use?: string;
  key_ops?: string[];
  alg?: string;
  [key: string]: unknown;
}
export type DecisionVerificationReason =
  | 'signature'
  | 'expired'
  | 'audience'
  | 'surface'
  | 'intent_binding'
  | 'policy_binding'
  | 'nonce'
  | 'literal_mismatch'
  | 'record_missing'
  | 'key_unavailable'
  | 'attestation_missing'
  | 'attestation_mismatch'
  | 'malformed';

const verifiedAuthorizationBrand: unique symbol = Symbol('VerifiedAuthorization');
const legacyAuthorizationBrand: unique symbol = Symbol('LegacyUnverifiedAuthorization');

export interface VerifiedAuthorization {
  readonly kind: 'verified';
  readonly decision: 'ALLOWED';
  readonly intentHash: string;
  readonly policyHash: string;
  readonly [verifiedAuthorizationBrand]: true;
}

export interface LegacyUnverifiedAuthorization {
  readonly kind: 'legacy-unverified';
  readonly decision: 'ALLOWED';
  readonly [legacyAuthorizationBrand]: true;
}

export type AuthorizationCapability =
  | VerifiedAuthorization
  | LegacyUnverifiedAuthorization;

export interface AuthorizationVerificationContext {
  mode: DecisionVerificationMode;
  signOrigin: string;
  expectedPolicyHash?: string;
  txCommit: string;
  requestNonce: string;
  surface: DecisionSurface;
  pinnedJwk?: DecisionJwk;
  attestationIssuer?: string;
  nowUnixSeconds?: number;
  execution?: boolean;
}

export interface AuthorizationVerificationResult {
  decision: SigilDecision;
  authorization?: AuthorizationCapability;
  reason?: DecisionVerificationReason;
}

interface ParsedJws {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
}

interface VerifiedToken extends ParsedJws {
  kid: string;
}

const AGENT_HOOKS_VERSION = '0.10.0';
const TOKEN_MAX_BYTES = 8 * 1024;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 16;
const CLOCK_SKEW_SECONDS = 30;
const JWKS_CACHE_TTL_MS = 300_000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const cache = new Map<string, { expiresAt: number; keys: Map<string, DecisionJwk> }>();

class VerificationFailure extends Error {
  constructor(readonly reason: DecisionVerificationReason) {
    super(reason);
  }
}

export function normalizeDecisionLiteral(input: unknown): SigilDecision {
  if (input === 'APPROVED') return 'ALLOWED';
  if (input === 'ALLOWED' || input === 'DENIED' || input === 'PENDING') return input;
  throw new VerificationFailure('malformed');
}

export function authorizationPermitsExecution(result: SigilHookResult): boolean {
  const capability = result.authorization;
  if (capability === undefined || result.decision !== 'ALLOWED') return false;
  if (capability.kind === 'verified') {
    return capability[verifiedAuthorizationBrand] === true;
  }
  return capability[legacyAuthorizationBrand] === true;
}

export function isTransportFailOpenAuthorization(result: SigilHookResult): boolean {
  return result.failOpen === true &&
    result.authorization?.kind === 'legacy-unverified' &&
    result.authorization[legacyAuthorizationBrand] === true;
}

export function createTransportFailOpenAuthorization(): LegacyUnverifiedAuthorization {
  return Object.freeze({
    kind: 'legacy-unverified',
    decision: 'ALLOWED',
    [legacyAuthorizationBrand]: true as const,
  });
}

const legacyAuthorization = (): LegacyUnverifiedAuthorization =>
  createTransportFailOpenAuthorization();

const verifiedAuthorization = (
  intentHash: string,
  policyHash: string,
): VerifiedAuthorization => Object.freeze({
  kind: 'verified',
  decision: 'ALLOWED',
  intentHash,
  policyHash,
  [verifiedAuthorizationBrand]: true as const,
});

function sameString(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function strictObject(bytes: Uint8Array): Record<string, unknown> {
  const parsed = readStrictJson(bytes, { maxBytes: TOKEN_MAX_BYTES });
  if (!parsed.ok) throw new VerificationFailure('malformed');
  return parsed.value;
}

function decodeSegment(segment: string): Buffer {
  if (!BASE64URL.test(segment) || segment.includes('=')) {
    throw new VerificationFailure('malformed');
  }
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw new VerificationFailure('malformed');
  return bytes;
}

function parseCompactJws(token: unknown): ParsedJws {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > TOKEN_MAX_BYTES) {
    throw new VerificationFailure('malformed');
  }
  const segments = token.split('.');
  if (segments.length !== 3) throw new VerificationFailure('malformed');
  const [encodedHeader, encodedClaims, encodedSignature] = segments;
  if (encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined) {
    throw new VerificationFailure('malformed');
  }
  return {
    header: strictObject(decodeSegment(encodedHeader)),
    claims: strictObject(decodeSegment(encodedClaims)),
    signingInput: Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'),
    signature: decodeSegment(encodedSignature),
  };
}

function exactHeader(
  header: Record<string, unknown>,
  profile: 'decision' | 'attestation',
): string {
  const expected = profile === 'decision' ? ['alg', 'kid', 'typ'] : ['alg', 'kid'];
  const keys = Object.keys(header).sort();
  if (keys.length !== expected.length || !expected.every((key, index) => keys[index] === key)) {
    throw new VerificationFailure('malformed');
  }
  if (
    header['alg'] !== 'EdDSA' ||
    typeof header['kid'] !== 'string' ||
    header['kid'].length === 0 ||
    (profile === 'decision' && header['typ'] !== 'sof-decision+jws')
  ) {
    throw new VerificationFailure('malformed');
  }
  return header['kid'];
}

function hasUsableKeyOperations(keyOperations: unknown): boolean {
  return keyOperations === undefined || (
    Array.isArray(keyOperations) &&
    keyOperations.every((operation) => typeof operation === 'string') &&
    keyOperations.includes('verify')
  );
}

function isUsableDecisionJwk(jwk: DecisionJwk): boolean {
  const encodedPublicKey = typeof jwk.x === 'string' ? jwk.x : '';
  const decodedPublicKey = BASE64URL.test(encodedPublicKey)
    ? Buffer.from(encodedPublicKey, 'base64url')
    : undefined;
  return jwk.kty === 'OKP' &&
    jwk.crv === 'Ed25519' &&
    decodedPublicKey !== undefined &&
    decodedPublicKey.byteLength === 32 &&
    decodedPublicKey.toString('base64url') === encodedPublicKey &&
    (jwk.use === undefined || jwk.use === 'sig') &&
    (jwk.alg === undefined || jwk.alg === 'EdDSA') &&
    hasUsableKeyOperations(jwk.key_ops);
}

function readJwks(input: unknown): Map<string, DecisionJwk> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new VerificationFailure('key_unavailable');
  }
  const keys = (input as Record<string, unknown>)['keys'];
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > JWKS_MAX_KEYS) {
    throw new VerificationFailure('key_unavailable');
  }
  const selected = new Map<string, DecisionJwk>();
  const seenKids = new Set<string>();
  for (const candidate of keys) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const jwk = candidate as DecisionJwk;
    if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) continue;
    if (seenKids.has(jwk.kid)) throw new VerificationFailure('key_unavailable');
    seenKids.add(jwk.kid);
    if (!isUsableDecisionJwk(jwk)) continue;
    selected.set(jwk.kid, jwk);
  }
  if (selected.size === 0) throw new VerificationFailure('key_unavailable');
  return selected;
}

function validatePinnedJwk(jwk: DecisionJwk, kid: string): DecisionJwk {
  const keys = readJwks({ keys: [jwk] });
  const selected = keys.get(kid);
  if (selected === undefined) throw new VerificationFailure('key_unavailable');
  return selected;
}

function canonicalOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new VerificationFailure('audience');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new VerificationFailure('audience');
  }
  return url.origin;
}

async function readJwksBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new VerificationFailure('key_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    while (!complete) {
      const { done, value } = await reader.read();
      complete = done;
      if (complete) continue;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > JWKS_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw new VerificationFailure('key_unavailable');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    throw new VerificationFailure('key_unavailable');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchJwks(origin: string, force: boolean): Promise<Map<string, DecisionJwk>> {
  const existing = cache.get(origin);
  if (!force && existing !== undefined && existing.expiresAt > Date.now()) return existing.keys;
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/jwks.json`, {
      redirect: 'error',
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new VerificationFailure('key_unavailable');
  }
  if (!response.ok || response.redirected) throw new VerificationFailure('key_unavailable');
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > JWKS_MAX_BYTES) {
    throw new VerificationFailure('key_unavailable');
  }
  const bytes = await readJwksBytes(response);
  const parsed = readStrictJson(bytes, { maxBytes: JWKS_MAX_BYTES });
  if (!parsed.ok) throw new VerificationFailure('key_unavailable');
  const keys = readJwks(parsed.value);
  cache.set(origin, { expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keys });
  return keys;
}

async function resolveJwk(
  origin: string,
  kid: string,
  pinnedJwk?: DecisionJwk,
): Promise<DecisionJwk> {
  if (pinnedJwk !== undefined) return validatePinnedJwk(pinnedJwk, kid);
  let keys = await fetchJwks(origin, false);
  let selected = keys.get(kid);
  if (selected === undefined) {
    // Revision 3 intentionally permits one forced refresh per kid miss. It
    // deleted per-origin cooldown and single-flight machinery until a consumer
    // has real concurrency that justifies rebuilding those controls.
    keys = await fetchJwks(origin, true);
    selected = keys.get(kid);
  }
  if (selected === undefined) throw new VerificationFailure('key_unavailable');
  return selected;
}

async function verifyToken(
  token: unknown,
  origin: string,
  profile: 'decision' | 'attestation',
  pinnedJwk?: DecisionJwk,
): Promise<VerifiedToken> {
  const parsed = parseCompactJws(token);
  const kid = exactHeader(parsed.header, profile);
  const jwk = await resolveJwk(origin, kid, pinnedJwk);
  let valid = false;
  try {
    valid = verifySignature(
      null,
      parsed.signingInput,
      createPublicKey({
        key: jwk as import('node:crypto').JsonWebKey,
        format: 'jwk',
      }),
      parsed.signature,
    );
  } catch {
    throw new VerificationFailure('key_unavailable');
  }
  if (!valid) throw new VerificationFailure('signature');
  return { ...parsed, kid };
}

function requiredString(claims: Record<string, unknown>, name: string): string {
  const value = claims[name];
  if (typeof value !== 'string' || value.length === 0) throw new VerificationFailure('malformed');
  return value;
}

function validateTimes(claims: Record<string, unknown>, now: number): void {
  const iat = claims['iat'];
  const exp = claims['exp'];
  if (
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    (exp as number) !== (iat as number) + 60 ||
    (iat as number) > now + CLOCK_SKEW_SECONDS ||
    (exp as number) < now - CLOCK_SKEW_SECONDS
  ) {
    throw new VerificationFailure('expired');
  }
}

function validateDecisionClaims(
  token: VerifiedToken,
  context: AuthorizationVerificationContext,
  bodyDecision: SigilDecision,
  body: Record<string, unknown>,
): { decision: SigilDecision; intentHash: string; policyHash: string } {
  const { claims } = token;
  const now = context.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  validateTimes(claims, now);
  if (
    requiredString(claims, 'iss') !== context.signOrigin ||
    requiredString(claims, 'aud') !== context.signOrigin
  ) throw new VerificationFailure('audience');
  if (claims['surface'] !== context.surface) throw new VerificationFailure('surface');
  const decision = normalizeDecisionLiteral(claims['decision']);
  if (decision !== claims['decision']) throw new VerificationFailure('malformed');
  if (decision !== bodyDecision) throw new VerificationFailure('literal_mismatch');
  const expectedIntentHash = createHash('sha256').update(context.txCommit).digest('hex');
  const intentHash = requiredString(claims, 'intentHash');
  if (!HEX_64.test(intentHash) || !sameString(intentHash, expectedIntentHash)) {
    throw new VerificationFailure('intent_binding');
  }
  const policyHash = requiredString(claims, 'policyHash');
  if (!HEX_64.test(policyHash)) throw new VerificationFailure('policy_binding');
  if (
    context.expectedPolicyHash === undefined ||
    !sameString(policyHash, context.expectedPolicyHash)
  ) throw new VerificationFailure('policy_binding');
  if (claims['requestNonce'] !== context.requestNonce) throw new VerificationFailure('nonce');
  if (context.surface === 'test_run' && claims['test_run'] !== true) {
    throw new VerificationFailure('surface');
  }
  if (bodyDecision === 'PENDING') {
    const bodyHoldId = body['hold_id'] ?? body['holdId'];
    if (
      typeof bodyHoldId !== 'string' ||
      typeof claims['holdId'] !== 'string' ||
      !sameString(bodyHoldId, claims['holdId'])
    ) throw new VerificationFailure('surface');
  }
  if (
    context.surface === 'hold_resolve' &&
    (typeof claims['holdId'] !== 'string' || !Number.isSafeInteger(claims['resolvedAt']))
  ) {
    throw new VerificationFailure('surface');
  }
  return { decision, intentHash, policyHash };
}

function validateAttestationClaims(
  token: VerifiedToken,
  record: VerifiedToken,
  recordClaims: { intentHash: string; policyHash: string },
  context: AuthorizationVerificationContext,
): void {
  const { claims } = token;
  validateTimes(claims, context.nowUnixSeconds ?? Math.floor(Date.now() / 1000));
  if (
    claims['iss'] !== (context.attestationIssuer ?? 'sigil-core') ||
    claims['aud'] !== 'sigil-sign'
  ) throw new VerificationFailure('audience');
  if (
    claims['decision'] !== 'ALLOWED' ||
    claims['intentHash'] !== recordClaims.intentHash ||
    claims['policyHash'] !== recordClaims.policyHash ||
    claims['kid'] !== token.kid ||
    token.kid !== record.kid
  ) throw new VerificationFailure('attestation_mismatch');
}

function warnFallback(
  decision: SigilDecision,
  reason: DecisionVerificationReason,
): AuthorizationVerificationResult {
  // Verification degradation is not transport unreachability. This legacy
  // rollout capability must never carry the transport-only fail-open brand.
  return {
    decision,
    ...(decision === 'ALLOWED' ? { authorization: legacyAuthorization() } : {}),
    reason,
  };
}

export async function verifyAuthorizationResponse(
  body: Record<string, unknown>,
  context: AuthorizationVerificationContext,
): Promise<AuthorizationVerificationResult> {
  let bodyDecision: SigilDecision;
  try {
    bodyDecision = normalizeDecisionLiteral(body['status']);
  } catch {
    return { decision: 'DENIED', reason: 'malformed' };
  }
  if (context.mode === 'enforce' && context.expectedPolicyHash === undefined) {
    return { decision: 'DENIED', reason: 'policy_binding' };
  }
  if (body['decision_record'] === undefined) {
    return context.mode === 'warn'
      ? warnFallback(bodyDecision, 'record_missing')
      : { decision: bodyDecision === 'PENDING' ? 'PENDING' : 'DENIED', reason: 'record_missing' };
  }
  try {
    const origin = canonicalOrigin(context.signOrigin);
    const record = await verifyToken(body['decision_record'], origin, 'decision', context.pinnedJwk);
    const recordClaims = validateDecisionClaims(
      record,
      { ...context, signOrigin: origin },
      bodyDecision,
      body,
    );
    if (bodyDecision !== 'ALLOWED' || context.execution === false) return { decision: bodyDecision };
    const attestationValue = body['intent_attestation'] ?? body['intentAttestation'];
    if (attestationValue === undefined || attestationValue === null) {
      throw new VerificationFailure('attestation_missing');
    }
    const attestation = await verifyToken(attestationValue, origin, 'attestation', context.pinnedJwk);
    validateAttestationClaims(attestation, record, recordClaims, context);
    return {
      decision: 'ALLOWED',
      authorization: verifiedAuthorization(recordClaims.intentHash, recordClaims.policyHash),
    };
  } catch (error) {
    const reason = error instanceof VerificationFailure ? error.reason : 'malformed';
    return context.mode === 'warn'
      ? warnFallback(bodyDecision, reason)
      : { decision: bodyDecision === 'PENDING' ? 'PENDING' : 'DENIED', reason };
  }
}

export function logDecisionVerification(
  reason: DecisionVerificationReason,
  mode: DecisionVerificationMode,
  surface: DecisionSurface,
): void {
  console.warn(JSON.stringify({
    level: 'warn',
    event: 'decision.verification_failed',
    reason,
    mode,
    consumer_version: AGENT_HOOKS_VERSION,
    surface,
  }));
}

export function clearDecisionKeyCacheForTests(): void {
  const runtimeProcess = typeof process === 'undefined' ? undefined : process;
  if (runtimeProcess?.env['NODE_ENV'] !== 'test') {
    throw new Error('Decision key cache reset is test-only');
  }
  cache.clear();
}
