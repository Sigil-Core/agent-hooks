// src/interceptor.ts
import { resolveTaskId, serializeAuthorizeRequestBody } from './request.js';
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

/** strictResponse mode: response body cap in UTF-8 bytes (64 KiB). */
const STRICT_RESPONSE_BODY_CAP_BYTES = 64 * 1024;
/** strictResponse mode: body-read deadline, so a body that streams slowly forever still denies fast. */
const STRICT_RESPONSE_BODY_DEADLINE_MS = 1500;

type AuthorizationHttpResult =
  | { data: Record<string, unknown> }
  | { result: SigilHookResult };

const authenticationFailure = (status: number): SigilHookResult => ({
  decision: 'DENIED',
  errorCode: 'SIGIL_AUTH_FAILURE',
  message: `Authentication failed (${status})`,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

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

const hasValidAuthorizationStatus = (status: unknown): boolean =>
  status === 'APPROVED' || status === 'DENIED' || status === 'PENDING';

const hasValidOptionalStringFields = (
  data: Record<string, unknown>,
): boolean =>
  OPTIONAL_STRING_FIELDS.every(
    (field) =>
      data[field] === undefined ||
      data[field] === null ||
      getString(data[field]) !== undefined,
  );

const throwInvalidAuthorizationResponse = (): never => {
  throw new Error('sigil_response_invalid_authorization');
};

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

const hasCompleteResponsePolicyAuthorization = (
  data: Record<string, unknown>,
): boolean => {
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
    data['status'] === 'APPROVED' &&
    present.length === fields.length &&
    present.every((value) => value !== '')
  );
};

const resolveAuthorizationData = (
  data: Record<string, unknown>,
): AuthorizationHttpResult => {
  if (data['status'] === 'DENIED') return { data };
  if (!hasValidAuthorizationStatus(data['status'])) {
    return throwInvalidAuthorizationResponse();
  }
  if (!hasValidOptionalStringFields(data)) {
    return throwInvalidAuthorizationResponse();
  }
  if (!hasValidPendingHold(data)) {
    return throwInvalidAuthorizationResponse();
  }
  if (!hasCompleteResponsePolicyAuthorization(data)) {
    return throwInvalidAuthorizationResponse();
  }
  return { data };
};

const resolveForbiddenResponse = (
  data: Record<string, unknown> | undefined,
): AuthorizationHttpResult => {
  if (data?.['status'] !== 'DENIED') {
    return { result: authenticationFailure(403) };
  }
  return resolveAuthorizationData(data);
};

const resolveHttpResponse = async (
  response: Response,
): Promise<AuthorizationHttpResult> => {
  if (response.status === 401) {
    return { result: authenticationFailure(response.status) };
  }
  if (response.status >= 500) {
    throw new Error(`sigil_server_${response.status}`);
  }
  const data = await parseResponseData(response);
  if (response.status === 403) return resolveForbiddenResponse(data);
  if (data === undefined) throw new Error('sigil_response_invalid_json');
  return resolveAuthorizationData(data);
};

// --- strictResponse mode (selected by the Cowork adapter) -------------------
//
// The contract is inverted so the unsafe case cannot be reached by omission:
// only a strictly schema-valid explicit APPROVED may flow through to an
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

const STRICT_APPROVED_KEYS = new Set([
  'status',
  'policy_hash',
  'task_id',
  'intent_attestation',
  'compiled_response_policy',
  'compiled_policy_digest',
  'compiled_policy_envelope_digest',
]);

const isOptionalStrictString = (
  data: Record<string, unknown>,
  key: string,
): boolean => !(key in data) || typeof data[key] === 'string';

/**
 * The exact accepted APPROVED shape: a JSON object whose `status` is
 * "APPROVED", with optional string `policy_hash` and `task_id` and nothing
 * else. Any unknown field rejects — ignoring unknown fields on the one status
 * that means "proceed" is how a future server field silently becomes a bypass.
 * Cross-status fields (`hold_id`, `error_code`, `fail_open`/`failOpen`) are
 * therefore protocol violations here by construction.
 */
const isStrictValidApproved = (data: Record<string, unknown>): boolean =>
  data['status'] === 'APPROVED' &&
  Object.keys(data).every((key) => STRICT_APPROVED_KEYS.has(key)) &&
  isOptionalStrictString(data, 'policy_hash') &&
  isOptionalStrictString(data, 'task_id') &&
  isOptionalStrictString(data, 'intent_attestation') &&
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
): AuthorizationHttpResult => {
  if (data['status'] === 'APPROVED' && isStrictValidApproved(data)) {
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
  if (response.status === 401) {
    return { result: authenticationFailure(401) };
  }
  if (response.status >= 500) {
    throw new Error(`sigil_server_${response.status}`);
  }
  if (response.status === 429) {
    return {
      data: strictProtocolDenial(
        SIGIL_RATE_LIMITED,
        'Sigil Sign rate limited the request (429). Denied fast rather than retried.',
      ),
    };
  }
  if (response.status !== 200 && response.status !== 403) {
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Unexpected authorization response status ${response.status}.`,
      ),
    };
  }
  const body = await readStrictResponseBody(response);
  if ('error' in body) {
    if (response.status === 403) {
      return { result: authenticationFailure(403) };
    }
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Authorization response body rejected (${body.error}).`,
      ),
    };
  }
  const parsed = readStrictJson(body.bytes, {
    maxBytes: STRICT_RESPONSE_BODY_CAP_BYTES,
  });
  if (!parsed.ok) {
    if (response.status === 403) {
      return { result: authenticationFailure(403) };
    }
    return {
      data: strictProtocolDenial(
        SIGIL_RESPONSE_INVALID,
        `Authorization response rejected: ${parsed.message}`,
      ),
    };
  }
  if (response.status === 403) {
    if (isStrictValidDenied(parsed.value)) return { data: parsed.value };
    return { result: authenticationFailure(403) };
  }
  return resolveStrictParsedBody(parsed.value);
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
    decision: 'APPROVED',
    failOpen: true,
    message: 'Sigil unreachable — fail open',
  };
};

const requestAuthorization = async (
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<AuthorizationHttpResult> => {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const body = serializeAuthorizeRequestBody(intent, config);
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
  try {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    };
    // Under strictResponse, do not auto-follow redirects: a real fetch would
    // silently follow a 3xx and the strict path would never see it. redirect:
    // 'error' turns a 3xx into a rejected fetch that lands on the fail-closed
    // deny path. The default path is left with fetch's normal follow behavior.
    if (strict) requestInit.redirect = 'error';
    const response = await fetch(`${apiUrl}/v1/authorize`, requestInit);
    return strict
      ? await resolveStrictHttpResponse(response)
      : await resolveHttpResponse(response);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { result: handleRequestError(intent, config, error) };
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
  return {
    decision: 'APPROVED',
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
};

const pendingResult = (
  data: Record<string, unknown>,
  intent: SigilIntent,
  config: SigilHookConfig,
): SigilHookResult => {
  const holdId = getHoldId(data) as string;
  config.onPending?.(intent, holdId);
  return {
    decision: 'PENDING',
    holdId,
    policyHash: getPolicyHash(data),
    message: getString(data['message']),
  };
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
): SigilHookResult => {
  const taskId = resolveTaskId(intent, config);
  const errorCode = (getString(data['error_code'])
    ?? getString(data['errorCode'])
    ?? 'SIGIL_POLICY_VIOLATION');
  const baseMessage = getString(data['message']) ?? 'Action blocked by policy';
  const message = denialMessage(errorCode, baseMessage, taskId);
  config.onDenied?.(intent, message);
  return {
    decision: 'DENIED',
    errorCode,
    message,
    policyHash: getPolicyHash(data),
    taskId,
  };
};

const mapAuthorizationData = (
  data: Record<string, unknown>,
  intent: SigilIntent,
  config: SigilHookConfig,
): SigilHookResult => {
  if (data['status'] === 'APPROVED') {
    return approvedResult(data);
  }
  if (data['status'] === 'PENDING') {
    return pendingResult(data, intent, config);
  }
  return deniedResult(data, intent, config);
};

export const checkIntent = async (
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> => {
  const response = await requestAuthorization(intent, config);
  if ('result' in response) return response.result;
  return mapAuthorizationData(response.data, intent, config);
};
