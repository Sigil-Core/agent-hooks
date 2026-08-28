// src/interceptor.ts
import {
  SIGIL_CLIENT_HEADER,
  SIGIL_SERVICE_COMMIT_HEADER,
  resolveClientIdentifier,
} from './client-identifier.js';
import {
  createTransportFailOpenAuthorization,
  logDecisionVerification,
  normalizeDecisionLiteral,
  verifyAuthorizationResponse,
  type AuthorizationVerificationContext,
} from './decision.js';
import { buildAuthorizeRequestBody, resolveTaskId } from './request.js';
import { readStrictJson } from './strict-json.js';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';
import {
  SIGIL_LIMIT_STORE_UNAVAILABLE,
  SIGIL_LOOP_LIMIT_EXCEEDED,
  SIGIL_RATE_LIMITED,
  SIGIL_RESPONSE_INVALID,
  SIGIL_UNREACHABLE,
} from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';
const DEFAULT_DECISION_VERIFICATION_MODE = 'enforce' as const;

/** strictResponse mode: response body cap in UTF-8 bytes (64 KiB). */
const STRICT_RESPONSE_BODY_CAP_BYTES = 64 * 1024;
/** strictResponse mode: body-read deadline, so a body that streams slowly forever still denies fast. */
const STRICT_RESPONSE_BODY_DEADLINE_MS = 1500;

type AuthorizationHttpResult =
  | { data: Record<string, unknown>; serviceCommit?: string }
  | { result: SigilHookResult; serviceCommit?: string };

interface AuthorizationRequestResult {
  response: AuthorizationHttpResult;
  verificationContext: AuthorizationVerificationContext;
}

const authenticationFailure = (status: number): SigilHookResult => ({
  decision: 'DENIED',
  errorCode: 'SIGIL_AUTH_FAILURE',
  message: `Authentication failed (${status})`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Reads Sign's build commit off a reached response. Observability only: the
 * value is untrusted response metadata echoed back for support triage. It is
 * never validated, never parsed, and never consulted for authorization, rate
 * limiting, policy selection, retries, or trust, so reading it cannot change a
 * decision. A missing or empty header is simply absent.
 */
const readServiceCommit = (response: Response): string | undefined => {
  const value = response.headers.get(SIGIL_SERVICE_COMMIT_HEADER);
  return value !== null && value.length > 0 ? value : undefined;
};

const OPTIONAL_STRING_FIELDS = [
  'policyHash',
  'policy_hash',
  'holdId',
  'hold_id',
  'message',
  'error_code',
  'errorCode',
  'intent_attestation',
  'intentAttestation',
  'decision_record',
  'compiled_response_policy',
  'compiledResponsePolicy',
  'compiled_policy_digest',
  'compiledPolicyDigest',
  'compiled_policy_envelope_digest',
  'compiledPolicyEnvelopeDigest',
] as const;

const parseResponseData = async (
  response: Response,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const getHoldId = (data: Record<string, unknown>): string | undefined => {
  const value = data['holdId'] ?? data['hold_id'];
  const holdId = getString(value);
  return holdId !== undefined && holdId.length > 0 ? holdId : undefined;
};

const hasValidAuthorizationStatus = (status: unknown): boolean => {
  try {
    normalizeDecisionLiteral(status);
    return true;
  } catch {
    return false;
  }
};

const hasValidOptionalStringFields = (
  data: Record<string, unknown>,
): boolean =>
  OPTIONAL_STRING_FIELDS.every(
    (field) =>
      data[field] === undefined ||
      data[field] === null ||
      getString(data[field]) !== undefined,
  );

const invalidAuthorizationResponse = (
  message = 'Authorization response failed schema validation.',
): { data: Record<string, unknown> } => ({
  data: {
    status: 'DENIED',
    error_code: SIGIL_RESPONSE_INVALID,
    message,
  },
});

const hasValidPendingHold = (data: Record<string, unknown>): boolean =>
  data['status'] !== 'PENDING' || getHoldId(data) !== undefined;

const getAliasedString = (
  data: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined => getString(data[snake]) ?? getString(data[camel]);

const hasConsistentStringAlias = (
  data: Record<string, unknown>,
  snake: string,
  camel: string,
): boolean => {
  const snakeValue = getString(data[snake]);
  const camelValue = getString(data[camel]);
  return snakeValue === undefined || camelValue === undefined || snakeValue === camelValue;
};

const RESPONSE_POLICY_AUTHORIZATION_FIELDS = [
  'compiled_response_policy',
  'compiledResponsePolicy',
  'compiled_policy_digest',
  'compiledPolicyDigest',
  'compiled_policy_envelope_digest',
  'compiledPolicyEnvelopeDigest',
] as const;

const hasCompleteResponsePolicyAuthorization = (
  data: Record<string, unknown>,
): boolean => {
  if (
    RESPONSE_POLICY_AUTHORIZATION_FIELDS.some(
      (field) =>
        Object.prototype.hasOwnProperty.call(data, field) &&
        typeof data[field] !== 'string',
    )
  ) {
    return false;
  }
  if (
    !hasConsistentStringAlias(
      data,
      'compiled_response_policy',
      'compiledResponsePolicy',
    ) ||
    !hasConsistentStringAlias(
      data,
      'compiled_policy_digest',
      'compiledPolicyDigest',
    ) ||
    !hasConsistentStringAlias(
      data,
      'compiled_policy_envelope_digest',
      'compiledPolicyEnvelopeDigest',
    )
  ) {
    return false;
  }
  const fields = [
    getAliasedString(data, 'compiled_response_policy', 'compiledResponsePolicy'),
    getAliasedString(data, 'compiled_policy_digest', 'compiledPolicyDigest'),
    getAliasedString(
      data,
      'compiled_policy_envelope_digest',
      'compiledPolicyEnvelopeDigest',
    ),
  ];
  const present = fields.filter((value) => value !== undefined);
  return present.length === 0 || (
    normalizeDecisionLiteral(data['status']) === 'ALLOWED' &&
    present.length === fields.length &&
    present.every((value) => value !== '')
  );
};

const resolveAuthorizationData = (
  data: Record<string, unknown>,
): { data: Record<string, unknown> } => {
  if (data['status'] === 'DENIED') return { data };
  if (!hasValidAuthorizationStatus(data['status'])) {
    return invalidAuthorizationResponse();
  }
  if (!hasValidOptionalStringFields(data)) {
    return invalidAuthorizationResponse();
  }
  if (!hasValidPendingHold(data)) {
    return invalidAuthorizationResponse();
  }
  if (!hasCompleteResponsePolicyAuthorization(data)) {
    return invalidAuthorizationResponse();
  }
  return { data };
};

const resolveForbiddenResponse = (
  data: Record<string, unknown> | undefined,
  serviceCommit?: string,
): AuthorizationHttpResult => {
  if (data?.['status'] !== 'DENIED') {
    return { result: authenticationFailure(403), serviceCommit };
  }
  return { ...resolveAuthorizationData(data), serviceCommit };
};

const resolveHttpResponse = async (
  response: Response,
): Promise<AuthorizationHttpResult> => {
  const serviceCommit = readServiceCommit(response);
  if (response.status === 401) {
    return { result: authenticationFailure(response.status), serviceCommit };
  }
  if (response.status !== 200 && response.status !== 403) {
    return {
      ...invalidAuthorizationResponse(
        `Unexpected authorization response status ${response.status}.`,
      ),
      serviceCommit,
    };
  }
  const data = await parseResponseData(response);
  if (response.status === 403) return resolveForbiddenResponse(data, serviceCommit);
  if (data === undefined) {
    return {
      ...invalidAuthorizationResponse(
        'Authorization response was not a valid JSON object.',
      ),
      serviceCommit,
    };
  }
  return { ...resolveAuthorizationData(data), serviceCommit };
};

// --- strictResponse mode (selected by the Cowork adapter) -------------------
//
// The contract is inverted so the unsafe case cannot be reached by omission:
// only a strictly schema-valid explicit allowed result may flow through to an
// approval. Every other outcome maps to a deny. The default path below is
// untouched and remains byte-identical in behavior for every other adapter.

type StrictBodyResult =
  | { bytes: Uint8Array }
  | { error: 'oversize' | 'timeout' | 'read_error' };

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Reads the raw response body under the 64 KiB cap and a read deadline. The
 * cap alone does not terminate a body that streams slowly forever below it;
 * only the deadline does, which is why both exist.
 */
const readStrictResponseBody = async (
  response: Response,
): Promise<StrictBodyResult> => {
  const body = response.body;
  if (body === null) return { bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => undefined);
  }, STRICT_RESPONSE_BODY_DEADLINE_MS);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { error: 'timeout' };
      if (done) break;
      total += value.byteLength;
      if (total > STRICT_RESPONSE_BODY_CAP_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { error: 'oversize' };
      }
      chunks.push(value);
    }
  } catch {
    return { error: timedOut ? 'timeout' : 'read_error' };
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) return { error: 'timeout' };
  return { bytes: concatChunks(chunks, total) };
};

const STRICT_ALLOWED_KEYS = new Set([
  'status',
  'message',
  'policy_hash',
  'task_id',
  'intent_attestation',
  'decision_record',
  'compiled_response_policy',
  'compiled_policy_digest',
  'compiled_policy_envelope_digest',
]);

const isOptionalStrictString = (
  data: Record<string, unknown>,
  key: string,
): boolean => !(key in data) || typeof data[key] === 'string';

/**
 * The exact accepted allowed shape: a JSON object whose `status` normalizes
 * to ALLOWED, with only the explicitly allowlisted typed fields. Any unknown
 * field rejects — ignoring unknown fields on the one status
 * that means "proceed" is how a future server field silently becomes a bypass.
 * Cross-status fields (`hold_id`, `error_code`, `fail_open`/`failOpen`) are
 * therefore protocol violations here by construction.
 */
const isStrictValidAllowed = (data: Record<string, unknown>): boolean =>
  normalizeDecisionLiteral(data['status']) === 'ALLOWED' &&
  Object.keys(data).every((key) => STRICT_ALLOWED_KEYS.has(key)) &&
  isOptionalStrictString(data, 'message') &&
  isOptionalStrictString(data, 'policy_hash') &&
  isOptionalStrictString(data, 'task_id') &&
  isOptionalStrictString(data, 'intent_attestation') &&
  isOptionalStrictString(data, 'decision_record') &&
  isOptionalStrictString(data, 'compiled_response_policy') &&
  isOptionalStrictString(data, 'compiled_policy_digest') &&
  isOptionalStrictString(data, 'compiled_policy_envelope_digest') &&
  hasCompleteResponsePolicyAuthorization(data);

const isStrictValidDenied = (data: Record<string, unknown>): boolean =>
  data['status'] === 'DENIED' &&
  typeof data['error_code'] === 'string' &&
  data['error_code'].length > 0 &&
  isOptionalStrictString(data, 'message') &&
  isOptionalStrictString(data, 'next_steps') &&
  isOptionalStrictString(data, 'policy_hash') &&
  isOptionalStrictString(data, 'task_id');

const isStrictValidPending = (data: Record<string, unknown>): boolean =>
  data['status'] === 'PENDING' &&
  typeof data['hold_id'] === 'string' &&
  data['hold_id'].length > 0 &&
  isOptionalStrictString(data, 'message') &&
  isOptionalStrictString(data, 'policy_hash') &&
  isOptionalStrictString(data, 'task_id');

/** A protocol violation expressed as denial data, so the ordinary mapping (callbacks, task id) applies. */
const strictProtocolDenial = (
  errorCode: string,
  message: string,
): Record<string, unknown> => ({
  status: 'DENIED',
  error_code: errorCode,
  message,
});

const resolveStrictParsedBody = (
  data: Record<string, unknown>,
): { data: Record<string, unknown> } => {
  if (hasValidAuthorizationStatus(data['status']) &&
      normalizeDecisionLiteral(data['status']) === 'ALLOWED' &&
      isStrictValidAllowed(data)) {
    return { data };
  }
  if (data['status'] === 'DENIED' && isStrictValidDenied(data)) {
    return { data };
  }
  if (data['status'] === 'PENDING' && isStrictValidPending(data)) {
    return { data };
  }
  return {
    data: strictProtocolDenial(
      SIGIL_RESPONSE_INVALID,
      'Authorization response failed strict schema validation.',
    ),
  };
};

const resolveStrictHttpResponse = async (
  response: Response,
): Promise<AuthorizationHttpResult> => {
  const serviceCommit = readServiceCommit(response);
  if (response.status === 401) {
    return { result: authenticationFailure(401), serviceCommit };
  }
  if (response.status === 429) {
    return {
      data: strictProtocolDenial(
        SIGIL_RATE_LIMITED,
        'Sigil Sign rate limited the request (429). Denied fast rather than retried.',
      ),
      serviceCommit,
    };
  }
  if (response.status !== 200 && response.status !== 403) {
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Unexpected authorization response status ${response.status}.`,
      ),
      serviceCommit,
    };
  }
  const body = await readStrictResponseBody(response);
  if ('error' in body) {
    if (response.status === 403) {
      return { result: authenticationFailure(403), serviceCommit };
    }
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Authorization response body rejected (${body.error}).`,
      ),
      serviceCommit,
    };
  }
  const parsed = readStrictJson(body.bytes, {
    maxBytes: STRICT_RESPONSE_BODY_CAP_BYTES,
  });
  if (!parsed.ok) {
    if (response.status === 403) {
      return { result: authenticationFailure(403), serviceCommit };
    }
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Authorization response rejected: ${parsed.message}`,
      ),
      serviceCommit,
    };
  }
  if (response.status === 403) {
    if (isStrictValidDenied(parsed.value)) {
      return { data: parsed.value, serviceCommit };
    }
    return { result: authenticationFailure(403), serviceCommit };
  }
  return { ...resolveStrictParsedBody(parsed.value), serviceCommit };
};

// --- end strictResponse mode ------------------------------------------------

const handleRequestError = (
  intent: SigilIntent,
  config: SigilHookConfig,
  error: Error,
): SigilHookResult => {
  config.onError?.(intent, error);
  const failMode = config.failMode ?? 'open';
  console.warn(JSON.stringify({
    level: failMode === 'closed' ? 'error' : 'warn',
    event: 'sigil_hook_unreachable',
    action: intent.action,
    failMode,
    message: error.message,
  }));
  if (failMode === 'closed') {
    return {
      decision: 'DENIED',
      errorCode: SIGIL_UNREACHABLE,
      message: error.message,
    };
  }
  return {
    decision: 'ALLOWED',
    authorization: createTransportFailOpenAuthorization(),
    failOpen: true,
    message: 'Sigil unreachable — fail open',
  };
};

const HEX_64 = /^[0-9a-f]{64}$/;

const configurationError = (
  config: SigilHookConfig,
): string | undefined => {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  try {
    const origin = new URL(apiUrl);
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      apiUrl !== origin.origin
    ) {
      return 'apiUrl must be an exact canonical HTTPS origin.';
    }
  } catch {
    return 'apiUrl must be an exact canonical HTTPS origin.';
  }
  const verificationMode = config.decisionVerificationMode
    ?? DEFAULT_DECISION_VERIFICATION_MODE;
  if (
    verificationMode === 'enforce' &&
    (config.expectedPolicyHash === undefined || !HEX_64.test(config.expectedPolicyHash))
  ) {
    return 'Enforce mode requires a lowercase SHA-256 expected policy hash.';
  }
  return undefined;
};

const requestAuthorization = async (
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<AuthorizationRequestResult> => {
  // Resolved before anything else so a malformed build identity throws before
  // any network I/O and before a timer exists to leak. The client header is
  // untrusted diagnostic metadata only: Sign never reads it for a decision, and
  // this module never reads it back.
  const clientIdentifier = resolveClientIdentifier();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };
  if (clientIdentifier !== undefined) {
    headers[SIGIL_CLIENT_HEADER] = clientIdentifier.headerValue;
  }
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const requestBody = buildAuthorizeRequestBody(intent, config);
  const body = `${JSON.stringify(requestBody, null, 2)}\n`;
  const verificationContext: AuthorizationVerificationContext = {
    mode: config.decisionVerificationMode ?? DEFAULT_DECISION_VERIFICATION_MODE,
    signOrigin: apiUrl,
    expectedPolicyHash: config.expectedPolicyHash,
    txCommit: getString(requestBody['txCommit']) as string,
    requestNonce: getString(requestBody['request_nonce']) as string,
    surface: 'authorize',
    pinnedJwk: config.decisionRecordJwk,
    attestationIssuer: config.attestationIssuer,
    execution: true,
  };
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Propagate a caller-supplied AbortSignal into the socket, so an aborted
  // wrapper deadline actually cancels the in-flight request rather than
  // leaving it alive behind a settled process.
  const externalSignal = config.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const strict = config.strictResponse === true;
  if (
    verificationContext.mode === 'warn' &&
    verificationContext.expectedPolicyHash === undefined
  ) {
    logDecisionVerification('policy_binding', 'warn', 'authorize');
  }
  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      // Bearer-bearing authorization requests never follow redirects. Manual
      // mode returns the 3xx response to the protocol classifier, where it is
      // denied without being confused with no-response transport failure.
      redirect: 'manual',
    };
    response = await fetch(`${apiUrl}/v1/authorize`, requestInit);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
    return {
      response: { result: handleRequestError(intent, config, error) },
      verificationContext,
    };
  }
  try {
    return {
      response: strict
        ? await resolveStrictHttpResponse(response)
        : await resolveHttpResponse(response),
      verificationContext,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    config.onError?.(intent, error);
    return {
      response: invalidAuthorizationResponse(
        `Authorization response processing failed (${error.message}).`,
      ),
      verificationContext,
    };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
};

const getPolicyHash = (
  data: Record<string, unknown>,
): string | undefined =>
  getString(data['policyHash']) ?? getString(data['policy_hash']);

const approvedResult = (
  data: Record<string, unknown>,
  authorization: NonNullable<SigilHookResult['authorization']>,
  serviceCommit?: string,
): SigilHookResult => {
  const compactJws = getAliasedString(
    data,
    'compiled_response_policy',
    'compiledResponsePolicy',
  );
  const compiledPolicyDigest = getAliasedString(
    data,
    'compiled_policy_digest',
    'compiledPolicyDigest',
  );
  const envelopeDigest = getAliasedString(
    data,
    'compiled_policy_envelope_digest',
    'compiledPolicyEnvelopeDigest',
  );
  const result: SigilHookResult = {
    decision: 'ALLOWED',
    authorization,
    policyHash: getPolicyHash(data),
    intentAttestation: getAliasedString(
      data,
      'intent_attestation',
      'intentAttestation',
    ),
    ...(compactJws !== undefined &&
    compiledPolicyDigest !== undefined &&
    envelopeDigest !== undefined
      ? {
          responsePolicy: {
            compactJws,
            compiledPolicyDigest,
            envelopeDigest,
          },
        }
      : {}),
  };
  return serviceCommit === undefined ? result : { ...result, serviceCommit };
};

const pendingResult = (
  data: Record<string, unknown>,
  intent: SigilIntent,
  config: SigilHookConfig,
  serviceCommit?: string,
): SigilHookResult => {
  const holdId = getHoldId(data) as string;
  config.onPending?.(intent, holdId);
  const result: SigilHookResult = {
    decision: 'PENDING',
    holdId,
    policyHash: getPolicyHash(data),
    message: getString(data['message']),
  };
  return serviceCommit === undefined ? result : { ...result, serviceCommit };
};

const denialMessage = (
  errorCode: string,
  message: string,
  taskId: string,
): string => {
  if (errorCode === SIGIL_LOOP_LIMIT_EXCEEDED) {
    return `${message} Hard-stop this agent run for task_id ${taskId}.`;
  }
  if (errorCode === SIGIL_LIMIT_STORE_UNAVAILABLE) {
    return `${message} Sigil could not verify loop budget, so enforcement failed closed.`;
  }
  return message;
};

const deniedResult = (
  data: Record<string, unknown>,
  intent: SigilIntent,
  config: SigilHookConfig,
  serviceCommit?: string,
): SigilHookResult => {
  const taskId = resolveTaskId(intent, config);
  const errorCode = (getString(data['error_code'])
    ?? getString(data['errorCode'])
    ?? 'SIGIL_POLICY_VIOLATION');
  const baseMessage = getString(data['message']) ?? 'Action blocked by policy';
  const message = denialMessage(errorCode, baseMessage, taskId);
  config.onDenied?.(intent, message);
  const result: SigilHookResult = {
    decision: 'DENIED',
    errorCode,
    message,
    policyHash: getPolicyHash(data),
    taskId,
  };
  return serviceCommit === undefined ? result : { ...result, serviceCommit };
};

const mapAuthorizationData = async (
  data: Record<string, unknown>,
  intent: SigilIntent,
  config: SigilHookConfig,
  verificationContext: AuthorizationVerificationContext,
  serviceCommit?: string,
): Promise<SigilHookResult> => {
  const verified = await verifyAuthorizationResponse(data, verificationContext);
  if (verified.reason !== undefined) {
    logDecisionVerification(verified.reason, verificationContext.mode, verificationContext.surface);
  }
  if (verified.decision === 'ALLOWED' && verified.authorization !== undefined) {
    return approvedResult(data, verified.authorization, serviceCommit);
  }
  if (verified.decision === 'PENDING') {
    return pendingResult(data, intent, config, serviceCommit);
  }
  if (
    hasValidAuthorizationStatus(data['status']) &&
    normalizeDecisionLiteral(data['status']) === 'ALLOWED'
  ) {
    return deniedResult({
      status: 'DENIED',
      error_code: 'SIGIL_DECISION_VERIFICATION_FAILED',
      message: `Authorization response verification failed (${verified.reason ?? 'malformed'}).`,
      policy_hash: getPolicyHash(data),
    }, intent, config, serviceCommit);
  }
  return deniedResult(data, intent, config, serviceCommit);
};

export const checkIntent = async (
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> => {
  const configError = configurationError(config);
  if (configError !== undefined) {
    return deniedResult({
      status: 'DENIED',
      error_code: 'SIGIL_DECISION_VERIFICATION_FAILED',
      message: configError,
    }, intent, config);
  }
  const request = await requestAuthorization(intent, config);
  if ('result' in request.response) {
    return request.response.serviceCommit === undefined
      ? request.response.result
      : { ...request.response.result, serviceCommit: request.response.serviceCommit };
  }
  try {
    return await mapAuthorizationData(
      request.response.data,
      intent,
      config,
      request.verificationContext,
      request.response.serviceCommit,
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    config.onError?.(intent, error);
    return deniedResult({
      status: 'DENIED',
      error_code: 'SIGIL_DECISION_VERIFICATION_FAILED',
      message: `Authorization response verification failed (${error.message}).`,
    }, intent, config);
  }
};
