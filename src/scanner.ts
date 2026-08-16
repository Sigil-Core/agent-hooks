import { createHash } from 'node:crypto';
import type {
  CompiledResponsePolicyFormat1Policy,
  CompiledResponsePolicyFormat2,
  ResponsePolicyClass,
  VerifiedCompiledResponsePolicyFormat1,
  VerifiedCompiledResponsePolicyFormat2,
} from '@sigilcore/warrant-core';

import {
  checkResult,
  checkResultWithVerifiedPolicy,
  type CheckResultInput,
  type ResponseDecisionReason,
  type ResponseFinding,
} from './check-result.js';
import { readStrictJson } from './strict-json.js';

export const SCANNER_PROTOCOL_VERSION = 'sof-operator-scanner/v1' as const;

const HEX_64 = /^[0-9a-f]{64}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONFIDENCE = /^(?:0|1|0\.[0-9]{0,3}[1-9])$/;
const MAX_FINDINGS = 256;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_DEADLINE_MS = 2_000;

export interface ScannerRequestV1 {
  protocolVersion: typeof SCANNER_PROTOCOL_VERSION;
  executionId: string;
  policyHash: string;
  profile: string;
  contentDigest: string;
  contentLength: number;
  contentType: string;
  deadlineMs: number;
  classes: readonly ResponsePolicyClass[];
  /** A private copy of the bounded local projection. Never hosted by Sigil. */
  content: Uint8Array;
}

export type ScannerTransportResult =
  | { authenticated: true; body: Uint8Array }
  | { authenticated: false };

export interface AuthenticatedScannerTransport {
  scan(
    request: Readonly<ScannerRequestV1>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<ScannerTransportResult>;
}

export interface ScannerClientConfig {
  transport: AuthenticatedScannerTransport;
  /** May lower, but never raise, the signed 2,000 ms ceiling. */
  deadlineMs?: number;
}

export interface CheckResultV2Input extends Omit<CheckResultInput, 'verifiedPolicy'> {
  verifiedPolicy: VerifiedCompiledResponsePolicyFormat2;
  scanner?: ScannerClientConfig;
}

export interface ResponseFindingV2 {
  class: ResponsePolicyClass;
  start: number;
  end: number;
  evidenceDigest: string;
  source: 'deterministic' | 'scanner';
  rulesetVersion: string;
  ruleId: string;
  confidence: string | null;
  qualified: boolean;
  observed: boolean;
}

export interface ResponseRedactionSpanV1 {
  start: number;
  end: number;
  classes: readonly ResponsePolicyClass[];
  evidenceDigests: readonly string[];
}

export type ScannerFailureReason =
  | 'authentication'
  | 'deadline'
  | 'transport'
  | 'schema'
  | 'binding'
  | 'oversize'
  | 'findings_limit'
  | 'class'
  | 'confidence'
  | 'offset'
  | 'evidence_digest';

export type ScannerEvidenceV1 =
  | { status: 'not_configured' | 'skipped_terminal' }
  | { status: 'failed'; reason: ScannerFailureReason; required: boolean }
  | {
      status: 'verified';
      scannerId: string;
      rulesetVersion: string;
      responseDigest: string;
      findingCount: number;
    };

export type ResponseDecisionReasonV2 =
  | ResponseDecisionReason
  | 'scanner_failure'
  | 'scanner_block'
  | 'redaction'
  | 'observe_expired';

export interface ResponseDecisionV2 {
  schema: 'sof-response-decision/v2';
  formatVersion: 2;
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
  contentType: string;
  disposition: 'ALLOW' | 'BLOCK' | 'REDACT';
  reason: ResponseDecisionReasonV2;
  findings: readonly ResponseFindingV2[];
  redactions: readonly ResponseRedactionSpanV1[];
  redactionPlanDigest: string | null;
  scannerEvidence: ScannerEvidenceV1;
  observe: Readonly<{
    active: boolean;
    until: string | null;
    classes: readonly ResponsePolicyClass[];
    findingCount: number;
  }>;
}

interface ParsedScannerFinding {
  class: ResponsePolicyClass;
  confidence: string;
  start: number;
  end: number;
  evidenceDigest: string;
}

interface ParsedScannerResponse {
  scannerId: string;
  rulesetVersion: string;
  findings: ParsedScannerFinding[];
}

class ScannerValidationError extends Error {
  constructor(readonly reason: ScannerFailureReason) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

async function validateFormat2Policy(
  value: unknown,
): Promise<void> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('Verified format-2 response policy must be an object.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!exactKeys(value, [
    'kind', 'formatVersion', 'issuer', 'keyId', 'audience', 'scope', 'tenantId',
    'taskId', 'policyVersion', 'policyHash', 'issuedAt', 'expiresAt',
    'revocationEpoch', 'coveredTools', 'deterministicRuleset', 'classCatalog',
    'bounds', 'policy', 'compiledPolicyDigest',
  ])) {
    throw new TypeError('Verified format-2 response policy has schema drift.');
  }
  const payload: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError('Verified format-2 response policy contains an accessor.');
    }
    if (key !== 'compiledPolicyDigest') payload[key] = descriptor.value;
  }
  if (
    typeof descriptors.compiledPolicyDigest?.value !== 'string' ||
    !HEX_64.test(descriptors.compiledPolicyDigest.value)
  ) {
    throw new TypeError('Verified format-2 response policy digest is invalid.');
  }
  const warrantCore = await import('@sigilcore/warrant-core');
  const validate: (candidate: unknown) => asserts candidate is CompiledResponsePolicyFormat2 =
    warrantCore.validateCompiledResponsePolicyFormat2;
  validate(payload);
}

function asFormat1Policy(
  policy: VerifiedCompiledResponsePolicyFormat2,
): VerifiedCompiledResponsePolicyFormat1 {
  const format1Policy: CompiledResponsePolicyFormat1Policy = {
    deterministicRuleset: policy.policy.deterministicRuleset,
    ...(policy.policy.webFetchTools ? { webFetchTools: [...policy.policy.webFetchTools] } : {}),
    ...(policy.policy.httpTools ? { httpTools: [...policy.policy.httpTools] } : {}),
    ...(policy.policy.blockClasses ? { blockClasses: [...policy.policy.blockClasses] } : {}),
    ...(policy.policy.denyStrings ? { denyStrings: [...policy.policy.denyStrings] } : {}),
  };
  return {
    ...policy,
    formatVersion: 1,
    policyVersion: '2.2.0',
    policy: format1Policy as CompiledResponsePolicyFormat1Policy,
  };
}

function commonInput(input: CheckResultV2Input): Omit<CheckResultInput, 'verifiedPolicy'> {
  return {
    trustedBindings: input.trustedBindings,
    authorizationBinding: input.authorizationBinding,
    executionId: input.executionId,
    requestIdDigest: input.requestIdDigest,
    requestDigest: input.requestDigest,
    resultDigest: input.resultDigest,
    contentType: input.contentType,
    idempotencyKey: input.idempotencyKey,
    tool: input.tool,
    tenantId: input.tenantId,
    taskId: input.taskId,
    policyHash: input.policyHash,
    projection: input.projection,
    ...(input.nowUnixSeconds === undefined ? {} : { nowUnixSeconds: input.nowUnixSeconds }),
  };
}

const CHECK_RESULT_V2_INPUT_KEYS = [
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
  'scanner',
] as const;

function readCheckResultV2Input(input: unknown): CheckResultV2Input {
  if (!isRecord(input)) throw new TypeError('checkResultV2 input must be an object.');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const checked: Record<string, unknown> = {};
  for (const key of CHECK_RESULT_V2_INPUT_KEYS) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) continue;
    if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`Accessor-backed checkResultV2 field: ${key}`);
    }
    checked[key] = descriptor.value;
  }
  if (checked.scanner !== undefined) {
    if (!isRecord(checked.scanner)) throw new TypeError('checkResultV2 scanner must be an object.');
    const scannerDescriptors = Object.getOwnPropertyDescriptors(checked.scanner);
    const scanner: Record<string, unknown> = {};
    for (const key of ['transport', 'deadlineMs'] as const) {
      const descriptor = scannerDescriptors[key];
      if (descriptor === undefined) continue;
      if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new TypeError(`Accessor-backed checkResultV2 scanner field: ${key}`);
      }
      scanner[key] = descriptor.value;
    }
    checked.scanner = scanner;
  }
  return checked as unknown as CheckResultV2Input;
}

function deterministicInput(input: CheckResultV2Input): CheckResultInput {
  return {
    ...commonInput(input),
    verifiedPolicy: asFormat1Policy(input.verifiedPolicy),
  };
}

function mappedFinding(
  finding: ResponseFinding,
  observeClasses: ReadonlySet<string>,
  observeActive: boolean,
): ResponseFindingV2 {
  return {
    ...finding,
    source: 'deterministic',
    confidence: null,
    qualified: true,
    observed: observeActive && observeClasses.has(finding.class),
  };
}

function mergeRedactions(findings: readonly ResponseFindingV2[]): ResponseRedactionSpanV1[] {
  const selected = findings
    .filter((finding) => finding.qualified)
    .sort((left, right) => left.start - right.start || left.end - right.end ||
      left.class.localeCompare(right.class) || left.evidenceDigest.localeCompare(right.evidenceDigest));
  const merged: Array<{
    start: number;
    end: number;
    classes: Set<ResponsePolicyClass>;
    evidenceDigests: Set<string>;
  }> = [];
  for (const finding of selected) {
    const previous = merged.at(-1);
    if (previous && finding.start <= previous.end) {
      previous.end = Math.max(previous.end, finding.end);
      previous.classes.add(finding.class);
      previous.evidenceDigests.add(finding.evidenceDigest);
    } else {
      merged.push({
        start: finding.start,
        end: finding.end,
        classes: new Set([finding.class]),
        evidenceDigests: new Set([finding.evidenceDigest]),
      });
    }
  }
  return merged.map((span) => Object.freeze({
    start: span.start,
    end: span.end,
    classes: Object.freeze([...span.classes].sort()),
    evidenceDigests: Object.freeze([...span.evidenceDigests].sort()),
  }));
}

function redactionPlanDigest(
  projectionDigest: string,
  redactions: readonly ResponseRedactionSpanV1[],
): string {
  return sha256(`SOF-REDACTION-PLAN-1\n${JSON.stringify({ projectionDigest, redactions })}`);
}

function makeDecision(
  base: ReturnType<typeof checkResult>,
  policy: VerifiedCompiledResponsePolicyFormat2,
  now: number,
): ResponseDecisionV2 {
  const observeClasses = new Set(policy.policy.observe?.classes ?? []);
  const observeUntil = policy.policy.observe?.until ?? null;
  const observeActive = observeUntil !== null && Date.parse(observeUntil) / 1000 >= now;
  return {
    ...base,
    schema: 'sof-response-decision/v2',
    formatVersion: 2,
    disposition: base.disposition,
    findings: base.findings.map((finding) => mappedFinding(finding, observeClasses, observeActive)),
    redactions: [],
    redactionPlanDigest: null,
    scannerEvidence: { status: 'not_configured' },
    observe: {
      active: observeActive,
      until: observeUntil,
      classes: Object.freeze([...observeClasses].sort()) as readonly ResponsePolicyClass[],
      findingCount: base.findings.filter((finding) => observeActive && observeClasses.has(finding.class)).length,
    },
  };
}

function invalidDecision(input: unknown): ResponseDecisionV2 {
  const base = checkResultWithVerifiedPolicy(input, {});
  return {
    ...base,
    schema: 'sof-response-decision/v2',
    formatVersion: 2,
    disposition: 'BLOCK',
    reason: 'envelope_invalid',
    findings: [],
    redactions: [],
    redactionPlanDigest: null,
    scannerEvidence: { status: 'not_configured' },
    observe: { active: false, until: null, classes: [], findingCount: 0 },
  };
}

function finalizeRedactions(
  decision: ResponseDecisionV2,
  redactClasses: ReadonlySet<string>,
): void {
  const redactions = mergeRedactions(
    decision.findings.filter((finding) => redactClasses.has(finding.class)),
  );
  if (redactions.length === 0) return;
  decision.disposition = 'REDACT';
  decision.reason = 'redaction';
  decision.redactions = Object.freeze(redactions);
  decision.redactionPlanDigest = redactionPlanDigest(decision.projectionDigest, redactions);
}

function scannerFailure(
  decision: ResponseDecisionV2,
  reason: ScannerFailureReason,
  required: boolean,
): ResponseDecisionV2 {
  decision.scannerEvidence = { status: 'failed', reason, required };
  if (required) {
    decision.disposition = 'BLOCK';
    decision.reason = 'scanner_failure';
    decision.redactions = [];
    decision.redactionPlanDigest = null;
  }
  return Object.freeze(decision);
}

function validateMappedOffset(
  input: CheckResultV2Input,
  start: number,
  end: number,
): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end) {
    return false;
  }
  const containingRecord = input.projection.records.find(
    (record) => start >= record.start && end <= record.end,
  );
  if (!containingRecord) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input.projection.bytes.subarray(start, end));
    return true;
  } catch {
    return false;
  }
}

// skipcq: JS-R1005 - Authentication, binding, bounds, and finding validation remain one ordered fail-closed scanner boundary.
function validateScannerResponse(
  input: CheckResultV2Input,
  request: ScannerRequestV1,
  raw: Uint8Array,
): ParsedScannerResponse {
  if (raw.byteLength > MAX_RESPONSE_BYTES) throw new ScannerValidationError('oversize');
  const parsed = readStrictJson(raw, { maxBytes: MAX_RESPONSE_BYTES, maxDepth: 8 });
  if (!parsed.ok) {
    throw new ScannerValidationError(parsed.error === 'oversize' ? 'oversize' : 'schema');
  }
  const value = parsed.value;
  if (!exactKeys(value, [
    'protocolVersion', 'executionId', 'policyHash', 'profile', 'contentDigest',
    'contentLength', 'contentType', 'classes', 'scannerId', 'rulesetVersion', 'findings',
  ])) {
    throw new ScannerValidationError('schema');
  }
  if (
    value.protocolVersion !== request.protocolVersion ||
    value.executionId !== request.executionId ||
    value.policyHash !== request.policyHash ||
    value.profile !== request.profile ||
    value.contentDigest !== request.contentDigest ||
    value.contentLength !== request.contentLength ||
    value.contentType !== request.contentType ||
    JSON.stringify(value.classes) !== JSON.stringify(request.classes)
  ) {
    throw new ScannerValidationError('binding');
  }
  if (
    typeof value.scannerId !== 'string' || value.scannerId === '' ||
    typeof value.rulesetVersion !== 'string' || value.rulesetVersion === '' ||
    !Array.isArray(value.findings)
  ) {
    throw new ScannerValidationError('schema');
  }
  if (value.findings.length > MAX_FINDINGS) throw new ScannerValidationError('findings_limit');
  const declaredClasses = new Set(request.classes);
  const findings: ParsedScannerFinding[] = [];
  for (const finding of value.findings) {
    if (!isRecord(finding) || !exactKeys(finding, [
      'class', 'confidence', 'start', 'end', 'evidenceDigest',
    ])) {
      throw new ScannerValidationError('schema');
    }
    if (typeof finding.class !== 'string' || !declaredClasses.has(finding.class as ResponsePolicyClass)) {
      throw new ScannerValidationError('class');
    }
    if (typeof finding.confidence !== 'string' || !CONFIDENCE.test(finding.confidence)) {
      throw new ScannerValidationError('confidence');
    }
    if (!validateMappedOffset(input, finding.start as number, finding.end as number)) {
      throw new ScannerValidationError('offset');
    }
    if (typeof finding.evidenceDigest !== 'string' || !HEX_64.test(finding.evidenceDigest)) {
      throw new ScannerValidationError('evidence_digest');
    }
    const evidence = input.projection.bytes.subarray(finding.start as number, finding.end as number);
    if (sha256(evidence) !== finding.evidenceDigest) {
      throw new ScannerValidationError('evidence_digest');
    }
    findings.push({
      class: finding.class as ResponsePolicyClass,
      confidence: finding.confidence,
      start: finding.start as number,
      end: finding.end as number,
      evidenceDigest: finding.evidenceDigest,
    });
  }
  return {
    scannerId: value.scannerId,
    rulesetVersion: value.rulesetVersion,
    findings,
  };
}

async function invokeScanner(
  config: ScannerClientConfig,
  request: ScannerRequestV1,
): Promise<ScannerTransportResult> {
  const controller = new AbortController();
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      config.transport.scan(Object.freeze(request), Object.freeze({ signal: controller.signal })),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ScannerValidationError('deadline'));
        }, request.deadlineMs);
      }),
    ]);
    if (performance.now() - startedAt > request.deadlineMs) {
      controller.abort();
      throw new ScannerValidationError('deadline');
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Evaluates a verified format-2 policy locally. The only response-byte egress is
 * the explicitly injected operator transport; this package contains no endpoint,
 * credential, network, logging, metric, trace, or hosted-receipt implementation.
 */
// skipcq: JS-R1005 - Format-2 validation, deterministic precedence, scanner handling, and redaction stay in one auditable decision pipeline.
export async function checkResultV2(input: CheckResultV2Input): Promise<ResponseDecisionV2> {
  let checkedInput: CheckResultV2Input;
  let policy: VerifiedCompiledResponsePolicyFormat2;
  try {
    checkedInput = readCheckResultV2Input(input);
    await validateFormat2Policy(checkedInput.verifiedPolicy);
    policy = checkedInput.verifiedPolicy;
  } catch {
    return Object.freeze(invalidDecision(input));
  }

  const now = checkedInput.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const base = checkResult(deterministicInput(checkedInput));
  const decision = makeDecision(base, policy, now);
  const observeUntil = policy.policy.observe?.until;
  if (observeUntil !== undefined && Date.parse(observeUntil) / 1000 < now - 30) {
    decision.disposition = 'BLOCK';
    decision.reason = 'observe_expired';
    return Object.freeze(decision);
  }
  if (base.disposition === 'BLOCK') {
    decision.scannerEvidence = { status: 'skipped_terminal' };
    return Object.freeze(decision);
  }

  const redactClasses = new Set(policy.policy.redactClasses ?? []);
  finalizeRedactions(decision, redactClasses);
  if (decision.disposition === 'REDACT') {
    decision.scannerEvidence = { status: 'skipped_terminal' };
    return Object.freeze(decision);
  }

  const scannerPolicy = policy.policy.scanner;
  if (!scannerPolicy) return Object.freeze(decision);
  const required = scannerPolicy.required;
  const deadlineMs = checkedInput.scanner?.deadlineMs ?? policy.bounds.scannerDeadlineMs;
  if (
    !checkedInput.scanner || !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 || deadlineMs > MAX_DEADLINE_MS
  ) {
    return scannerFailure(decision, 'transport', required);
  }
  if (!PROFILE.test(scannerPolicy.profile) || scannerPolicy.profile.includes('://')) {
    return scannerFailure(decision, 'schema', required);
  }
  const content = new Uint8Array(checkedInput.projection.bytes);
  const request: ScannerRequestV1 = {
    protocolVersion: SCANNER_PROTOCOL_VERSION,
    executionId: checkedInput.executionId,
    policyHash: checkedInput.policyHash,
    profile: scannerPolicy.profile,
    contentDigest: checkedInput.projection.digest,
    contentLength: content.byteLength,
    contentType: checkedInput.projection.contentType,
    deadlineMs,
    classes: Object.freeze([...scannerPolicy.classes]),
    content,
  };

  let transportResult: ScannerTransportResult;
  try {
    transportResult = await invokeScanner(checkedInput.scanner, request);
  } catch (error) {
    const reason = error instanceof ScannerValidationError ? error.reason : 'transport';
    return scannerFailure(decision, reason, required);
  }
  if (!isRecord(transportResult) || transportResult.authenticated !== true) {
    return scannerFailure(decision, 'authentication', required);
  }
  if (!(transportResult.body instanceof Uint8Array) || sha256(content) !== request.contentDigest) {
    return scannerFailure(decision, 'schema', required);
  }

  let response: ParsedScannerResponse;
  try {
    response = validateScannerResponse(checkedInput, request, transportResult.body);
  } catch (error) {
    const reason = error instanceof ScannerValidationError ? error.reason : 'schema';
    return scannerFailure(decision, reason, required);
  }
  if (decision.findings.length + response.findings.length > policy.bounds.maxFindings) {
    return scannerFailure(decision, 'findings_limit', required);
  }

  const observeClasses = new Set(policy.policy.observe?.classes ?? []);
  const observeActive = decision.observe.active;
  const scannerFindings: ResponseFindingV2[] = response.findings.map((finding, index) => ({
    ...finding,
    source: 'scanner',
    rulesetVersion: response.rulesetVersion,
    ruleId: `scanner:${response.scannerId}:${index}`,
    qualified: Number(finding.confidence) >= scannerPolicy.minConfidence,
    observed: observeActive && observeClasses.has(finding.class),
  }));
  decision.findings = Object.freeze([...decision.findings, ...scannerFindings].sort((left, right) =>
    left.start - right.start || left.end - right.end || left.class.localeCompare(right.class) ||
    left.source.localeCompare(right.source) || left.ruleId.localeCompare(right.ruleId)));
  decision.observe = Object.freeze({
    ...decision.observe,
    findingCount: decision.findings.filter((finding) => finding.observed).length,
  });
  decision.scannerEvidence = Object.freeze({
    status: 'verified',
    scannerId: response.scannerId,
    rulesetVersion: response.rulesetVersion,
    responseDigest: sha256(transportResult.body),
    findingCount: response.findings.length,
  });

  const blockClasses = new Set(policy.policy.blockClasses ?? []);
  if (scannerFindings.some((finding) => finding.qualified && blockClasses.has(finding.class))) {
    decision.disposition = 'BLOCK';
    decision.reason = 'scanner_block';
    return Object.freeze(decision);
  }
  finalizeRedactions(decision, redactClasses);
  return Object.freeze(decision);
}
