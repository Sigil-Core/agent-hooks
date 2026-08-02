// src/index.ts

export { checkIntent } from './interceptor.js';
export { buildAuthorizeRequestBody, serializeAuthorizeRequestBody } from './request.js';
export { buildRejectionContext } from './rejection.js';
export {
  checkModelBudget,
  clearModelUsage,
  getModelUsageReport,
  normalizeModelUsage,
  recordModelUsage,
} from './model-usage.js';
export { checkAnthropicToolUse } from './adapters/claude.js';
export { createCodexPreToolUseHook } from './adapters/codex.js';
export {
  COWORK_GOVERNED_TOOLS,
  COWORK_MAX_REQUEST_TIMEOUT_MS,
  COWORK_MIN_REQUEST_TIMEOUT_MS,
  COWORK_TOOL_MANIFEST,
  SIGIL_CANON_VERSION,
  canonicalize,
  clampCoworkTimeout,
  classifyCoworkTool,
  createCoworkPreToolUseHook,
  executionBindingDigest,
  policyProjectionDigest,
  projectArguments,
} from './adapters/cowork.js';
export { mapStrictJsonError, readStrictJson } from './strict-json.js';
export type {
  StrictJsonErrorClass,
  StrictJsonFailure,
  StrictJsonOk,
  StrictJsonOptions,
  StrictJsonResult,
} from './strict-json.js';
export { checkElizaAction } from './adapters/eliza.js';
export { createHermesPreToolCallHook } from './adapters/hermes.js';
export { wrapLangChainTool } from './adapters/langchain.js';
export { createOpenclawSigilHandler } from './adapters/openclaw.js';
export {
  createOpenRouterToolGate,
  recordOpenRouterModelUsageAndCheckBudget,
} from './adapters/openrouter.js';
export { checkAgentPayTransfer } from './adapters/agentpay.js';
export { FRAMEWORKS } from './framework-registry.js';
export {
  HTTP_METHODS,
  SIGIL_CONFIG_MISSING,
  SIGIL_HOOK_INTERNAL,
  SIGIL_HOOK_TIMEOUT,
  SIGIL_INPUT_DUPLICATE_KEY,
  SIGIL_INPUT_ENCODING,
  SIGIL_INPUT_ERROR,
  SIGIL_INPUT_MALFORMED,
  SIGIL_INPUT_OVERSIZE,
  SIGIL_INPUT_TIMEOUT,
  SIGIL_INPUT_TOO_LARGE,
  SIGIL_LIMIT_STORE_UNAVAILABLE,
  SIGIL_LOOP_LIMIT_EXCEEDED,
  SIGIL_MODEL_SPEND_LIMIT_EXCEEDED,
  SIGIL_MODEL_TOKEN_LIMIT_EXCEEDED,
  SIGIL_MODEL_USAGE_UNAVAILABLE,
  SIGIL_RATE_LIMITED,
  SIGIL_RESPONSE_INVALID,
  SIGIL_TOOL_UNCLASSIFIED,
  SIGIL_UNREACHABLE,
} from './types.js';
export type {
  HttpMethod,
  SigilHttpMethod,
  SigilDecision,
  SigilDiagnostic,
  SigilIntent,
  SigilHookConfig,
  SigilHookResult,
  SigilModelUsage,
  SigilModelUsageReport,
  SigilRejectionContext,
} from './types.js';
export type { AnthropicToolUseBlock } from './adapters/claude.js';
export type {
  CodexPreToolUseDenyResult,
  CodexPreToolUsePayload,
  CodexPreToolUseResult,
} from './adapters/codex.js';
export type {
  CanonicalDigestResult,
  CanonicalizeResult,
  CoworkPreToolUseDenyResult,
  CoworkPreToolUsePayload,
  CoworkPreToolUseResult,
  CoworkProjectionResult,
  CoworkToolClassification,
  CoworkToolInventoryEntry,
} from './adapters/cowork.js';
export type { ElizaAction } from './adapters/eliza.js';
export type {
  HermesPreToolCallBlock,
  HermesPreToolCallPayload,
  HermesPreToolCallResult,
} from './adapters/hermes.js';
export type {
  OpenclawBeforeToolCallEvent,
  OpenclawToolContext,
  OpenclawBeforeToolCallResult,
} from './adapters/openclaw.js';
export type {
  OpenRouterResponseLike,
  OpenRouterToolCall,
  OpenRouterToolGateAllowed,
  OpenRouterToolGateBlocked,
  OpenRouterToolGateResult,
  OpenRouterToolResultMessage,
} from './adapters/openrouter.js';
export type {
  AgentPayGuardApproved,
  AgentPayGuardBlocked,
  AgentPayGuardResult,
  AgentPayTransfer,
} from './adapters/agentpay.js';
export type { FrameworkDescriptor } from './framework-registry.js';
