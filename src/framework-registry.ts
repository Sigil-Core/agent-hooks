// src/framework-registry.ts

export interface FrameworkDescriptor {
  id: string;
  displayName: string;
  integrationType: 'adapter' | 'documentation';
  language: 'typescript' | 'rust';
  adapterExport?: string;
  notes?: string;
}

export const FRAMEWORKS: Record<string, FrameworkDescriptor> = {
  'agent-hooks': {
    id: 'agent-hooks',
    displayName: 'Generic (checkIntent)',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'checkIntent',
  },
  'anthropic-sdk': {
    id: 'anthropic-sdk',
    displayName: 'Claude Code / Anthropic SDK',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'checkAnthropicToolUse',
  },
  eliza: {
    id: 'eliza',
    displayName: 'ELIZA',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'checkElizaAction',
  },
  langchain: {
    id: 'langchain',
    displayName: 'LangChain',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'wrapLangChainTool',
  },
  openclaw: {
    id: 'openclaw',
    displayName: 'OpenClaw',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createOpenclawSigilHandler',
    notes: 'Registers as a before_tool_call plugin hook. Maps PENDING to a block so Sigil holds cannot be bypassed by local approval.',
  },
  nemoclaw: {
    id: 'nemoclaw',
    displayName: 'NVIDIA NemoClaw',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createOpenclawSigilHandler',
    notes: 'Inherits OpenClaw hook surface; same adapter covers both.',
  },
  ironclaw: {
    id: 'ironclaw',
    displayName: 'IronClaw (nearai)',
    integrationType: 'documentation',
    language: 'rust',
    notes: 'Rust framework; native Hook-trait integration ships from the companion agent-hooks-rs crates.',
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes Agent',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createHermesPreToolCallHook',
    notes: 'Normalizes Hermes pre_tool_call payloads and returns the Hermes block shape.',
  },
  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createCodexPreToolUseHook',
    notes: 'Normalizes Codex PreToolUse payloads and returns the documented hookSpecificOutput deny shape.',
  },
  cowork: {
    id: 'cowork',
    displayName: 'Cowork',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createCoworkPreToolUseHook',
    notes: 'Maps PENDING to a deny so Sigil holds cannot be bypassed by local approval; never emits ask or defer. Forces failMode: "closed" and framework: "cowork" unconditionally. Coverage is the versioned COWORK_GOVERNED_TOOLS inventory while the hook process runs to completion (the measured completion boundary); payload contract pinned by the 2026-08-02 Phase A capture.',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'createOpenRouterToolGate',
    notes: 'Gates OpenRouter tool_calls and can record response usage before model-budget checks.',
  },
  agentpay: {
    id: 'agentpay',
    displayName: 'AgentPay (WLFI)',
    integrationType: 'adapter',
    language: 'typescript',
    adapterExport: 'checkAgentPayTransfer',
    notes: 'Normalizes wallet.transfer fields and forces failMode: "closed" for value-transfer checks.',
  },
} as const;
