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
    notes: 'Registers as a before_tool_call plugin hook. Maps PENDING to native requireApproval.',
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
    notes: 'Rust framework; TS integration via HTTP/MCP dispatch host. Native Hook-trait integration queued for @sigilcore/agent-hooks-rs.',
  },
  agentpay: {
    id: 'agentpay',
    displayName: 'AgentPay (WLFI)',
    integrationType: 'documentation',
    language: 'typescript',
    notes: 'No hook surface; integrate by wrapping checkIntent around wallet.* actions in the host. Always use failMode: "closed".',
  },
} as const;
