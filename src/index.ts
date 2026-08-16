// src/index.ts

export { checkIntent } from './interceptor.js';
export { checkResult } from './check-result.js';
export {
  verifyAndCheckResult,
  verifyResponsePolicyAuthorization,
  verifyResponsePolicyAuthorizationV2,
} from './response-policy.js';
export {
  SCANNER_PROTOCOL_VERSION,
  checkResultV2,
} from './scanner.js';
export {
  DETERMINISTIC_RULESET_V1,
  DETERMINISTIC_RULESET_V1_DIGEST,
  RESPONSE_CLASS_CATALOG_V1,
  RESPONSE_CLASS_CATALOG_V1_DIGEST,
} from './check-result.js';
export type {
  CompiledResponsePolicyVerificationContext,
  CryptoAdapter,
  VerifiedCompiledResponsePolicyFormat1,
  VerifiedCompiledResponsePolicyFormat2,
  VerifyAndCheckResultInput,
} from './response-policy.js';
export type {
  AuthenticatedScannerTransport,
  CheckResultV2Input,
  ResponseDecisionReasonV2,
  ResponseDecisionV2,
  ResponseFindingV2,
  ResponseRedactionSpanV1,
  ScannerClientConfig,
  ScannerEvidenceV1,
  ScannerFailureReason,
  ScannerRequestV1,
  ScannerTransportResult,
} from './scanner.js';
export {
  CALL_TOOL_RESULT_CONTENT_TYPE,
  MAX_RESULT_NESTING_DEPTH,
  MAX_RESULT_PROJECTION_BYTES,
  RESULT_PROJECTION_CONTENT_TYPE,
  RESULT_PROJECTION_VERSION,
  projectCallToolResult,
} from './result-projection.js';
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
  CheckResultInput,
  ResponseClass,
  ResponseDecisionReason,
  ResponseDecisionV1,
  ResponseFinding,
  TrustedResultBindings,
  VerifiedResponsePolicyV1,
} from './check-result.js';
export type {
  ProjectCallToolResult,
  ResultProjectionFailureReason,
  ResultProjectionRecord,
  ResultProjectionV1,
} from './result-projection.js';
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
  SigilResponsePolicyAuthorization,
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
