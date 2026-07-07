import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig } from '../types.js';
import {
  intentFromToolInput,
  mapToolAction,
  objectInput,
  resolveTaskIdFromPayload,
  valueAsString,
} from './shared.js';

export interface HermesPreToolCallPayload {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  session_id?: string;
  conversation_id?: string;
  run_id?: string;
  [key: string]: unknown;
}

export interface HermesPreToolCallBlock {
  decision: 'block';
  reason: string;
}

export type HermesPreToolCallResult = HermesPreToolCallBlock | Record<string, never>;

export function createHermesPreToolCallHook(config: SigilHookConfig) {
  return async (payload: HermesPreToolCallPayload): Promise<HermesPreToolCallResult> => {
    const toolName = valueAsString(payload.tool_name) ?? valueAsString(payload.toolName) ?? '';
    const input = objectInput(payload.tool_input ?? payload.toolInput);
    const action = mapToolAction(toolName);
    const result = await checkIntent(
      intentFromToolInput(action, input, {
        ...input,
        hermes: {
          originalToolName: toolName,
          sessionId: payload.session_id,
          conversationId: payload.conversation_id,
          runId: payload.run_id,
        },
      }),
      {
        ...config,
        framework: config.framework ?? 'hermes',
        taskId: resolveTaskIdFromPayload(payload, config),
      },
    );

    if (result.decision === 'APPROVED') return {};

    const rejection = buildRejectionContext(result, action);
    return {
      decision: 'block',
      reason: `${rejection.sigil_error_code}: ${rejection.sigil_message}`,
    };
  };
}
