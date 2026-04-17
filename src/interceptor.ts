// src/interceptor.ts
import { buildAuthorizeRequestBody } from './request.js';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';
import { SIGIL_UNREACHABLE } from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';

export async function checkIntent(
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const body = buildAuthorizeRequestBody(intent, config);

  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let data: Record<string, unknown>;
  try {
    const response = await fetch(`${apiUrl}/v1/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { decision: 'DENIED', errorCode: 'SIGIL_AUTH_FAILURE', message: `Authentication failed (${response.status})` };
    }
    if (response.status >= 500) {
      throw new Error(`sigil_server_${response.status}`);
    }
    data = await response.json() as Record<string, unknown>;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
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
      return { decision: 'DENIED', errorCode: SIGIL_UNREACHABLE, message: error.message };
    }
    return { decision: 'APPROVED', failOpen: true, message: 'Sigil unreachable — fail open' };
  } finally {
    clearTimeout(timer);
  }

  if (data['status'] === 'APPROVED') {
    return {
      decision: 'APPROVED',
      policyHash: data['policyHash'] as string | undefined,
    };
  }

  const policyHash = data['policyHash'] as string | undefined;

  if (data['status'] === 'PENDING') {
    const holdId = data['holdId'] as string;
    config.onPending?.(intent, holdId);
    return {
      decision: 'PENDING',
      holdId,
      policyHash,
      message: data['message'] as string | undefined,
    };
  }

  const errorCode = (data['error_code'] as string) ?? 'SIGIL_POLICY_VIOLATION';
  const message = (data['message'] as string) ?? 'Action blocked by policy';
  config.onDenied?.(intent, message);
  return { decision: 'DENIED', errorCode, message, policyHash };
}
