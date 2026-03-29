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

## Works With AgentPay (WLFI)

[AgentPay SDK](https://github.com/World-Liberty-Financial-X) enables AI agents to hold and spend USD1 on EVM chains. `@sigilcore/agent-hooks` is fully compatible — no additional configuration needed.

When an AgentPay agent executes a USD1 transfer on Ethereum (chainId 1) or BNB Smart Chain (chainId 56), the `wallet.transfer` or `wallet_sign` action routes through your Sigil policy before the transaction is signed.

```typescript
import { checkIntent } from '@sigilcore/agent-hooks';

// AgentPay initiates a USD1 transfer — Sigil evaluates policy first
const result = await checkIntent({
  action: 'wallet.transfer',
  chainId: 1,                          // Ethereum mainnet
  to: '0xRecipientAddress',
  amount: '1000000000000000000',       // 1 USD1 in wei
  txCommit: sha256(rawTx),
}, config);

if (result.decision !== 'APPROVED') {
  // Block the AgentPay transfer — policy not satisfied
  return buildRejectionContext(result, 'wallet.transfer');
}
// AgentPay proceeds with signing
```

**The layers are additive:** AgentPay handles payment mechanics and key management. Sigil determines whether the agent is authorized to initiate the payment at all. AgentPay tells agents how to spend. Sigil tells agents what they're allowed to do.

USD1 contract address: `0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d` (Ethereum + BSC)

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

## Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `apiKey` | `string` | Yes | — | Sigil API key (`sk_sigil_...`) |
| `apiUrl` | `string` | No | `https://sign.sigilcore.com` | Sigil Sign API URL |
| `agentId` | `string` | No | `'agent'` | Identifier for this agent |
| `onDenied` | `function` | No | — | Callback when action is denied |
| `onPending` | `function` | No | — | Callback when action is held |
| `onError` | `function` | No | — | Callback on network error |

## Fail-Open Behavior

Network errors to the Sigil Sign API result in a **fail-open APPROVED** decision with a warn log. This is intentional:

- Sigil is a governance layer, not a kill switch
- Agent workflows must not break when Sigil is temporarily unreachable
- The warn log provides an audit trail of ungoverned calls during outages

Operators who require fail-closed behavior should handle the `onError` callback and implement their own circuit breaker.

## Documentation

Full documentation: [docs.sigilcore.com](https://docs.sigilcore.com)

Get an API key: [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys)

## License

MIT
