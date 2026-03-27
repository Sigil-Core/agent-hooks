// src/adapters/claude.ts
// Compatible with @anthropic-ai/sdk tool_use block format

import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';

// Maps Anthropic tool names to Sigil action types
const TOOL_ACTION_MAP: Record<string, string> = {
  Bash: 'bash',
  bash: 'bash',
  WebSearch: 'web_fetch',
  WebFetch: 'web_fetch',
  computer: 'bash',
  Write: 'file_write',
  Edit: 'file_write',
};

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Call this in a PreToolUse hook before any Anthropic tool executes.
 * Returns null if approved, or a tool_result block to inject if denied/pending.
 */
export async function checkAnthropicToolUse(
  block: AnthropicToolUseBlock,
  config: SigilHookConfig,
): Promise<null | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }> {
  const action = TOOL_ACTION_MAP[block.name] ?? block.name.toLowerCase();

  const intent: SigilIntent = {
    action,
    command: block.input['command'] as string | undefined,
    url: block.input['url'] as string | undefined,
    path: block.input['path'] as string | undefined,
    metadata: block.input,
  };

  const result = await checkIntent(intent, config);

  if (result.decision === 'APPROVED') return null;

  const rejection = buildRejectionContext(result, action);
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(rejection),
    is_error: true,
  };
}
