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
  executionId: string;
  authorizationBinding: string;
  requestIdDigest: string;
  requestDigest: string;
  resultDigest: string;
  projectionDigest: string;
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
  const verifiedPolicy = ownDataValue(candidate, 'verifiedPolicy');
  const projection = ownDataValue(candidate, 'projection');
  const policy = isRecord(verifiedPolicy)
    ? verifiedPolicy
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
    compiledPolicyDigest: closedHex(
      policy === undefined ? undefined : ownDataValue(policy, 'compiledPolicyDigest'),
      HEX_64,
      64,
    ),
    authorizationBinding: closedHex(candidate['authorizationBinding'], HEX_64, 64),
    requestDigest: closedHex(candidate['requestDigest'], HEX_64, 64),
    resultDigest: closedHex(candidate['resultDigest'], HEX_64, 64),
    projectionDigest: closedHex(
      isRecord(projection) ? ownDataValue(projection, 'digest') : undefined,
      HEX_64,
      64,
    ),
    contentType: CALL_TOOL_RESULT_CONTENT_TYPE,
    disposition: 'BLOCK',
    reason: 'envelope_invalid',
    findings: [],
  };
}

const CHECK_RESULT_INPUT_KEYS = [
  'verifiedPolicy',
  'trustedBindings',
  'authorizationBinding',
  'executionId',
  'requestIdDigest',
  'requestDigest',
  'resultDigest',
  'contentType',
  'idempotencyKey',
  'tool',
  'tenantId',
  'taskId',
  'policyHash',
  'projection',
  'nowUnixSeconds',
] as const;

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError(`Accessor-backed checkResult field: ${key}`);
  }
  return descriptor.value;
}

function readCheckResultInput(input: unknown): CheckResultInput {
  if (!isRecord(input)) throw new TypeError('checkResult input must be an object.');
  const checked: Record<string, unknown> = {};
  for (const key of CHECK_RESULT_INPUT_KEYS) {
    const value = ownDataValue(input, key);
    if (value !== undefined || Object.hasOwn(input, key)) checked[key] = value;
  }
  return checked as unknown as CheckResultInput;
}

interface JoinedTextRecord {
  record: ResultProjectionV1['records'][number];
  charStart: number;
  charEnd: number;
}

const MODEL_VISIBLE_TEXT_PATH = /^(?:\/content\/\d+\/(?:text|resource\/text|uri|name|title|description)|\/structuredContent)$/;

function locateJoinedRecord(
  records: readonly JoinedTextRecord[],
  charOffset: number,
  endOffset: boolean,
): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const boundary = records[middle]?.charEnd ?? 0;
    if (endOffset ? boundary >= charOffset : boundary > charOffset) high = middle;
    else low = middle + 1;
  }
  return low;
}

function findJoinedTextByteMatches(
  projection: ResultProjectionV1,
  pattern: RegExp,
  responseClass: ResponseClass,
  ruleId: string,
  limit: number,
): ResponseFinding[] {
  const findings: ResponseFinding[] = [];
  const group: JoinedTextRecord[] = [];
  const joinedParts: string[] = [];
  let joinedLength = 0;

  const scanGroup = (): boolean => {
    if (group.length < 2) return false;
    const joined = joinedParts.join('');
    pattern.lastIndex = 0;
    for (const match of joined.matchAll(pattern)) {
      const text = match[0];
      const charIndex = match.index;
      if (text === '' || charIndex === undefined) continue;
      const startIndex = locateJoinedRecord(group, charIndex, false);
      const endIndex = locateJoinedRecord(group, charIndex + text.length, true);
      if (startIndex === endIndex || startIndex >= group.length || endIndex >= group.length) continue;
      const startRecord = group[startIndex];
      const endRecord = group[endIndex];
      if (startRecord === undefined || endRecord === undefined) continue;
      const matchEnd = charIndex + text.length;
      for (let recordIndex = startIndex; recordIndex <= endIndex; recordIndex += 1) {
        const joinedRecord = group[recordIndex];
        if (joinedRecord === undefined) continue;
        const fragmentStart = Math.max(charIndex, joinedRecord.charStart) - joinedRecord.charStart;
        const fragmentEnd = Math.min(matchEnd, joinedRecord.charEnd) - joinedRecord.charStart;
        if (fragmentStart >= fragmentEnd) continue;
        const fragment = joinedRecord.record.value.slice(fragmentStart, fragmentEnd);
        const start = joinedRecord.record.start + Buffer.byteLength(
          joinedRecord.record.value.slice(0, fragmentStart),
          'utf8',
        );
        const end = start + Buffer.byteLength(fragment, 'utf8');
        findings.push({
          class: responseClass,
          start,
          end,
          evidenceDigest: createHash('sha256').update(fragment, 'utf8').digest('hex'),
          rulesetVersion: 'sof-response-rules-v1',
          ruleId,
        });
        if (findings.length >= limit) return true;
      }
    }
    return false;
  };

  for (const record of projection.records) {
    if (!MODEL_VISIBLE_TEXT_PATH.test(record.path)) continue;
    const charStart = joinedLength;
    joinedParts.push(record.value);
    joinedLength += record.value.length;
    group.push({ record, charStart, charEnd: joinedLength });
  }
  scanGroup();
  return findings;
}

function findByteMatches(
  projection: ResultProjectionV1,
  pattern: RegExp,
  responseClass: ResponseClass,
  ruleId: string,
  limit: number,
): ResponseFinding[] {
  const findings: ResponseFinding[] = [];
  for (const record of projection.records) {
    pattern.lastIndex = 0;
    let previousCharIndex = 0;
    let previousByteOffset = record.start;
    for (const match of record.value.matchAll(pattern)) {
      const text = match[0];
      const charIndex = match.index;
      if (text === '' || charIndex === undefined) continue;
      const start = previousByteOffset + Buffer.byteLength(
        record.value.slice(previousCharIndex, charIndex),
        'utf8',
      );
      const end = start + Buffer.byteLength(text, 'utf8');
      findings.push({
        class: responseClass,
        start,
        end,
        evidenceDigest: createHash('sha256').update(text, 'utf8').digest('hex'),
        rulesetVersion: 'sof-response-rules-v1',
        ruleId,
      });
      if (findings.length >= limit) return findings;
      previousCharIndex = charIndex;
      previousByteOffset = start;
    }
  }
  findings.push(...findJoinedTextByteMatches(
    projection,
    pattern,
    responseClass,
    ruleId,
    limit - findings.length,
  ));
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
  if (projection.bytes.byteLength > MAX_RESULT_PROJECTION_BYTES) return false;
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
const NO_VERIFIED_POLICY_OVERRIDE = Symbol('no-verified-policy-override');

function evaluateCheckResult(
  input: unknown,
  verifiedPolicyOverride: unknown | typeof NO_VERIFIED_POLICY_OVERRIDE,
): ResponseDecisionV1 {
  let decision = baseDecision({});
  try {
    const checkedInput = readCheckResultInput(input);
    if (verifiedPolicyOverride !== NO_VERIFIED_POLICY_OVERRIDE) {
      checkedInput.verifiedPolicy = verifiedPolicyOverride as VerifiedResponsePolicyV1;
    }
    decision = baseDecision(checkedInput);
    const policy = checkedInput.verifiedPolicy;
    const now = checkedInput.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
    if (!validPolicy(policy)) return Object.freeze(decision);
    if (
      !isRecord(checkedInput.trustedBindings) ||
      typeof checkedInput.trustedBindings.executionId !== 'string' ||
      !HEX_32.test(checkedInput.trustedBindings.executionId) ||
      typeof checkedInput.executionId !== 'string' ||
      !HEX_32.test(checkedInput.executionId) ||
      typeof checkedInput.requestIdDigest !== 'string' ||
      !HEX_64.test(checkedInput.requestIdDigest) ||
      typeof checkedInput.authorizationBinding !== 'string' ||
      !HEX_64.test(checkedInput.authorizationBinding) ||
      typeof checkedInput.requestDigest !== 'string' ||
      !HEX_64.test(checkedInput.requestDigest) ||
      typeof checkedInput.resultDigest !== 'string' ||
      !HEX_64.test(checkedInput.resultDigest) ||
      typeof checkedInput.policyHash !== 'string' ||
      !HEX_64.test(checkedInput.policyHash) ||
      typeof checkedInput.idempotencyKey !== 'string' ||
      checkedInput.idempotencyKey === '' ||
      typeof checkedInput.tool !== 'string' ||
      checkedInput.tool === '' ||
      typeof checkedInput.tenantId !== 'string' ||
      checkedInput.tenantId === '' ||
      typeof checkedInput.taskId !== 'string' ||
      checkedInput.taskId === '' ||
      checkedInput.contentType !== CALL_TOOL_RESULT_CONTENT_TYPE
    ) {
      decision.reason = 'binding_mismatch';
      return Object.freeze(decision);
    }
    if (
      !sameString(checkedInput.executionId, checkedInput.trustedBindings.executionId) ||
      !sameString(checkedInput.authorizationBinding, checkedInput.trustedBindings.authorizationBinding) ||
      !sameString(checkedInput.requestIdDigest, checkedInput.trustedBindings.requestIdDigest) ||
      !sameString(checkedInput.requestDigest, checkedInput.trustedBindings.requestDigest) ||
      !sameString(checkedInput.resultDigest, checkedInput.trustedBindings.resultDigest) ||
      !sameString(checkedInput.projection.digest, checkedInput.trustedBindings.projectionDigest)
    ) {
      decision.reason = 'binding_mismatch';
      return Object.freeze(decision);
    }
    if (
      !sameString(checkedInput.tenantId, policy.tenantId) ||
      !sameString(checkedInput.taskId, policy.taskId) ||
      !sameString(checkedInput.policyHash, policy.policyHash) ||
      !policy.coveredTools.some((tool) => sameString(tool, checkedInput.tool))
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
    if (!validateProjection(checkedInput.projection)) {
      decision.reason = 'evaluator_failure';
      return Object.freeze(decision);
    }

    const findings: ResponseFinding[] = [];
    for (const rule of RULES) {
      const remaining = EXPECTED_BOUNDS.maxFindings - findings.length + 1;
      findings.push(
        ...findByteMatches(checkedInput.projection, rule.pattern, rule.class, rule.id, remaining),
      );
      if (findings.length > EXPECTED_BOUNDS.maxFindings) {
        decision.reason = 'evaluator_failure';
        return Object.freeze(decision);
      }
    }
    for (const literal of policy.policy.denyStrings ?? []) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const remaining = EXPECTED_BOUNDS.maxFindings - findings.length + 1;
      findings.push(
        ...findByteMatches(
          checkedInput.projection,
          new RegExp(escaped, 'gu'),
          'prompt_injection',
          `response.deny_string:${createHash('sha256').update(literal).digest('hex')}`,
          remaining,
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

export function checkResult(input: CheckResultInput): ResponseDecisionV1 {
  return evaluateCheckResult(input, NO_VERIFIED_POLICY_OVERRIDE);
}

export function checkResultWithVerifiedPolicy(
  input: unknown,
  verifiedPolicy?: unknown,
): ResponseDecisionV1 {
  return evaluateCheckResult(input, verifiedPolicy);
}
