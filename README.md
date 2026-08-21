# @sigilcore/agent-hooks

PreToolUse interceptor for autonomous AI agents. Intercepts an agent's intended tool call **before** it executes, submits it to the Sigil Sign `/v1/authorize` endpoint, and blocks or holds the action based on the policy decision. Works with Claude Code, ELIZA, LangChain, or any framework via the generic `checkIntent` API.

## Installation

```bash
npm install @sigilcore/agent-hooks
```

## Prerequisites

You need a Sigil API key. Get one at [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys).

## MCP result inspection (Policy 2.2)

Policy 2.2 adds a separate, fail-closed result API. `checkIntent` remains the
pre-execution authorization call. After a covered MCP `tools/call` completes,
use `projectCallToolResult` and `checkResult` before forwarding the result:

For a covered approval, `checkIntent` returns `responsePolicy.compactJws`, its
compiled-payload digest, its envelope digest, and the separate
`intentAttestation`. The three response-policy fields are atomic: a partial or
malformed triple is a protocol denial, never a transport fail-open. Verify the compact JWS
with exact `@sigilcore/warrant-core` `0.4.0` and trusted issuer, key, tenant,
task, policy-hash, revocation, ruleset, catalog, and clock context before
passing the resulting verified payload to `checkResult`. The SDK never labels
untrusted authorization JSON as verified policy.

```typescript
import {
  CALL_TOOL_RESULT_CONTENT_TYPE,
  projectCallToolResult,
  verifyAndCheckResult,
} from '@sigilcore/agent-hooks';
import { createNodeCryptoAdapter } from '@sigilcore/warrant-core/crypto/node';

const projected = projectCallToolResult(callToolResult);
if (!projected.ok) {
  // Disclosure is denied. Do not forward the upstream result.
  throw new Error(`Result disclosure denied: ${projected.reason}`);
}

const decision = await verifyAndCheckResult({
  adapter: createNodeCryptoAdapter(),
  authorization: authorization.responsePolicy,
  // Build this only from trusted local/operator state. Never copy issuer,
  // key, tenant, task, policy, revocation, catalog, or time claims out of the
  // compact JWS into this context.
  trustedContext,
  result: {
    trustedBindings: {
      authorizationBinding,
      executionId,
      requestIdDigest,
      requestDigest,
      resultDigest,
      projectionDigest: projected.projection.digest,
    },
    authorizationBinding,
    executionId,
    requestIdDigest,
    requestDigest,
    resultDigest,
    contentType: CALL_TOOL_RESULT_CONTENT_TYPE,
    idempotencyKey,
    tool: `${trustedServerId}.${sdkToolName}`,
    tenantId,
    taskId,
    policyHash,
    projection: projected.projection,
  },
});

if (decision.disposition !== 'ALLOW') {
  // The upstream action may already have completed; deny result disclosure.
  throw new Error(`Result disclosure denied: ${decision.reason}`);
}
```

`projectCallToolResult` uses the frozen `sof-rp-projection-v1` framing and
rejects binary, mixed, unknown, over-depth, and over-16-MiB results. It
inspects text blocks, embedded resource text, resource-link strings, and
canonical `structuredContent`; `isError: true` follows the same path.

`checkResult` validates every execution, request, tenant, task, tool, policy,
content, and projection binding, then runs the pinned
`sof-response-rules-v1` rules and exact response literals locally. It performs
no network request and has no logging, diagnostic callback, telemetry, or
hosted receipt path. Response bytes stay inside the caller's process. A
missing, malformed, unsupported, expired, mismatched, oversized, or
evaluator-failed covered result must not forward, regardless of the general
`checkIntent` fail mode.

`verifyResponsePolicyAuthorization` is also exported when preparation and
evaluation must be separate. It returns Warrant Core's verified payload only
after the compact JWS, canonical payload bytes, signature, issuer, key,
audience, scope, tenant, task, policy hash, revocation epoch, catalog digests,
lifetime, compiled-payload digest, and envelope digest agree. Never construct
a verified policy object from untrusted JSON.

## Operator scanner, redaction, and observe (Policy 2.3)

Policy 2.3 uses the separate async `checkResultV2` API and the explicit
`verifyResponsePolicyAuthorizationV2` verifier. Format 1 remains on the Policy
2.2 API; neither verifier reinterprets the other format.

`checkResultV2` accepts an injected `AuthenticatedScannerTransport`. The SDK
ships no scanner, endpoint, credentials, certificate handling, model, Python
runtime, or network client. The operator adapter receives one private copy of
the bounded `sof-rp-projection-v1` bytes and must return authenticated raw JSON
bytes. The SDK enforces the 2,000 ms deadline and 1 MiB response limit, parses
duplicate-aware strict JSON, verifies every execution, policy, profile,
content, class, offset, confidence, and evidence-digest binding, and rejects
hostile extra fields.

```typescript
const verifiedPolicy = await verifyResponsePolicyAuthorizationV2(
  cryptoAdapter,
  authorization.responsePolicy,
  trustedContext,
);

const decision = await checkResultV2({
  ...trustedLocalResultBindings,
  verifiedPolicy,
  projection: projected.projection,
  scanner: {
    deadlineMs: 1_500, // May lower, never raise, the signed 2,000 ms ceiling.
    transport: operatorAuthenticatedTransport,
  },
});
```

Scanner output is evidence, never the final decision. `BLOCK` takes precedence
over `REDACT`, which takes precedence over `ALLOW`. Verified redaction spans
are merged deterministically and bound to the exact input projection by
`redactionPlanDigest`; the caller applies only those mapped UTF-8 ranges to the
original result shape. Observe findings never change disposition. Content that
already reaches a deterministic block or redaction is not sent to the scanner.
A required-scanner failure blocks; an optional-scanner failure records bounded
metadata and continues deterministic evaluation. No response bytes or scanner
error text enter logs, metrics, traces, hosted Sign, or hosted receipts through
this API.

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

Sigil `DENIED` decisions (including `SIGIL_UNREACHABLE` in closed mode) surface as OpenClaw tool blocks with the rejection reason. Sigil `PENDING` decisions also surface as blocks with `SIGIL_CONSENSUS_HOLD_REQUIRED` and the `hold_id` in `blockReason`. A pending decision is not authorization: the current task must not retry or execute it. If Sign supports a Class 3 resolution for the hold, an authenticated out-of-band operator decision may permit only an exact-intent reauthorization; any resulting attestation is a new, separate authorization. The adapter deliberately does **not** surface `PENDING` through OpenClaw's local approval UI, because local approval would let a host user run the tool without a Sign authorization.

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
if (result.decision !== 'ALLOWED') {
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
| Claude Cowork | `createCoworkPreToolUseHook` | TS | Adapter |
| Hermes Agent | `createHermesPreToolCallHook` | TS | Adapter |
| OpenRouter | `createOpenRouterToolGate` | TS | Adapter |
| AgentPay (WLFI) | `checkAgentPayTransfer` | TS | Adapter |

The typed registry lives at [`src/framework-registry.ts`](./src/framework-registry.ts) and is exported as `FRAMEWORKS`.

## Claude Cowork

`createCoworkPreToolUseHook` backs the Sigil Warrant enforcement plugin for
Claude Cowork. It checks the organization's signed Sigil Warrant before each
tool call in the versioned governed-tool inventory (`COWORK_GOVERNED_TOOLS`,
`inventoryVersion` 1), while the hook process runs to completion. Coverage is
that inventory and that measured completion boundary — not the whole tool
surface, and not arbitrary process termination.

```typescript
import { createCoworkPreToolUseHook } from '@sigilcore/agent-hooks';

const hook = createCoworkPreToolUseHook({
  apiKey: process.env.CLAUDE_PLUGIN_OPTION_SIGIL_API_KEY!,
  agentId: 'cowork',
});

// stdin bytes from the PreToolUse hook host; the adapter strict-parses them.
const result = await hook(rawStdinBytes);
// undefined        -> print nothing, exit 0 (normal permission flow continues)
// deny object      -> print it, exit 0 (Cowork blocks the tool call)
```

Behavior that configuration cannot weaken: `framework: 'cowork'`,
`failMode: 'closed'`, and strict response validation are forced, not
defaulted. `DENIED` and `PENDING` both emit `permissionDecision: "deny"`; a
hold is resolvable only out of band in Sigil Command, never by a local
approval prompt, and the adapter never emits `ask` or `defer`. Every reachable
client-side failure — Sign unreachable, 5xx, timeout, egress 403, missing
credential, malformed input, protocol-invalid response, unclassified tool —
blocks rather than proceeds. Only a strictly schema-valid explicit `ALLOWED`
response can approve.

Governed-tool inventory, rendered from `COWORK_TOOL_MANIFEST` (the single
source; a drift test fails the build if this block and the manifest disagree):

<!-- COWORK_TOOL_TABLE:START -->
| Cowork tool | Classification | Sigil action |
|---|---|---|
| `Bash` | governed | `bash` |
| `Edit` | governed | `file_write` |
| `Write` | governed | `file_write` |
| `Read` | governed | `file_read` |
| `Glob` | governed | `file_read` |
| `Grep` | governed | `file_read` |
| `Agent` | governed | `agent_spawn` |
| `WebFetch` | governed | `web_fetch` |
| `WebSearch` | governed | `web_fetch` |
| `AskUserQuestion` | excluded | — |
| `ExitPlanMode` | excluded | — |
<!-- COWORK_TOOL_TABLE:END -->

`WebFetch`/`WebSearch` are promoted to the `http` action when the input carries
an explicit method. Beyond the inventory: `mcp__<server>__<tool>` names are
governed MCP passthrough, and anything unmatched is denied with
`SIGIL_TOOL_UNCLASSIFIED`.

On the real Cowork host, built-in classes arrive under opaque per-tool names
(`mcp__<12-hex>`; the 2026-08-02 Phase A capture recorded Bash as
`mcp__c44359886c49` and WebFetch as `mcp__4ded42abd557`). The classifier
resolves those by `tool_input` shape: a string `command` is the Bash class, a
string `url` is the WebFetch class, anything else is generic MCP passthrough.
`WebSearch` does not exist on that surface; the inventory entry governs the
name if it ever appears.

Only the per-action projection reaches Sign (`bash.command`, file paths,
patterns, a userinfo-stripped URL, MCP argument key names). File contents,
edit strings, agent prompts, and MCP argument values are withheld and covered
cryptographically by `executionBindingDigest` over the complete raw
`tool_input`, alongside `policyProjectionDigest` over what Sign evaluates —
both computed by the byte-pinned `sigil-canon/1` canonicalization. Oversize
values are rejected, never truncated.

One deliberate fail-closed boundary on that canonicalization: only integers
within the safe-integer range serialize. A raw `tool_input` carrying a
fractional number, `-0`, or a value outside the safe-integer range (for
example an MCP argument like `temperature: 0.7` or a 64-bit numeric id)
denies the call with `SIGIL_INPUT_MALFORMED` before any request is sent,
regardless of the Warrant. Every convention for encoding those forms invites
two implementations to differ and silently invalidate hold identity, so the
format rejects them; if legitimate traffic hits this, the canon version moves
rather than the rule. Encode such values as strings on the tool side.

A Cowork Warrant must name `file_read` and `agent_spawn` in
`tool_calls.allowed`; omitting `file_read` denies every `Read`, `Glob`, and
`Grep` call.

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
if (budget.decision !== 'ALLOWED') {
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
  "sigil_next_steps": "This action is not authorized. Do not retry or execute it. Notify an authenticated operator through the configured out-of-band review path. Only a supported exact-intent reauthorization may proceed with a new attestation."
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
| `apiUrl` | `string` | No | `https://sign.sigilcore.com` | Exact canonical HTTPS origin for Sigil Sign. Paths, credentials, query strings, fragments, and HTTP are rejected before the bearer credential can be sent. |
| `agentId` | `string` | No | `'agent'` | Identifier for this agent |
| `framework` | `string` | No | `'agent-hooks'` | Framework identifier — see [`FRAMEWORKS`](./src/framework-registry.ts) |
| `failMode` | `'open' \| 'closed'` | No | `'open'` | Behavior when Sigil is unreachable — see Fail Modes below |
| `requestTimeoutMs` | `number` | No | `10000` | Request timeout in milliseconds |
| `decisionVerificationMode` | `'warn' \| 'enforce'` | No | `'warn'` | Warn preserves legacy unsigned responses. Enforce mode requires authorization to be signed and bound. |
| `expectedPolicyHash` | `string` | Enforce only | — | Required lowercase 64-character SHA-256 policy pin. Enforce mode denies before network access when it is absent or malformed. |
| `decisionRecordJwk` | `DecisionJwk` | No | — | Static Ed25519 key pin. It takes precedence over JWKS discovery. |
| `attestationIssuer` | `string` | No | `'sigil-core'` | Expected issuer for Intent Attestations. |
| `onDenied` | `function` | No | — | Callback when action is denied |
| `onPending` | `function` | No | — | Callback when action is held |
| `onError` | `function` | No | — | Callback on network error |

### Signed authorization responses

Every authorize request now carries a fresh `request_nonce`. The SDK accepts
the deprecated `APPROVED` input alias, normalizes it to `ALLOWED`, and never
returns the deprecated value. Warn mode keeps unsigned responses working while
the Sign emitter rolls forward, but marks them with a distinct
`LegacyUnverifiedAuthorization` capability and logs `record_missing`. Enforce
mode authorizes only after the decision record and Intent Attestation verify
and cross-bind to the request nonce, intent hash, and configured policy hash.
When warn mode has no `expectedPolicyHash`, every authorize call emits exactly
one `policy_binding` diagnostic. The warning is per call so operators can
measure every execution that lacks a policy pin during rollout.

Adapters branch on the opaque authorization capability. A raw body containing
`status: "ALLOWED"` cannot authorize execution in enforce mode.

## Fail Modes

When no HTTP response is received from Sigil Sign, such as a network partition,
DNS failure, connection refusal, or request timeout, `@sigilcore/agent-hooks`
applies `config.failMode`.

A reached HTTP response is not transport unreachability. Invalid JSON, schema or
signature verification, and HTTP statuses including 429 and 5xx deny with a
non-transport error code in both fail modes.
Authorize requests use manual redirect handling. A reached 3xx response is
classified and denied as `SIGIL_RESPONSE_INVALID`; it cannot mint a transport
fail-open authorization.

### `failMode: 'open'` (default)

Returns `{ decision: 'ALLOWED', failOpen: true, message: 'Sigil unreachable — fail open' }` plus a `warn`-level JSON log line (`event: 'sigil_hook_unreachable'`).

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

In `failMode: 'open'`, an `ALLOWED` result sets `failOpen: true` when it came from the fallback path. Real policy evaluations leave `failOpen` unset. Hosts that need to distinguish the two in telemetry should branch on `result.failOpen`.

### Current reached-response behavior

Older releases routed some reached 5xx responses through the unreachability
fallback. Current releases reserve `SIGIL_UNREACHABLE` and `failOpen` for
requests that receive no HTTP response. A reached 5xx response denies as
`SIGIL_RESPONSE_INVALID`.

## Documentation

Full documentation: [docs.sigilcore.com](https://docs.sigilcore.com)

Get an API key: [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys)

## License

MIT
