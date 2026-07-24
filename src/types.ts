// src/types.ts

export type SigilDecision = 'APPROVED' | 'DENIED' | 'PENDING';

/** HTTP methods accepted by the typed `http` intent profile. */
export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type SigilHttpMethod = HttpMethod;

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
export const SIGIL_MODEL_SPEND_LIMIT_EXCEEDED = 'SIGIL_MODEL_SPEND_LIMIT_EXCEEDED' as const;
export const SIGIL_MODEL_TOKEN_LIMIT_EXCEEDED = 'SIGIL_MODEL_TOKEN_LIMIT_EXCEEDED' as const;
export const SIGIL_MODEL_USAGE_UNAVAILABLE = 'SIGIL_MODEL_USAGE_UNAVAILABLE' as const;

export interface SigilModelUsage {
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedSpendUsd?: string;
}

export interface SigilModelUsageReport {
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens: number;
  estimated_spend_usd?: string;
}

export interface SigilIntent {
  action: string;          // e.g. 'bash', 'web_fetch', 'http', 'file_write', 'wallet.transfer'
  agentId?: string;
  chainId?: number;        // EVM only
  command?: string;        // bash only
  url?: string;            // web_fetch/http only
  method?: HttpMethod;     // typed http only; adapters never infer GET
  path?: string;           // file_write only
  to?: string;             // wallet.transfer only
  amount?: string;         // EVM actions — native value in base units as a string; absent when no amount is proven (Sign fails closed)
  calldata?: string;       // contract.call only — raw 0x-prefixed calldata
  txCommit?: string;       // EVM: SHA-256 hex of the raw tx, no 0x prefix
  taskId?: string;         // Stable task/session id for hard loop ceilings
  metadata?: Record<string, unknown>;
  modelUsage?: SigilModelUsageReport;
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
