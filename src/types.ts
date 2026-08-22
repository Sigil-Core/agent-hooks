// src/types.ts

import type {
  AuthorizationCapability,
  DecisionJwk,
  DecisionVerificationMode,
  DecisionVerificationReason,
} from './decision.js';

export type SigilDecision = 'ALLOWED' | 'DENIED' | 'PENDING';

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

// Cowork adapter error codes (additive, 0.7.0). Each maps to exactly one
// failure class; the strict-reader map lives in src/strict-json.ts.
/** A matched tool name absent from the versioned governed-tool inventory. */
export const SIGIL_TOOL_UNCLASSIFIED = 'SIGIL_TOOL_UNCLASSIFIED' as const;
/** A Sign response that failed strict schema validation. Never an approval. */
export const SIGIL_RESPONSE_INVALID = 'SIGIL_RESPONSE_INVALID' as const;
/** HTTP 429 from Sign, denied fast rather than retried in line. */
export const SIGIL_RATE_LIMITED = 'SIGIL_RATE_LIMITED' as const;
/** A policy-bearing value over its byte cap. Rejected, never truncated. */
export const SIGIL_INPUT_OVERSIZE = 'SIGIL_INPUT_OVERSIZE' as const;
/** Duplicate object key detected by the strict JSON reader on raw bytes. */
export const SIGIL_INPUT_DUPLICATE_KEY = 'SIGIL_INPUT_DUPLICATE_KEY' as const;
/** Required configuration (API key) absent; denied before any network call. */
export const SIGIL_CONFIG_MISSING = 'SIGIL_CONFIG_MISSING' as const;
/** Internal wrapper failure; enforcement could not complete. */
export const SIGIL_HOOK_INTERNAL = 'SIGIL_HOOK_INTERNAL' as const;
/** The wrapper's own process deadline fired before a decision. */
export const SIGIL_HOOK_TIMEOUT = 'SIGIL_HOOK_TIMEOUT' as const;
/** Syntactically invalid input: bad JSON, non-object root, depth past bound, or a prohibited numeric form. */
export const SIGIL_INPUT_MALFORMED = 'SIGIL_INPUT_MALFORMED' as const;
/** Input over the byte cap on the request (stdin) side. */
export const SIGIL_INPUT_TOO_LARGE = 'SIGIL_INPUT_TOO_LARGE' as const;
/** Input that is not valid UTF-8. */
export const SIGIL_INPUT_ENCODING = 'SIGIL_INPUT_ENCODING' as const;
/** The stdin read deadline elapsed before the payload arrived. */
export const SIGIL_INPUT_TIMEOUT = 'SIGIL_INPUT_TIMEOUT' as const;
/** A stream error while reading input. */
export const SIGIL_INPUT_ERROR = 'SIGIL_INPUT_ERROR' as const;

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

/**
 * Structured diagnostic emitted through `onDiagnostic` so a hook wrapper can
 * build its audit line from fields rather than by parsing the deny reason
 * string, which is prose intended for the agent and not a machine interface.
 */
export interface SigilDiagnostic {
  /** Absent for an excluded-tool skip, where no decision was made. */
  decision?: SigilDecision;
  errorCode?: string;
  holdId?: string;
  policyHash?: string;
  taskId?: string;
  toolName?: string;
  classification?: 'governed' | 'excluded' | 'unclassified';
  latencyMs?: number;
  /** Derived from the response shape: 'ok', 'unreachable', 'http_error', or 'not_attempted'. */
  reachability?: string;
  verificationReason?: DecisionVerificationReason;
  verificationMode?: DecisionVerificationMode;
  verificationSurface?: 'authorize' | 'test_run' | 'hold_resolve';
  consumerVersion?: string;
}

export interface SigilIntent {
  action: string;          // e.g. 'bash', 'web_fetch', 'http', 'file_write', 'wallet.transfer'
  /** Per-action authorization projection (Cowork adapter). Only named, capped fields; never the raw tool input. */
  arguments?: Record<string, unknown>;
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
  /**
   * Strict response validation (selected by the Cowork adapter): the body is
   * read under a 64 KiB cap with a read deadline, parsed by the strict JSON
   * reader, and only a strictly schema-valid allowed capability can approve.
   * Every other outcome denies. Default off; the default path is unchanged.
   */
  strictResponse?: boolean;
  /**
   * Decision-record verification mode. Defaults to `enforce`, which requires
   * verified, request-bound authorization and a policy pin. Explicit `warn`
   * is the package-rollback compatibility mode: missing or invalid signed
   * material is logged and may follow the legacy execution path with
   * `LegacyUnverifiedAuthorization`, which is not proof of verification.
   */
  decisionVerificationMode?: DecisionVerificationMode;
  /** Required policy binding before enforce mode can authorize execution. */
  expectedPolicyHash?: string;
  /** Static key pin. When present, network JWKS discovery is not used. */
  decisionRecordJwk?: DecisionJwk;
  /** Intent Attestation issuer. Defaults to the current Sign issuer, `sigil-core`. */
  attestationIssuer?: string;
  /** Propagated into fetch so an aborted caller deadline cancels the socket. */
  signal?: AbortSignal;
  /** Structured audit fields for hook wrappers; never throws outward. */
  onDiagnostic?: (diagnostic: SigilDiagnostic) => void;
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
  /** Compact intent attestation returned by Sign for an actual approval. */
  intentAttestation?: string;
  /** Opaque execution capability. Raw decision bodies never create one directly. */
  authorization?: AuthorizationCapability;
  /**
   * Atomic Policy 2.2 authorization material returned only for a covered
   * approval. Verify `compactJws` with Warrant Core before calling
   * `checkResult`; this SDK never treats the unverified wire payload as a
   * `VerifiedResponsePolicyV1`.
   */
  responsePolicy?: SigilResponsePolicyAuthorization;
  // Resolved task id used for this authorization check.
  taskId?: string;
  failOpen?: boolean;      // true when ALLOWED was returned via fail-open (not real policy evaluation)
}

export interface SigilResponsePolicyAuthorization {
  compactJws: string;
  compiledPolicyDigest: string;
  envelopeDigest: string;
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
