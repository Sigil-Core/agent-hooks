// src/adapters/openclaw.ts
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';

export interface OpenclawBeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

export interface OpenclawToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

export interface OpenclawBeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: 'info' | 'warning' | 'critical';
    timeoutMs?: number;
    timeoutBehavior?: 'allow' | 'deny';
  };
}

export function createOpenclawSigilHandler(config: SigilHookConfig) {
  return async (
    event: OpenclawBeforeToolCallEvent,
    ctx: OpenclawToolContext,
  ): Promise<OpenclawBeforeToolCallResult | undefined> => {
    const action = event.toolName.toLowerCase();
    const intent: SigilIntent = {
      action,
      agentId: ctx.agentId ?? config.agentId,
      command: event.params['command'] as string | undefined,
      url: event.params['url'] as string | undefined,
      path: event.params['path'] as string | undefined,
    };

    const result = await checkIntent(intent, {
      ...config,
      framework: config.framework ?? 'openclaw',
    });

    if (result.decision === 'APPROVED') return undefined;

    if (result.decision === 'PENDING') {
      return {
        requireApproval: {
          title: `Sigil approval required: ${action}`,
          description: result.message ?? 'Action requires human approval via Sigil.',
          severity: 'warning',
        },
      };
    }

    const rejection = buildRejectionContext(result, action);
    return {
      block: true,
      blockReason: `${rejection.sigil_error_code}: ${rejection.sigil_message} — ${rejection.sigil_next_steps}`,
    };
  };
}
