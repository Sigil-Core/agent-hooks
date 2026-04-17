// src/adapters/openclaw.ts
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';

const TOOL_ACTION_MAP: Record<string, string> = {
  exec: 'bash',
  process: 'bash',
  code_execution: 'bash',
  write: 'file_write',
  edit: 'file_write',
  apply_patch: 'file_write',
  web_fetch: 'web_fetch',
  web_search: 'web_fetch',
  x_search: 'web_fetch',
  browser: 'web_fetch',
};

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
    const action = TOOL_ACTION_MAP[event.toolName] ?? event.toolName.toLowerCase();
    const intent: SigilIntent = {
      action,
      agentId: ctx.agentId ?? config.agentId,
      command: event.params['command'] as string | undefined,
      url: event.params['url'] as string | undefined,
      path: event.params['path'] as string | undefined,
      metadata: {
        ...event.params,
        openclaw: {
          sessionKey: ctx.sessionKey,
          sessionId: ctx.sessionId,
          runId: ctx.runId ?? event.runId,
          toolCallId: ctx.toolCallId ?? event.toolCallId,
          originalToolName: event.toolName,
        },
      },
    };

    const result = await checkIntent(intent, {
      ...config,
      framework: config.framework ?? 'openclaw',
    });

    if (result.decision === 'APPROVED') return undefined;

    // DENIED and PENDING both become blocks. PENDING is not downgraded to
    // OpenClaw's local requireApproval UI: that would let a host user approve
    // the call without resolving the Sigil hold, bypassing enforcement. The
    // hold_id is surfaced in blockReason so operators can resolve it out of
    // band via Sigil Command.
    const rejection = buildRejectionContext(result, action);
    const holdSuffix = rejection.sigil_hold_id
      ? ` (hold_id: ${rejection.sigil_hold_id})`
      : '';
    return {
      block: true,
      blockReason: `${rejection.sigil_error_code}: ${rejection.sigil_message} — ${rejection.sigil_next_steps}${holdSuffix}`,
    };
  };
}
