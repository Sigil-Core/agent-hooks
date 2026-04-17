// src/rejection.ts
import type { SigilHookResult, SigilRejectionContext } from './types.js';

export function buildRejectionContext(
  result: SigilHookResult,
  action: string,
): SigilRejectionContext {
  if (result.decision === 'PENDING') {
    return {
      sigil_decision: 'PENDING',
      sigil_error_code: 'SIGIL_CONSENSUS_HOLD_REQUIRED',
      sigil_message: result.message ?? 'Action requires human approval.',
      sigil_hold_id: result.holdId,
      sigil_policy_hash: result.policyHash,
      sigil_action_taken: 'pending_approval',
      sigil_next_steps:
        'This action has been paused for human review. Do not retry. ' +
        'Notify the operator via Sigil Command.',
    };
  }

  if (result.errorCode === 'SIGIL_UNREACHABLE') {
    return {
      sigil_decision: 'DENIED',
      sigil_error_code: 'SIGIL_UNREACHABLE',
      sigil_message: result.message ?? 'Sigil policy service unreachable.',
      sigil_policy_hash: result.policyHash,
      sigil_action_taken: 'halted',
      sigil_next_steps:
        'Sigil is temporarily unreachable — transient infrastructure failure, not a policy decision. ' +
        'Pause and retry this action when connectivity to Sigil is restored. ' +
        'No policy was violated; do not file an operator report.',
    };
  }

  return {
    sigil_decision: 'DENIED',
    sigil_error_code: result.errorCode ?? 'SIGIL_POLICY_VIOLATION',
    sigil_message: result.message ?? 'Action blocked by Sigil policy.',
    sigil_policy_hash: result.policyHash,
    sigil_action_taken: 'halted',
    sigil_next_steps:
      `The action "${action}" was blocked. ` +
      'Do not attempt to reframe or retry this action. ' +
      'Report the violation to the operator.',
  };
}
