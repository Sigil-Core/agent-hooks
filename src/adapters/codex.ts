import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig } from '../types.js';
import {
  intentFromToolInput,
  mapToolAction,
  objectInput,
  resolveTaskIdFromPayload,
} from './shared.js';

export interface CodexPreToolUsePayload {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  tool_name: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  [key: string]: unknown;
}

export interface CodexPreToolUseDenyResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export type CodexPreToolUseResult = CodexPreToolUseDenyResult | undefined;

export function createCodexPreToolUseHook(config: SigilHookConfig) {
  return async (payload: CodexPreToolUsePayload): Promise<CodexPreToolUseResult> => {
    const input = objectInput(payload.tool_input);
    const action = mapToolAction(payload.tool_name);
    const result = await checkIntent(
      intentFromToolInput(action, input, {
        ...input,
        codex: {
          cwd: payload.cwd,
          model: payload.model,
          permissionMode: payload.permission_mode,
          toolName: payload.tool_name,
          toolUseId: payload.tool_use_id,
          coverage: codexCoverage(payload.tool_name),
        },
      }),
      {
        ...config,
        framework: config.framework ?? 'codex',
        taskId: resolveTaskIdFromPayload(payload, config),
        failMode: config.failMode ?? 'closed',
      },
    );

    if (result.decision === 'APPROVED') return undefined;

    const rejection = buildRejectionContext(result, action);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${rejection.sigil_error_code}: ${rejection.sigil_message}`,
      },
    };
  };
}

function codexCoverage(toolName: string): string {
  if (toolName === 'Bash') {
    return 'Codex PreToolUse covers simple Bash calls, but richer shell streaming can bypass current hook coverage.';
  }
  if (toolName === 'apply_patch' || toolName === 'Edit' || toolName === 'Write') {
    return 'Codex PreToolUse covers file edits through apply_patch, including Edit and Write matcher aliases.';
  }
  if (toolName.startsWith('mcp__')) {
    return 'Codex PreToolUse covers matching MCP tool calls; route broader MCP traffic through Sigil MCP Proxy for protocol-level enforcement.';
  }
  return 'Codex PreToolUse does not currently cover WebSearch or every non-shell tool path.';
}
