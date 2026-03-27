// src/adapters/eliza.ts
// Compatible with ElizaOS action execution pattern

import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent, SigilRejectionContext } from '../types.js';

export interface ElizaAction {
  name: string;
  params?: Record<string, unknown>;
}

/**
 * Call before any ELIZA action executes.
 * Returns null if approved, or an error object if denied/pending.
 */
export async function checkElizaAction(
  action: ElizaAction,
  config: SigilHookConfig,
): Promise<null | { blocked: true; rejection: SigilRejectionContext }> {
  const intent: SigilIntent = {
    action: action.name.toLowerCase(),
    metadata: action.params,
  };

  const result = await checkIntent(intent, config);
  if (result.decision === 'APPROVED') return null;

  return {
    blocked: true,
    rejection: buildRejectionContext(result, action.name),
  };
}
