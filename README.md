# @sigilcore/agent-hooks

PreToolUse interceptor for autonomous AI agents. Intercepts an agent's intended tool call **before** it executes, submits it to the Sigil Sign `/v1/authorize` endpoint, and blocks or holds the action based on the policy decision. Works with Claude Code, ELIZA, LangChain, or any framework via the generic `checkIntent` API.

## Installation

```bash
npm install @sigilcore/agent-hooks
```

## Prerequisites

You need a Sigil API key. Get one at [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys).

## Quick Start

### Claude Code / Anthropic SDK

```typescript
import { checkAnthropicToolUse } from '@sigilcore/agent-hooks';

const config = {
  apiKey: process.env.SIGIL_API_KEY!,
  agentId: 'my-claude-agent',
};

// In your PreToolUse hook:
const rejection = await checkAnthropicToolUse(toolUseBlock, config);
if (rejection) {
  // Feed rejection back to Claude as a tool_result error
  return rejection;
}
// Otherwise, let the tool execute normally
```

### ELIZA

```typescript
import { checkElizaAction } from '@sigilcore/agent-hooks';

const config = {
  apiKey: process.env.SIGIL_API_KEY!,
  agentId: 'my-eliza-agent',
};

// Before any ELIZA action:
const blocked = await checkElizaAction({ name: 'SEND_TOKEN', params: { to: '0x...', amount: '1.0' } }, config);
if (blocked) {
  console.error('Blocked by Sigil:', blocked.rejection);
  return;
}
```

### LangChain

```typescript
import { wrapLangChainTool } from '@sigilcore/agent-hooks';

const config = {
  apiKey: process.env.SIGIL_API_KEY!,
  agentId: 'my-langchain-agent',
};

// Wrap any LangChain tool:
const safeTool = wrapLangChainTool(myTool, config);
// safeTool.call() now checks Sigil policy before executing
```

### OpenClaw / NemoClaw

`@sigilcore/agent-hooks` ships a native plugin hook handler for OpenClaw's `before_tool_call` API. NemoClaw uses the same hook, so one adapter covers both.

```typescript
import { createOpenclawSigilHandler } from '@sigilcore/agent-hooks';

const sigilHandler = createOpenclawSigilHandler({
  apiKey: process.env.SIGIL_API_KEY!,
  agentId: 'my-openclaw-agent',
  failMode: 'closed', // recommended for production
});

// In your OpenClaw plugin manifest:
plugin.api.on('before_tool_call', sigilHandler);
```

Sigil `DENIED` decisions (including `SIGIL_UNREACHABLE` in closed mode) surface as OpenClaw tool blocks with the rejection reason. Sigil `PENDING` decisions surface through OpenClaw's native approval UI — no custom handling required.

## Works With AgentPay (WLFI)

> **For `wallet.*` actions, always set `failMode: 'closed'`.** A fail-open authorization layer in front of on-chain value transfer is strictly worse than no policy layer at all — it claims enforcement it cannot deliver, so operators relax downstream controls trusting Sigil.

[AgentPay SDK](https://github.com/World-Liberty-Financial-X) enables AI agents to hold and spend USD1 on EVM chains. `@sigilcore/agent-hooks` is fully compatible — no additional configuration needed.

When an AgentPay agent executes a USD1 transfer on Ethereum (chainId 1) or BNB Smart Chain (chainId 56), the `wallet.transfer` or `wallet_sign` action routes through your Sigil policy before the transaction is signed.

```typescript
import { checkIntent } from '@sigilcore/agent-hooks';

// AgentPay initiates a USD1 transfer — Sigil evaluates policy first
const result = await checkIntent(
  {
    action: 'wallet.transfer',
    chainId: 1,                          // Ethereum mainnet
    to: '0xRecipientAddress',
    amount: '1000000000000000000',       // 1 USD1 in wei
    txCommit: sha256(rawTx),
  },
  {
    ...config,
    failMode: 'closed',                  // required for wallet.* actions
  },
);

if (result.decision !== 'APPROVED') {
  // Block the AgentPay transfer — policy not satisfied
  return buildRejectionContext(result, 'wallet.transfer');
}
// AgentPay proceeds with signing
```

**The layers are additive:** AgentPay handles payment mechanics and key management. Sigil determines whether the agent is authorized to initiate the payment at all. AgentPay tells agents how to spend. Sigil tells agents what they're allowed to do.

USD1 contract address: `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` (Ethereum + BSC)

## Works With IronClaw

[IronClaw](https://github.com/nearai/ironclaw) is a Rust agent orchestration framework. The TypeScript package does not embed directly in a Rust process; integrate from the dispatch host (the TypeScript service that submits jobs to IronClaw over HTTP or MCP):

```typescript
import { checkIntent, buildRejectionContext } from '@sigilcore/agent-hooks';

// Before submitting a tool call to IronClaw's HTTP / MCP interface:
const result = await checkIntent(
  { action: 'bash', command: toolCall.args.command, agentId: 'ironclaw-agent' },
  { apiKey: process.env.SIGIL_API_KEY!, framework: 'ironclaw', failMode: 'closed' },
);
if (result.decision !== 'APPROVED') {
  // Do not dispatch; feed the rejection back to the upstream caller.
  return buildRejectionContext(result, 'bash');
}
// Proceed with IronClaw dispatch.
```

Native in-process integration (implementing IronClaw's `Hook` trait) is scheduled for a separate Rust crate, `@sigilcore/agent-hooks-rs`.

## Supported Frameworks

| Framework | Adapter | Language | Integration |
|---|---|---|---|
| Claude Code / Anthropic SDK | `checkAnthropicToolUse` | TS | Adapter |
| ELIZA | `checkElizaAction` | TS | Adapter |
| LangChain | `wrapLangChainTool` | TS | Adapter |
| OpenClaw | `createOpenclawSigilHandler` | TS | Adapter |
| NVIDIA NemoClaw | `createOpenclawSigilHandler` | TS | Adapter (via OpenClaw) |
| IronClaw (nearai) | — | Rust | Documentation (crate forthcoming) |
| AgentPay (WLFI) | — | TS | Documentation |

The typed registry lives at [`src/framework-registry.ts`](./src/framework-registry.ts) and is exported as `FRAMEWORKS`.

## Graceful Agent Degradation

When an action is blocked, the package returns a typed JSON rejection context that agents can understand:

```json
{
  "sigil_decision": "DENIED",
  "sigil_error_code": "SIGIL_BASH_BLOCKED",
  "sigil_message": "rm -rf is not allowed by policy",
  "sigil_policy_hash": "abc123def456",
  "sigil_action_taken": "halted",
  "sigil_next_steps": "The action \"bash\" was blocked. Do not attempt to reframe or retry this action. Report the violation to the operator."
}
```

For held actions:

```json
{
  "sigil_decision": "PENDING",
  "sigil_error_code": "SIGIL_CONSENSUS_HOLD_REQUIRED",
  "sigil_message": "Email requires human approval",
  "sigil_hold_id": "hold_abc123",
  "sigil_policy_hash": "abc123def456",
  "sigil_action_taken": "pending_approval",
  "sigil_next_steps": "This action has been paused for human review. Do not retry. Notify the operator via Sigil Command."
}
```

For transient unreachability (only surfaces when `failMode: 'closed'`):

```json
{
  "sigil_decision": "DENIED",
  "sigil_error_code": "SIGIL_UNREACHABLE",
  "sigil_message": "ECONNREFUSED",
  "sigil_action_taken": "halted",
  "sigil_next_steps": "Sigil is temporarily unreachable — transient infrastructure failure, not a policy decision. Pause and retry this action when connectivity to Sigil is restored. No policy was violated; do not file an operator report."
}
```

## Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `apiKey` | `string` | Yes | — | Sigil API key (`sk_sigil_...`) |
| `apiUrl` | `string` | No | `https://sign.sigilcore.com` | Sigil Sign API URL |
| `agentId` | `string` | No | `'agent'` | Identifier for this agent |
| `framework` | `string` | No | `'agent-hooks'` | Framework identifier — see [`FRAMEWORKS`](./src/framework-registry.ts) |
| `failMode` | `'open' \| 'closed'` | No | `'open'` | Behavior when Sigil is unreachable — see Fail Modes below |
| `requestTimeoutMs` | `number` | No | `10000` | Request timeout in milliseconds |
| `onDenied` | `function` | No | — | Callback when action is denied |
| `onPending` | `function` | No | — | Callback when action is held |
| `onError` | `function` | No | — | Callback on network error |

## Fail Modes

When the Sigil Sign API is unreachable — network partition, DNS failure, connection refused, request timeout, 5xx response, or a non-JSON body — `@sigilcore/agent-hooks` either fails open or fails closed based on `config.failMode`.

### `failMode: 'open'` (default)

Returns `{ decision: 'APPROVED', failOpen: true, message: 'Sigil unreachable — fail open' }` plus a `warn`-level JSON log line (`event: 'sigil_hook_unreachable'`).

**Use when:** development, non-financial workflows, general-purpose agents where a brief Sigil outage should not halt operations.

### `failMode: 'closed'`

Returns `{ decision: 'DENIED', errorCode: 'SIGIL_UNREACHABLE', message: <cause> }` plus an `error`-level JSON log line. The returned error code is **distinct** from policy denial — hosts can branch on it to emit transient-failure telemetry rather than policy-violation telemetry. `buildRejectionContext` produces next-step guidance that tells the agent to pause and retry when connectivity is restored, not to report a policy violation.

**Use when:** production agents, externally-visible actions (email sending, customer messages), and — **required** — any on-chain or wallet-related action.

### When to pick which

| Scenario | Recommended |
|---|---|
| Local dev / non-financial | `'open'` |
| Production, general-purpose | `'closed'` |
| Production, externally visible (email.send, messaging) | `'closed'` |
| Production, financial or on-chain (`wallet.*`) | `'closed'` (required — see AgentPay section) |

### Distinguishing fail-open from real policy evaluation

In `failMode: 'open'`, an `APPROVED` result sets `failOpen: true` when it came from the fallback path. Real policy evaluations leave `failOpen` unset. Hosts that need to distinguish the two in telemetry should branch on `result.failOpen`.

### Behavior change from v0.1.0

In v0.1.0, a `5xx` response with a valid-but-empty JSON body surfaced as `DENIED` + `SIGIL_POLICY_VIOLATION` (misleading — it was a server failure, not a policy decision). In v0.2.0, `5xx` routes through the same unreachability path as network errors: `APPROVED + failOpen: true` in open mode, `DENIED + SIGIL_UNREACHABLE` in closed.

## Documentation

Full documentation: [docs.sigilcore.com](https://docs.sigilcore.com)

Get an API key: [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys)

## License

MIT
