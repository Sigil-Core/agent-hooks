// src/adapters/langchain.ts
// Compatible with LangChain Tool interface

import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig } from '../types.js';
import { intentFromToolInput, mapToolAction, objectInput } from './shared.js';

/**
 * Wraps a LangChain tool with a Sigil policy check.
 * Returns a wrapped tool whose call() method checks policy before execution.
 */
export function wrapLangChainTool<T extends { name: string; call: (input: string) => Promise<string> }>(
  tool: T,
  config: SigilHookConfig,
): T {
  const originalCall = tool.call.bind(tool);

  tool.call = async (input: string): Promise<string> => {
    const action = mapToolAction(tool.name);
    const structuredInput = parseStructuredInput(input);
    const intent = intentFromToolInput(action, structuredInput, { input });
    const result = await checkIntent(
      intent,
      config,
    );

    if (result.decision === 'APPROVED') {
      return originalCall(input);
    }

    const rejection = buildRejectionContext(result, intent.action);
    return JSON.stringify(rejection);
  };

  return tool;
}

function parseStructuredInput(input: string): Record<string, unknown> {
  try {
    return objectInput(JSON.parse(input));
  } catch {
    return {};
  }
}
