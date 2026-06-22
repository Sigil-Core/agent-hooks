// src/types.ts

export type SigilDecision = 'APPROVED' | 'DENIED' | 'PENDING';

export const SIGIL_UNREACHABLE = 'SIGIL_UNREACHABLE' as const;
/**
 * Returned when Sigil denies a tool call because an execution limit ceiling was
 * exceeded for the resolved task id or API-key hour bucket.
 */
export const SIGIL_LOOP_LIMIT_EXCEEDED = 'SIGIL_LOOP_LIMIT_EXCEEDED' as const;
/**
 * Returned when Sigil cannot reach the execution-limit counter store and fails
 * closed instead of allowing an unbounded tool loop.
 */
export const SIGIL_LIMIT_STORE_UNAVAILABLE = 'SIGIL_LIMIT_STORE_UNAVAILABLE' as const;

export interface SigilIntent {
  action: string;          // e.g. 'bash', 'web_fetch', 'file_write', 'wallet.transfer'
  agentId?: string;
  chainId?: number;        // EVM only
  command?: string;        // bash only
  url?: string;            // web_fetch only
  path?: string;           // file_write only
  to?: string;             // wallet.transfer only
  amount?: string;         // wallet.transfer only — wei as string
  txCommit?: string;       // EVM: SHA-256 hex of the raw tx, no 0x prefix
  taskId?: string;         // Stable task/session id for hard loop ceilings
  metadata?: Record<string, unknown>;
}

export interface SigilHookConfig {
  apiKey: string;          // sk_sigil_... from sigilcore.com/tools/keys
  apiUrl?: string;         // default: https://sign.sigilcore.com
  agentId?: string;        // default: 'agent'
  framework?: string;      // default: 'agent-hooks' — see framework-registry.ts
  taskId?: string;         // default: generated once per process/session
  failMode?: 'open' | 'closed';    // default: 'open'
  requestTimeoutMs?: number;       // default: 10_000
  onDenied?: (intent: SigilIntent, reason: string) => void;
  onPending?: (intent: SigilIntent, holdId: string) => void;
  onError?: (intent: SigilIntent, error: Error) => void;
}

export interface SigilHookResult {
  decision: SigilDecision;
  holdId?: string;
  errorCode?: string;
  message?: string;
  policyHash?: string;
  // Resolved task id used for this authorization check.
  taskId?: string;
  failOpen?: boolean;      // true when APPROVED was returned via fail-open (not real policy evaluation)
}

// Graceful Agent Degradation — typed JSON fed back to the agent context
// when an action is blocked, so the agent understands WHY.
export interface SigilRejectionContext {
  sigil_decision: 'DENIED' | 'PENDING';
  sigil_error_code: string;
  sigil_message: string;
  sigil_hold_id?: string;
  sigil_policy_hash?: string;
  // Present when a rejection is tied to a concrete execution-limit task id.
  sigil_task_id?: string;
  sigil_action_taken: 'halted' | 'pending_approval';
  sigil_next_steps: string;
}
