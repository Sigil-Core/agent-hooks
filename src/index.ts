// src/index.ts

export { checkIntent } from './interceptor.js';
export { buildAuthorizeRequestBody, serializeAuthorizeRequestBody } from './request.js';
export { buildRejectionContext } from './rejection.js';
export { checkAnthropicToolUse } from './adapters/claude.js';
export { checkElizaAction } from './adapters/eliza.js';
export { wrapLangChainTool } from './adapters/langchain.js';
export { createOpenclawSigilHandler } from './adapters/openclaw.js';
export { FRAMEWORKS } from './framework-registry.js';
export { SIGIL_UNREACHABLE } from './types.js';
export type {
  SigilDecision,
  SigilIntent,
  SigilHookConfig,
  SigilHookResult,
  SigilRejectionContext,
} from './types.js';
export type { AnthropicToolUseBlock } from './adapters/claude.js';
export type { ElizaAction } from './adapters/eliza.js';
export type {
  OpenclawBeforeToolCallEvent,
  OpenclawToolContext,
  OpenclawBeforeToolCallResult,
} from './adapters/openclaw.js';
export type { FrameworkDescriptor } from './framework-registry.js';
