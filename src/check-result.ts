import { createHash, timingSafeEqual } from 'node:crypto';
import type { VerifiedCompiledResponsePolicyFormat1 } from '@sigilcore/warrant-core';

import {
  CALL_TOOL_RESULT_CONTENT_TYPE,
  MAX_RESULT_PROJECTION_BYTES,
  RESULT_PROJECTION_VERSION,
  type ResultProjectionFailureReason,
  type ResultProjectionV1,
} from './result-projection.js';

export const RESPONSE_CLASS_CATALOG_V1_DIGEST =
  '3f77896cf5a15475c0e9847201ffaa41f4b117b4d8e5051d035f982f55d3098d' as const;
export const DETERMINISTIC_RULESET_V1_DIGEST =
  'dd07aff020e1d03e08501105dc53bb6943ffbdb50629cac7c7b4b03d1bd7ce46' as const;

const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const POLICY_22 = /^2\.2\.\d+$/;
const RESPONSE_CLASSES = new Set([
  'malicious_url',
  'pii',
  'prompt_injection',
  'secret',
]);
const ALLOWED_POLICY_KEYS = new Set([
  'deterministicRuleset',
  'webFetchTools',
  'httpTools',
  'blockClasses',
  'denyStrings',
]);
const EXPECTED_BOUNDS = Object.freeze({
  maxProjectionBytes: 16777216,
  maxNestingDepth: 16,
  maxFindings: 256,
  maxScannerResponseBytes: 1048576,
  scannerDeadlineMs: 2000,
  maxEnvelopeLifetimeSeconds: 300,
  clockSkewSeconds: 30,
  maxObserveWindowSeconds: 2592000,
});

export type ResponseClass =
  | 'malicious_url'
  | 'pii'
  | 'prompt_injection'
  | 'secret';

export type VerifiedResponsePolicyV1 = VerifiedCompiledResponsePolicyFormat1;

export interface TrustedResultBindings {
  authorizationBinding: string;
  requestIdDigest: string;
  requestDigest: string;
  resultDigest: string;
}

export interface CheckResultInput {
  verifiedPolicy: VerifiedResponsePolicyV1;
  trustedBindings: TrustedResultBindings;
  authorizationBinding: string;
  executionId: string;
  requestIdDigest: string;
  requestDigest: string;
  resultDigest: string;
  contentType: typeof CALL_TOOL_RESULT_CONTENT_TYPE;
  idempotencyKey: string;
  tool: string;
  tenantId: string;
  taskId: string;
  policyHash: string;
  projection: ResultProjectionV1;
  nowUnixSeconds?: number;
}

export type ResponseDecisionReason =
  | 'none'
  | 'deterministic_block'
  | 'response_literal'
  | ResultProjectionFailureReason
  | 'binding_mismatch'
  | 'legacy_unsupported'
  | 'envelope_invalid'
  | 'replay'
  | 'duplicate'
  | 'cancelled'
  | 'timed_out';

export interface ResponseFinding {
  class: ResponseClass;
  start: number;
  end: number;
  evidenceDigest: string;
  rulesetVersion: 'sof-response-rules-v1';
  ruleId: string;
}

export interface ResponseDecisionV1 {
  schema: 'sof-response-decision/v1';
  formatVersion: 1;
  executionId: string;
  requestIdDigest: string;
  tenantId: string;
  taskId: string;
  tool: string;
  policyHash: string;
  compiledPolicyDigest: string;
  authorizationBinding: string;
  requestDigest: string;
  resultDigest: string;
  projectionDigest: string;
  contentType: typeof CALL_TOOL_RESULT_CONTENT_TYPE;
  disposition: 'ALLOW' | 'BLOCK';
  reason: ResponseDecisionReason;
  findings: readonly ResponseFinding[];
}

interface PatternRule {
  class: ResponseClass;
  id: string;
  pattern: RegExp;
}

const RULES: readonly PatternRule[] = Object.freeze([
  {
    class: 'prompt_injection',
    id: 'prompt.ignore-previous-instructions',
    pattern: /\bignore (?:all |any )?(?:previous|prior|above) instructions?\b/giu,
  },
  {
    class: 'prompt_injection',
    id: 'prompt.reveal-system-prompt',
    pattern: /\b(?:reveal|show|print|repeat) (?:the )?(?:system|developer) (?:prompt|message|instructions?)\b/giu,
  },
  {
    class: 'secret',
    id: 'secret.private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  },
  {
    class: 'secret',
    id: 'secret.high-confidence-token',
    pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[opsu]_[A-Za-z0-9]{30,}|sk_sigil_[A-Za-z0-9_-]{16,})\b/gu,
  },
  {
    class: 'pii',
    id: 'pii.email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/giu,
  },
  {
    class: 'pii',
    id: 'pii.us-ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/gu,
  },
  {
    class: 'malicious_url',
    id: 'url.active-content-scheme',
    pattern: /\b(?:javascript|data):[^\s<>"']+/giu,
  },
  {
    class: 'malicious_url',
    id: 'url.embedded-credentials',
    pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^\s<>"']+/giu,
  },
]);

export const RESPONSE_CLASS_CATALOG_V1 = Object.freeze({
  id: 'sof-response-classes-v1' as const,
  classes: Object.freeze([
    'malicious_url',
    'pii',
    'prompt_injection',
    'secret',
  ] as const),
});

export const DETERMINISTIC_RULESET_V1 = Object.freeze({
  id: 'sof-response-rules-v1' as const,
  rules: Object.freeze(
    RULES.map((rule) =>
      Object.freeze({
        class: rule.class,
        id: rule.id,
        pattern: rule.pattern.source,
        flags: rule.pattern.flags,
      }),
    ),
  ),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function closedHex(value: unknown, pattern: RegExp, length: number): string {
  return typeof value === 'string' && pattern.test(value)
    ? value
    : '0'.repeat(length);
}

function closedLabel(value: unknown): string {
  return typeof value === 'string' && value !== '' ? value : 'invalid';
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sortedUniqueStrings(value: unknown, allowEmpty = false): value is readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'string' || value[index] === '') return false;
    if (index > 0 && (value[index - 1] as string) >= (value[index] as string)) return false;
  }
  return true;
}

function validPolicy(policy: unknown): policy is VerifiedResponsePolicyV1 {
  if (!isRecord(policy)) return false;
  const required = [
    'kind',
    'formatVersion',
    'issuer',
    'keyId',
    'audience',
    'scope',
    'tenantId',
    'taskId',
    'policyVersion',
    'policyHash',
    'issuedAt',
    'expiresAt',
    'revocationEpoch',
    'coveredTools',
    'deterministicRuleset',
    'classCatalog',
    'bounds',
    'policy',
    'compiledPolicyDigest',
  ];
  if (Object.keys(policy).length !== required.length || !required.every((key) => Object.hasOwn(policy, key))) {
    return false;
  }
  if (
    policy.kind !== 'CompiledResponsePolicy' ||
    policy.formatVersion !== 1 ||
    policy.audience !== 'sigil-agent-hooks' ||
    policy.scope !== 'mcp:result-inspect' ||
    typeof policy.issuer !== 'string' ||
    policy.issuer === '' ||
    typeof policy.keyId !== 'string' ||
    policy.keyId === '' ||
    typeof policy.tenantId !== 'string' ||
    policy.tenantId === '' ||
    typeof policy.taskId !== 'string' ||
    policy.taskId === '' ||
    typeof policy.policyVersion !== 'string' ||
    !POLICY_22.test(policy.policyVersion) ||
    typeof policy.policyHash !== 'string' ||
    !HEX_64.test(policy.policyHash) ||
    typeof policy.compiledPolicyDigest !== 'string' ||
    !HEX_64.test(policy.compiledPolicyDigest) ||
    !Number.isSafeInteger(policy.issuedAt) ||
    !Number.isSafeInteger(policy.expiresAt) ||
    !Number.isSafeInteger(policy.revocationEpoch) ||
    (policy.revocationEpoch as number) < 0 ||
    (policy.issuedAt as number) < 0 ||
    (policy.expiresAt as number) <= (policy.issuedAt as number) ||
    (policy.expiresAt as number) - (policy.issuedAt as number) > 300 ||
    !sortedUniqueStrings(policy.coveredTools)
  ) {
    return false;
  }
  if (
    !isRecord(policy.deterministicRuleset) ||
    Object.keys(policy.deterministicRuleset).length !== 2 ||
    policy.deterministicRuleset.id !== 'sof-response-rules-v1' ||
    typeof policy.deterministicRuleset.digest !== 'string' ||
    policy.deterministicRuleset.digest !== DETERMINISTIC_RULESET_V1_DIGEST ||
    !isRecord(policy.classCatalog) ||
    Object.keys(policy.classCatalog).length !== 2 ||
    policy.classCatalog.id !== 'sof-response-classes-v1' ||
    typeof policy.classCatalog.digest !== 'string' ||
    policy.classCatalog.digest !== RESPONSE_CLASS_CATALOG_V1_DIGEST
  ) {
    return false;
  }
  const bounds = policy.bounds;
  if (
    !isRecord(bounds) ||
    Object.keys(bounds).length !== Object.keys(EXPECTED_BOUNDS).length ||
    !Object.entries(EXPECTED_BOUNDS).every(([key, value]) => bounds[key] === value)
  ) {
    return false;
  }
  if (!isRecord(policy.policy) || !exactKeys(policy.policy, ALLOWED_POLICY_KEYS)) return false;
  if (policy.policy.deterministicRuleset !== 'sof-response-rules-v1') return false;
  const web = policy.policy.webFetchTools;
  const http = policy.policy.httpTools;
  if (web === undefined && http === undefined) return false;
  if (web !== undefined && !sortedUniqueStrings(web)) return false;
  if (http !== undefined && !sortedUniqueStrings(http)) return false;
  const union = [...(web ?? []), ...(http ?? [])].sort();
  if (new Set(union).size !== union.length || union.length !== policy.coveredTools.length) return false;
  const coveredTools = policy.coveredTools as readonly string[];
  if (!union.every((tool, index) => tool === coveredTools[index])) return false;
  const classes = policy.policy.blockClasses;
  if (
    classes !== undefined &&
    (!sortedUniqueStrings(classes) || !classes.every((item) => RESPONSE_CLASSES.has(item)))
  ) {
    return false;
  }
  const literals = policy.policy.denyStrings;
  if (
    literals !== undefined &&
    (!Array.isArray(literals) ||
      literals.length === 0 ||
      literals.some((item) => typeof item !== 'string' || item === '') ||
      new Set(literals).size !== literals.length)
  ) {
    return false;
  }
  return true;
}

function baseDecision(input: unknown): ResponseDecisionV1 {
  const candidate = isRecord(input) ? input : {};
  const policy = isRecord(candidate['verifiedPolicy'])
    ? candidate['verifiedPolicy']
    : undefined;
  return {
    schema: 'sof-response-decision/v1',
    formatVersion: 1,
    executionId: closedHex(candidate['executionId'], HEX_32, 32),
    requestIdDigest: closedHex(candidate['requestIdDigest'], HEX_64, 64),
    tenantId: closedLabel(candidate['tenantId']),
    taskId: closedLabel(candidate['taskId']),
    tool: closedLabel(candidate['tool']),
    policyHash: closedHex(candidate['policyHash'], HEX_64, 64),
    compiledPolicyDigest: closedHex(policy?.['compiledPolicyDigest'], HEX_64, 64),
    authorizationBinding: closedHex(candidate['authorizationBinding'], HEX_64, 64),
    requestDigest: closedHex(candidate['requestDigest'], HEX_64, 64),
    resultDigest: closedHex(candidate['resultDigest'], HEX_64, 64),
    projectionDigest: closedHex(
      isRecord(candidate['projection']) ? candidate['projection']['digest'] : undefined,
      HEX_64,
      64,
    ),
    contentType: CALL_TOOL_RESULT_CONTENT_TYPE,
    disposition: 'BLOCK',
    reason: 'envelope_invalid',
    findings: [],
  };
}

function findByteMatches(
  projection: ResultProjectionV1,
  pattern: RegExp,
  responseClass: ResponseClass,
  ruleId: string,
): ResponseFinding[] {
  const findings: ResponseFinding[] = [];
  for (const record of projection.records) {
    pattern.lastIndex = 0;
    for (const match of record.value.matchAll(pattern)) {
      const text = match[0];
      const charIndex = match.index;
      if (text === '' || charIndex === undefined) continue;
      const start = record.start + Buffer.byteLength(record.value.slice(0, charIndex), 'utf8');
      const end = start + Buffer.byteLength(text, 'utf8');
      findings.push({
        class: responseClass,
        start,
        end,
        evidenceDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
        rulesetVersion: 'sof-response-rules-v1',
        ruleId,
      });
    }
  }
  return findings;
}

function validateProjection(projection: ResultProjectionV1): boolean {
  if (
    !isRecord(projection) ||
    projection.version !== RESULT_PROJECTION_VERSION ||
    projection.contentType !== 'application/vnd.sigil.response-projection.v1' ||
    !(projection.bytes instanceof Uint8Array) ||
    !Array.isArray(projection.records) ||
    typeof projection.digest !== 'string' ||
    !HEX_64.test(projection.digest)
  ) {
    return false;
  }
  const digest = createHash('sha256').update(projection.bytes).digest('hex');
  if (!sameString(digest, projection.digest)) return false;
  const bytes = Buffer.from(projection.bytes);
  const magic = Buffer.from('SOF-RP-PROJECTION-1\n', 'ascii');
  if (
    bytes.length < magic.length + 4 ||
    !timingSafeEqual(bytes.subarray(0, magic.length), magic)
  ) {
    return false;
  }
  const recordCount = bytes.readUInt32BE(magic.length);
  if (recordCount !== projection.records.length) return false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = magic.length + 4;
  let projectedValueBytes = 0;
  for (const record of projection.records) {
    if (offset + 4 > bytes.length) return false;
    const pathLength = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + pathLength + 8 > bytes.length) return false;
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(offset, offset + pathLength));
    } catch {
      return false;
    }
    offset += pathLength;
    const valueLengthBig = bytes.readBigUInt64BE(offset);
    offset += 8;
    if (valueLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    const valueLength = Number(valueLengthBig);
    projectedValueBytes += valueLength;
    if (projectedValueBytes > MAX_RESULT_PROJECTION_BYTES) return false;
    if (offset + valueLength > bytes.length) return false;
    const start = offset;
    const end = offset + valueLength;
    let value: string;
    try {
      value = decoder.decode(bytes.subarray(start, end));
    } catch {
      return false;
    }
    if (
      record.path !== path ||
      record.value !== value ||
      record.start !== start ||
      record.end !== end
    ) {
      return false;
    }
    offset = end;
  }
  return offset === bytes.length;
}

/**
 * Evaluates a previously verified Warrant Core format-1 policy entirely in the
 * caller process. It performs no fetches and exposes no response bytes through
 * callbacks, diagnostics, logs, telemetry, or hosted receipts.
 */
export function checkResult(input: CheckResultInput): ResponseDecisionV1 {
  const decision = baseDecision(input);
  try {
    const policy = input.verifiedPolicy;
    const now = input.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    if (!validPolicy(policy)) return Object.freeze(decision);
    if (
      !isRecord(input.trustedBindings) ||
      typeof input.executionId !== 'string' ||
      !HEX_32.test(input.executionId) ||
      typeof input.requestIdDigest !== 'string' ||
      !HEX_64.test(input.requestIdDigest) ||
      typeof input.authorizationBinding !== 'string' ||
      !HEX_64.test(input.authorizationBinding) ||
      typeof input.requestDigest !== 'string' ||
      !HEX_64.test(input.requestDigest) ||
      typeof input.resultDigest !== 'string' ||
      !HEX_64.test(input.resultDigest) ||
      typeof input.policyHash !== 'string' ||
      !HEX_64.test(input.policyHash) ||
      typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey === '' ||
      typeof input.tool !== 'string' ||
      input.tool === '' ||
      typeof input.tenantId !== 'string' ||
      input.tenantId === '' ||
      typeof input.taskId !== 'string' ||
      input.taskId === '' ||
      input.contentType !== CALL_TOOL_RESULT_CONTENT_TYPE
    ) {
      decision.reason = 'binding_mismatch';
      return Object.freeze(decision);
    }
    if (
      !sameString(input.authorizationBinding, input.trustedBindings.authorizationBinding) ||
      !sameString(input.requestIdDigest, input.trustedBindings.requestIdDigest) ||
      !sameString(input.requestDigest, input.trustedBindings.requestDigest) ||
      !sameString(input.resultDigest, input.trustedBindings.resultDigest)
    ) {
      decision.reason = 'binding_mismatch';
      return Object.freeze(decision);
    }
    if (
      !sameString(input.tenantId, policy.tenantId) ||
      !sameString(input.taskId, policy.taskId) ||
      !sameString(input.policyHash, policy.policyHash) ||
      !policy.coveredTools.some((tool) => sameString(tool, input.tool))
    ) {
      decision.reason = 'binding_mismatch';
      return Object.freeze(decision);
    }
    if (
      !Number.isSafeInteger(now) ||
      policy.issuedAt > now + EXPECTED_BOUNDS.clockSkewSeconds ||
      policy.expiresAt < now - EXPECTED_BOUNDS.clockSkewSeconds
    ) {
      decision.reason = 'envelope_invalid';
      return Object.freeze(decision);
    }
    if (!validateProjection(input.projection)) {
      decision.reason = 'evaluator_failure';
      return Object.freeze(decision);
    }

    const findings: ResponseFinding[] = [];
    for (const rule of RULES) {
      findings.push(
        ...findByteMatches(input.projection, rule.pattern, rule.class, rule.id),
      );
      if (findings.length > EXPECTED_BOUNDS.maxFindings) {
        decision.reason = 'evaluator_failure';
        return Object.freeze(decision);
      }
    }
    for (const literal of policy.policy.denyStrings ?? []) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      findings.push(
        ...findByteMatches(
          input.projection,
          new RegExp(escaped, 'gu'),
          'prompt_injection',
          `response.deny_string:${createHash('sha256').update(literal).digest('hex')}`,
        ),
      );
      if (findings.length > EXPECTED_BOUNDS.maxFindings) {
        decision.reason = 'evaluator_failure';
        return Object.freeze(decision);
      }
    }
    findings.sort((left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      left.class.localeCompare(right.class) ||
      left.ruleId.localeCompare(right.ruleId),
    );
    decision.findings = Object.freeze(findings);
    const literalFinding = findings.some((finding) =>
      finding.ruleId.startsWith('response.deny_string:'),
    );
    const blockedClass = new Set(policy.policy.blockClasses ?? []);
    const deterministicBlock = findings.some((finding) => blockedClass.has(finding.class));
    if (literalFinding || deterministicBlock) {
      decision.disposition = 'BLOCK';
      decision.reason = literalFinding ? 'response_literal' : 'deterministic_block';
      return Object.freeze(decision);
    }
    decision.disposition = 'ALLOW';
    decision.reason = 'none';
    return Object.freeze(decision);
  } catch {
    decision.disposition = 'BLOCK';
    decision.reason = 'evaluator_failure';
    decision.findings = Object.freeze([]);
    return Object.freeze(decision);
  }
}
