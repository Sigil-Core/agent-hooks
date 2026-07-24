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
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const validateAuthorizationData = (
  data: Record<string, unknown>,
): void => {
  const status = data['status'];
  if (status !== 'APPROVED' && status !== 'DENIED' && status !== 'PENDING') {
    throw new Error('sigil_response_invalid_status');
  }
  if (status === 'PENDING' && getHoldId(data) === undefined) {
    throw new Error('sigil_response_invalid_hold_id');
  }
};

const resolveForbiddenResponse = (
  data: Record<string, unknown> | undefined,
): AuthorizationHttpResult =>
  data?.['status'] === 'DENIED'
    ? { data }
    : { result: authenticationFailure(403) };

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
  validateAuthorizationData(data);
  return { data };
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
      body: serializeAuthorizeRequestBody(intent, config),
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
  (data['policyHash'] as string | undefined)
  ?? (data['policy_hash'] as string | undefined);

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
    message: data['message'] as string | undefined,
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
  const errorCode = ((data['error_code'] as string | undefined)
    ?? (data['errorCode'] as string | undefined)
    ?? 'SIGIL_POLICY_VIOLATION');
  const baseMessage = (data['message'] as string) ?? 'Action blocked by policy';
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
