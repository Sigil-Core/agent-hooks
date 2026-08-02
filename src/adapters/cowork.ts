import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import { SIGIL_UNREACHABLE } from '../types.js';
import type { SigilHookConfig, SigilHookResult } from '../types.js';
import {
  intentFromToolInput,
  mapToolAction,
  objectInput,
  resolveTaskIdFromPayload,
} from './shared.js';

/**
 * Provisional pending the Phase A Procedure 9 capture of Cowork's real
 * PreToolUse field set. That real-path capture belongs at
 * tests/contract-fixtures/v1/cowork_pretooluse.json and must never be synthetic.
 */
export interface CoworkPreToolUsePayload {
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

export interface CoworkPreToolUseDenyResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export type CoworkPreToolUseResult = CoworkPreToolUseDenyResult | undefined;

type ParsedCoworkPayload =
  | { payload: CoworkPreToolUsePayload }
  | { error: string };

const INVALID_PAYLOAD_CODE = 'SIGIL_COWORK_PAYLOAD_INVALID';

export function createCoworkPreToolUseHook(config: SigilHookConfig) {
  return async (
    rawPayload: CoworkPreToolUsePayload | string,
  ): Promise<CoworkPreToolUseResult> => {
    const parsed = parseCoworkPayload(rawPayload);
    if ('error' in parsed) {
      return denyResult({
        decision: 'DENIED',
        errorCode: INVALID_PAYLOAD_CODE,
        message: parsed.error,
      }, 'cowork.pre_tool_use');
    }

    const payload = parsed.payload;
    if (typeof payload.tool_name !== 'string' || payload.tool_name.trim().length === 0) {
      return denyResult({
        decision: 'DENIED',
        errorCode: INVALID_PAYLOAD_CODE,
        message: 'Cowork PreToolUse payload is missing tool_name.',
      }, 'cowork.pre_tool_use');
    }
    if (!isObject(payload.tool_input)) {
      return denyResult({
        decision: 'DENIED',
        errorCode: INVALID_PAYLOAD_CODE,
        message: 'Cowork PreToolUse payload tool_input must be an object.',
      }, 'cowork.pre_tool_use');
    }

    const input = objectInput(payload.tool_input);
    const action = mapToolAction(payload.tool_name);
    const intent = intentFromToolInput(action, input, {
      ...input,
      cowork: {
        cwd: payload.cwd,
        model: payload.model,
        permissionMode: payload.permission_mode,
        toolName: payload.tool_name,
        toolUseId: payload.tool_use_id,
        coverage: coworkCoverage(payload.tool_name),
      },
    });
    let result: SigilHookResult;
    try {
      result = await checkIntent(
        intent,
        {
          ...config,
          framework: config.framework ?? 'cowork',
          taskId: resolveTaskIdFromPayload(payload, config),
          failMode: config.failMode ?? 'closed',
        },
      );
    } catch (error: unknown) {
      result = {
        decision: 'DENIED',
        errorCode: SIGIL_UNREACHABLE,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.decision === 'APPROVED') return undefined;

    return denyResult(result, intent.action);
  };
}

function parseCoworkPayload(
  rawPayload: CoworkPreToolUsePayload | string,
): ParsedCoworkPayload {
  let payload: unknown = rawPayload;
  if (typeof rawPayload === 'string') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      return { error: 'Cowork PreToolUse payload is not valid JSON.' };
    }
  }

  if (!isObject(payload)) {
    return { error: 'Cowork PreToolUse payload must be an object.' };
  }
  return { payload: payload as CoworkPreToolUsePayload };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function denyResult(
  result: SigilHookResult,
  action: string,
): CoworkPreToolUseDenyResult {
  const rejection = buildRejectionContext(result, action);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${rejection.sigil_error_code}: ${rejection.sigil_message}`,
    },
  };
}

function coworkCoverage(toolName: string): string {
  if (['Write', 'Read', 'Edit', 'Glob', 'Grep'].includes(toolName)) {
    return "Cowork file tools (Write, Read, Edit, Glob, and Grep) are scoped to the session's connected folders and refuse targets outside them.";
  }
  if (toolName === 'Bash') {
    return 'Cowork Bash executes in a Linux sandbox VM, a different process tree from the hook running in the desktop client on the macOS host.';
  }
  if (toolName === 'WebFetch') {
    return 'Cowork WebFetch is reachable through PreToolUse. No web-search tool exists on this surface.';
  }
  if (toolName.startsWith('mcp__')) {
    return 'Cowork MCP tool classes are reachable through PreToolUse.';
  }
  return 'Cowork PreToolUse reaches subagent invocation, WebFetch, and MCP tool classes. No web-search tool exists on this surface.';
}
