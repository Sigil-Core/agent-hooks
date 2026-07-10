// src/adapters/claude.ts
// Compatible with @anthropic-ai/sdk tool_use block format

import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';
import { intentFromToolInput, mapToolAction, objectInput } from './shared.js';

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
  const input = objectInput(block.input);
  const intent: SigilIntent = intentFromToolInput(
    mapToolAction(block.name),
    input,
    input,
  );

  const result = await checkIntent(intent, config);

  if (result.decision === 'APPROVED') return null;

  const rejection = buildRejectionContext(result, intent.action);
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(rejection),
    is_error: true,
  };
}
