// src/adapters/langchain.ts
// Compatible with LangChain Tool interface

import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig } from '../types.js';

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
    const result = await checkIntent(
      { action: tool.name.toLowerCase(), metadata: { input } },
      config,
    );

    if (result.decision === 'APPROVED') {
      return originalCall(input);
    }

    const rejection = buildRejectionContext(result, tool.name);
    return JSON.stringify(rejection);
  };

  return tool;
}
