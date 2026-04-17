import { createHash } from 'node:crypto';
import type { SigilHookConfig, SigilIntent } from './types.js';

export function buildAuthorizeRequestBody(
  intent: SigilIntent,
  config: SigilHookConfig,
): Record<string, unknown> {
  const agentId = config.agentId ?? intent.agentId ?? 'agent';
  const txCommit = intent.txCommit ?? generateIntentCommit(intent);

  return {
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

