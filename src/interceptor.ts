// src/interceptor.ts
import { createHash } from 'node:crypto';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';

export async function checkIntent(
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const agentId = config.agentId ?? intent.agentId ?? 'agent';
  const txCommit = intent.txCommit ?? generateIntentCommit(intent);

  const body = {
    framework: 'agent-hooks',
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
    data = await response.json() as Record<string, unknown>;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    config.onError?.(intent, error);
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'sigil_hook_network_error',
      action: intent.action,
      message: error.message,
    }));
    return { decision: 'APPROVED', message: 'Sigil unreachable — fail open' };
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
