// src/interceptor.ts
import { createHash } from 'node:crypto';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';
import { SIGIL_UNREACHABLE } from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';

export async function checkIntent(
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const agentId = config.agentId ?? intent.agentId ?? 'agent';
  const txCommit = intent.txCommit ?? generateIntentCommit(intent);

  const body = {
    framework: config.framework ?? 'agent-hooks',
    agentId,
    txCommit,
    chainId: intent.chainId,
    intent: {
      action: intent.action,
      command: intent.command,
      url: intent.url,
      path: intent.path,
      targetAddress: intent.to,
      amount: intent.amount,
      metadata: intent.metadata,
    },
  };

  let data: Record<string, unknown>;
  try {
    const response = await fetch(`${apiUrl}/v1/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
      return { decision: 'DENIED', errorCode: 'SIGIL_AUTH_FAILURE', message: `Authentication failed (${response.status})` };
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

function generateIntentCommit(intent: SigilIntent): string {
  const preimage = JSON.stringify({
    action: intent.action,
    command: intent.command,
    url: intent.url,
    path: intent.path,
    to: intent.to,
    amount: intent.amount,
    ts: Math.floor(Date.now() / 1000),
  });
  return createHash('sha256').update(preimage).digest('hex');
}
