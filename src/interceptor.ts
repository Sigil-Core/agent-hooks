// src/interceptor.ts
import { resolveTaskId, serializeAuthorizeRequestBody } from './request.js';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';
import {
  SIGIL_LIMIT_STORE_UNAVAILABLE,
  SIGIL_LOOP_LIMIT_EXCEEDED,
  SIGIL_UNREACHABLE,
} from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';

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
  if (data['status'] === 'PENDING' && getHoldId(data) === undefined) {
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
  try {
    const response = await fetch(`${apiUrl}/v1/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    return await resolveHttpResponse(response);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { result: handleRequestError(intent, config, error) };
  } finally {
    clearTimeout(timer);
  }
};

const getPolicyHash = (
  data: Record<string, unknown>,
): string | undefined =>
  getString(data['policyHash']) ?? getString(data['policy_hash']);

const approvedResult = (
  data: Record<string, unknown>,
): SigilHookResult => ({
  decision: 'APPROVED',
  policyHash: getPolicyHash(data),
});

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
