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

Sigil `DENIED` decisions (including `SIGIL_UNREACHABLE` in closed mode) surface as OpenClaw tool blocks with the rejection reason. Sigil `PENDING` decisions also surface as blocks — with `SIGIL_CONSENSUS_HOLD_REQUIRED` and the `hold_id` included in `blockReason` — so a hold can only be resolved out of band through Sigil Command. The adapter deliberately does **not** surface `PENDING` through OpenClaw's local approval UI, because local approval would let a host user run the tool without the Sigil hold ever being resolved, bypassing enforcement.

## Works With AgentPay (WLFI)

> **For `wallet.*` actions, always set `failMode: 'closed'`.** A fail-open authorization layer in front of on-chain value transfer is strictly worse than no policy layer at all — it claims enforcement it cannot deliver, so operators relax downstream controls trusting Sigil.

[AgentPay SDK](https://github.com/World-Liberty-Financial-X) enables AI agents to hold and spend USD1 on EVM chains. `@sigilcore/agent-hooks` is fully compatible — no additional configuration needed.

When an AgentPay agent executes a USD1 transfer on Ethereum (chainId 1) or BNB Smart Chain (chainId 56), the `wallet.transfer` or `wallet_sign` action routes through your Sigil policy before the transaction is signed.

```typescript
import { checkAgentPayTransfer } from '@sigilcore/agent-hooks';

// AgentPay initiates a USD1 transfer — Sigil evaluates policy first
const result = await checkAgentPayTransfer({
  chainId: 1,                            // Ethereum mainnet
  recipient: '0xRecipientAddress',
  amount: '1000000000000000000',         // 1 USD1 in wei
  txCommit: sha256(rawTx),
  token: 'USD1',
}, config);

if (!result.approved) {
  // Block the AgentPay transfer — policy not satisfied
  return result.rejection;
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

Native in-process integration (implementing IronClaw's `Hook` trait) ships as [`sigil-agent-hooks-ironclaw`](https://github.com/Sigil-Core/agent-hooks-rs) in the companion Rust repository.

## Supported Frameworks

| Framework | Adapter | Language | Integration |
|---|---|---|---|
| Claude Code / Anthropic SDK | `checkAnthropicToolUse` | TS | Adapter |
| ELIZA | `checkElizaAction` | TS | Adapter |
| LangChain | `wrapLangChainTool` | TS | Adapter |
| OpenClaw | `createOpenclawSigilHandler` | TS | Adapter |
| NVIDIA NemoClaw | `createOpenclawSigilHandler` | TS | Adapter (via OpenClaw) |
| IronClaw (nearai) | [`sigil-agent-hooks-ironclaw`](https://github.com/Sigil-Core/agent-hooks-rs) | Rust | Adapter |
| OpenAI Codex | `createCodexPreToolUseHook` | TS | Adapter |
| Hermes Agent | `createHermesPreToolCallHook` | TS | Adapter |
| OpenRouter | `createOpenRouterToolGate` | TS | Adapter |
| AgentPay (WLFI) | `checkAgentPayTransfer` | TS | Adapter |

The typed registry lives at [`src/framework-registry.ts`](./src/framework-registry.ts) and is exported as `FRAMEWORKS`.

## Typed HTTP intents

The v2 policy profile uses `action: "http"` only when an adapter receives an
explicit, uppercase HTTP method (`GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`,
`PATCH`, or `DELETE`) in a known HTTP/web tool input. The adapters never infer
`GET`. Methodless web calls continue to use the legacy `web_fetch` action, so
existing policies remain compatible.

An explicit non-empty method that is not in the supported set still selects the
typed `http` profile, but the invalid method is omitted from the wire intent.
Sigil Sign then rejects the incomplete typed request instead of silently
downgrading it to an untyped fetch. A `method` field attached to an unrelated
tool is not promoted.

The method-bearing extraction surface is intentionally narrow:

| Adapter | HTTP method source |
|---|---|
| Claude / Anthropic | `WebFetch` / `WebSearch` input `method` |
| Codex | `http` and known web tool input `method` |
| Hermes | known web tool input `method` |
| OpenRouter | mapped web function arguments `method` |
| OpenClaw | known web tool params `method` |
| ELIZA | `http` / known web action params `method` |
| LangChain | JSON object input for `http` / known web tool names |
| AgentPay | EVM transfer adapter; never an HTTP intent |

For high-stakes actions, keep `failMode: "closed"` so a Sign validation or
connectivity failure cannot release the underlying tool call.

## ERC-20 calldata enrichment

For `contract.call` intents, a trusted shim (`decodeErc20Calldata`,
[`src/evm-calldata.ts`](./src/evm-calldata.ts)) decodes the 4-byte selector and,
for the ERC-20 set, attaches the decoded values as `metadata.evm` so a token cap
can bind to what the calldata already claims. The decode never widens authority —
it only exposes the call's own arguments — and Sigil Sign trusts `metadata.evm`
only on shim-provenance submissions: any caller-supplied `evm` key is stripped
before the shim's decode is merged.

| Selector | Function | Decoded fields (besides `selector` + `token_target`) |
|---|---|---|
| `0xa9059cbb` | `transfer(address,uint256)` | `recipient`, `token_amount` |
| `0x23b872dd` | `transferFrom(address,address,uint256)` | `recipient`, `token_amount` |
| `0x095ea7b3` | `approve(address,uint256)` | `spender`, `token_amount` |
| `0x39509351` | `increaseAllowance(address,uint256)` | `spender`, `token_amount` |
| `0xd505accf` | `permit(address,address,uint256,...)` | `spender`, `token_amount` |

`token_target` is the call's `to` / `targetAddress`; `token_amount` is emitted in
base units as a decimal string. A selector outside this set emits selector-only
metadata (`{ selector }`) so a strict policy can deny it, and a partial decode
(any argument word that does not decode cleanly) collapses to selector-only as
well — the shim never emits a guessed value. The raw calldata is also passed
through as `SigilIntent.calldata` (normalized to lowercase, even-length,
`0x`-prefixed hex) on the `/v1/authorize` body, where Sign binds and validates it
before use.

Out of scope by design (documented residuals): proxy contracts, multicall
unwrapping, and non-ERC-20 token standards.

### EVM native-value precedence

An EVM intent carries `amount` only when the tool input can prove one. The field
that wins depends on the action:

- **`contract.call`** — an explicit `value` (native value attached to the call)
  takes precedence and falls back to `amount`.
- **`wallet.transfer`** and other EVM actions — `amount` takes precedence and
  falls back to `value`.

Supplied amounts pass through verbatim: canonical decimal strings are kept,
non-negative safe-integer numbers are stringified, and JSON-RPC hex quantities
(`0x0`, `0xde0b6b3a7640000`) are converted exactly to their decimal base-unit
value. Negative, fractional, exponent, or unsafe-integer representations are
rejected.

When the higher-precedence field is missing or malformed, `amount` is left absent
**on purpose** — the adapter never invents `"0"`, because it cannot prove that an
alternate field (e.g. `valueWei`, `tx.value`) is not carrying native value. Sigil
Sign then denies the intent with `LEX_AMOUNT_REQUIRED` under Policy 2.1 (and under
the `SIGIL_EVM_AMOUNT_REQUIRED` deployment flag for legacy policies) rather than
letting an unknown value pass under the cap.

## Model Budget Brakes

Execution Limits v2 model budgets are enforced through cumulative
`metadata.model_usage` reports on `model.inference` checks. Hosts record provider
usage after model calls, then ask Sigil Sign whether the signed per-task spend or
token cap still allows the task to continue.

```typescript
import {
  buildRejectionContext,
  checkModelBudget,
  recordModelUsage,
} from '@sigilcore/agent-hooks';

recordModelUsage({
  provider: 'anthropic',
  model: 'claude-sonnet-4',
  inputTokens: 100,
  outputTokens: 25,
  estimatedSpendUsd: '0.25',
}, config);

const budget = await checkModelBudget(config);
if (budget.decision !== 'APPROVED') {
  return buildRejectionContext(budget, 'model.inference');
}
```

OpenRouter hosts can use `recordOpenRouterModelUsageAndCheckBudget(response,
config)` to record response usage and check the budget in one call.
`createOpenRouterToolGate` defaults to fail closed when `config.failMode` is not
set, so malformed or unreachable tool checks return a structured denial instead
of letting the host execute the call.

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
