# @sigilcore/agent-hooks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `@sigilcore/agent-hooks`, a standalone npm package that intercepts agent tool calls before execution and enforces Sigil Sign policy decisions via the `/v1/authorize` endpoint.

**Architecture:** Framework-agnostic core interceptor (`checkIntent`) calls the Sigil Sign API. Three thin adapters (Claude/Anthropic, ELIZA, LangChain) map framework-specific tool call shapes into `SigilIntent`. A rejection helper (`buildRejectionContext`) produces typed JSON so agents understand why they were blocked (Graceful Agent Degradation). Fail-open on network errors.

**Tech Stack:** TypeScript, tsup (ESM+CJS dual build), vitest, Node 20+ (built-in fetch + crypto)

**Package location:** `packages/agent-hooks/` (standalone — no dependency on sigil-sign src)

---

### Task 1: Scaffold package structure

**Files:**
- Create: `packages/agent-hooks/package.json`
- Create: `packages/agent-hooks/tsconfig.json`
- Create: `packages/agent-hooks/tsup.config.ts`
- Create: `packages/agent-hooks/vitest.config.ts`
- Create: `packages/agent-hooks/.eslintrc.json`
- Create: `packages/agent-hooks/src/` (directory)
- Create: `packages/agent-hooks/tests/` (directory)

**Step 1: Create package.json**

```json
{
  "name": "@sigilcore/agent-hooks",
  "version": "0.1.0",
  "description": "PreToolUse interceptor for autonomous AI agents — policy enforcement via Sigil Sign",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --ext .ts"
  },
  "license": "MIT",
  "engines": {
    "node": ">=20.0.0"
  },
  "devDependencies": {
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "eslint": "^8.57.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
});
```

**Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
  },
});
```

**Step 5: Create .eslintrc.json**

```json
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "parserOptions": {
    "ecmaVersion": 2022,
    "sourceType": "module"
  },
  "rules": {
    "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
  }
}
```

**Step 6: Install dependencies**

Run: `cd packages/agent-hooks && npm install`
Expected: `node_modules` created, lockfile generated

**Step 7: Commit**

```bash
git add packages/agent-hooks/
git commit -m "chore(agent-hooks): scaffold package structure"
```

---

### Task 2: Core types

**Files:**
- Create: `packages/agent-hooks/src/types.ts`

**Step 1: Write types file**

```typescript
// src/types.ts

export type SigilDecision = 'APPROVED' | 'DENIED' | 'PENDING';

export interface SigilIntent {
  action: string;
  agentId?: string;
  chainId?: number;
  command?: string;
  url?: string;
  path?: string;
  to?: string;
  amount?: string;
  txCommit?: string;
  metadata?: Record<string, unknown>;
}

export interface SigilHookConfig {
  apiKey: string;
  apiUrl?: string;
  agentId?: string;
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
}

export interface SigilRejectionContext {
  sigil_decision: 'DENIED' | 'PENDING';
  sigil_error_code: string;
  sigil_message: string;
  sigil_hold_id?: string;
  sigil_policy_hash?: string;
  sigil_action_taken: 'halted' | 'pending_approval';
  sigil_next_steps: string;
}
```

**Step 2: Run typecheck**

Run: `cd packages/agent-hooks && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-hooks/src/types.ts
git commit -m "feat(agent-hooks): add core types"
```

---

### Task 3: Core interceptor — tests first

**Files:**
- Create: `packages/agent-hooks/src/interceptor.ts`
- Create: `packages/agent-hooks/tests/interceptor.test.ts`

**Step 1: Write failing tests for checkIntent**

```typescript
// tests/interceptor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkIntent } from '../src/interceptor.js';
import type { SigilHookConfig, SigilIntent } from '../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

describe('checkIntent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns APPROVED for an allowed bash action', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'abc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const intent: SigilIntent = { action: 'bash', command: 'ls -la' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('APPROVED');
    expect(result.policyHash).toBe('abc123');
  });

  it('returns DENIED for a blocked bash command', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_BASH_BLOCKED',
          message: 'rm -rf is not allowed',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const onDenied = vi.fn();
    const config = { ...BASE_CONFIG, onDenied };
    const intent: SigilIntent = { action: 'bash', command: 'rm -rf /' };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_BASH_BLOCKED');
    expect(result.message).toBe('rm -rf is not allowed');
    expect(onDenied).toHaveBeenCalledWith(intent, 'rm -rf is not allowed');
  });

  it('returns DENIED for a blocked domain in web_fetch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_DOMAIN_BLOCKED',
          message: 'Domain evil.com is blocked',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const intent: SigilIntent = { action: 'web_fetch', url: 'https://evil.com/payload' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_DOMAIN_BLOCKED');
  });

  it('returns PENDING for email.send with require_approval', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'PENDING',
          holdId: 'hold_abc123',
          message: 'Email requires human approval',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const onPending = vi.fn();
    const config = { ...BASE_CONFIG, onPending };
    const intent: SigilIntent = { action: 'email.send', metadata: { to: 'ceo@example.com' } };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('PENDING');
    expect(result.holdId).toBe('hold_abc123');
    expect(onPending).toHaveBeenCalledWith(intent, 'hold_abc123');
  });

  it('returns APPROVED on network error (fail-open) with warn log', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { ...BASE_CONFIG, onError };
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('APPROVED');
    expect(result.message).toBe('Sigil unreachable — fail open');
    expect(onError).toHaveBeenCalledWith(intent, expect.any(Error));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('sends correct request shape to /v1/authorize', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const intent: SigilIntent = {
      action: 'wallet.transfer',
      to: '0xabc',
      amount: '1000000000000000000',
      chainId: 1,
    };
    await checkIntent(intent, { ...BASE_CONFIG, agentId: 'my-agent' });

    expect(fetch).toHaveBeenCalledWith(
      'https://sign.test.sigilcore.com/v1/authorize',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk_sigil_test_key',
        },
      }),
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.framework).toBe('agent-hooks');
    expect(body.agentId).toBe('my-agent');
    expect(body.intent.action).toBe('wallet.transfer');
    expect(body.intent.targetAddress).toBe('0xabc');
    expect(body.intent.amount).toBe('1000000000000000000');
    expect(body.chainId).toBe(1);
    expect(typeof body.txCommit).toBe('string');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent-hooks && npx vitest run tests/interceptor.test.ts`
Expected: FAIL — `interceptor.js` module not found

**Step 3: Write the interceptor implementation**

```typescript
// src/interceptor.ts
import { createHash } from 'node:crypto';
import type { SigilHookConfig, SigilHookResult, SigilIntent } from './types.js';

const DEFAULT_API_URL = 'https://sign.sigilcore.com';

export async function checkIntent(
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<SigilHookResult> {
  const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  const agentId = config.agentId ?? intent.agentId ?? 'agent';
  const txCommit = intent.txCommit ?? generateIntentCommit(intent);

  const body = {
    framework: 'agent-hooks',
    agentId,
    txCommit,
    chainId: intent.chainId,
    intent: {
      action: intent.action,
      command: intent.command,
      url: intent.url,
      path: intent.path,
      targetAddress: intent.to,
      amount: intent.amount,
      metadata: intent.metadata,
    },
  };

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/v1/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    config.onError?.(intent, error);
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'sigil_hook_network_error',
      action: intent.action,
      message: error.message,
    }));
    return { decision: 'APPROVED', message: 'Sigil unreachable — fail open' };
  }

  const data = await response.json() as Record<string, unknown>;

  if (data['status'] === 'APPROVED') {
    return {
      decision: 'APPROVED',
      policyHash: data['policyHash'] as string | undefined,
    };
  }

  if (data['status'] === 'PENDING') {
    const holdId = data['holdId'] as string;
    config.onPending?.(intent, holdId);
    return {
      decision: 'PENDING',
      holdId,
      message: data['message'] as string | undefined,
    };
  }

  const errorCode = (data['error_code'] as string) ?? 'SIGIL_POLICY_VIOLATION';
  const message = (data['message'] as string) ?? 'Action blocked by policy';
  config.onDenied?.(intent, message);
  return { decision: 'DENIED', errorCode, message };
}

function generateIntentCommit(intent: SigilIntent): string {
  const preimage = JSON.stringify({
    action: intent.action,
    command: intent.command,
    url: intent.url,
    path: intent.path,
    to: intent.to,
    amount: intent.amount,
    ts: Math.floor(Date.now() / 1000),
  });
  return createHash('sha256').update(preimage).digest('hex');
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/agent-hooks && npx vitest run tests/interceptor.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add packages/agent-hooks/src/interceptor.ts packages/agent-hooks/tests/interceptor.test.ts
git commit -m "feat(agent-hooks): add core interceptor with tests"
```

---

### Task 4: Rejection helper — tests first

**Files:**
- Create: `packages/agent-hooks/src/rejection.ts`
- Create: `packages/agent-hooks/tests/rejection.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/rejection.test.ts
import { describe, it, expect } from 'vitest';
import { buildRejectionContext } from '../src/rejection.js';
import type { SigilHookResult } from '../src/types.js';

describe('buildRejectionContext', () => {
  it('returns correct context for DENIED result', () => {
    const result: SigilHookResult = {
      decision: 'DENIED',
      errorCode: 'SIGIL_BASH_BLOCKED',
      message: 'rm -rf is not allowed',
      policyHash: 'hash123',
    };

    const ctx = buildRejectionContext(result, 'bash');

    expect(ctx.sigil_decision).toBe('DENIED');
    expect(ctx.sigil_error_code).toBe('SIGIL_BASH_BLOCKED');
    expect(ctx.sigil_message).toBe('rm -rf is not allowed');
    expect(ctx.sigil_policy_hash).toBe('hash123');
    expect(ctx.sigil_action_taken).toBe('halted');
    expect(ctx.sigil_next_steps).toContain('bash');
    expect(ctx.sigil_next_steps).toContain('blocked');
  });

  it('returns correct context for PENDING result', () => {
    const result: SigilHookResult = {
      decision: 'PENDING',
      holdId: 'hold_xyz',
      message: 'Requires human approval',
      policyHash: 'hash456',
    };

    const ctx = buildRejectionContext(result, 'email.send');

    expect(ctx.sigil_decision).toBe('PENDING');
    expect(ctx.sigil_error_code).toBe('SIGIL_CONSENSUS_HOLD_REQUIRED');
    expect(ctx.sigil_message).toBe('Requires human approval');
    expect(ctx.sigil_hold_id).toBe('hold_xyz');
    expect(ctx.sigil_policy_hash).toBe('hash456');
    expect(ctx.sigil_action_taken).toBe('pending_approval');
    expect(ctx.sigil_next_steps).toContain('paused');
  });

  it('uses default messages when result has none', () => {
    const result: SigilHookResult = { decision: 'DENIED' };
    const ctx = buildRejectionContext(result, 'file_write');

    expect(ctx.sigil_error_code).toBe('SIGIL_POLICY_VIOLATION');
    expect(ctx.sigil_message).toBe('Action blocked by Sigil policy.');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent-hooks && npx vitest run tests/rejection.test.ts`
Expected: FAIL — module not found

**Step 3: Write the rejection helper**

```typescript
// src/rejection.ts
import type { SigilHookResult, SigilRejectionContext } from './types.js';

export function buildRejectionContext(
  result: SigilHookResult,
  action: string,
): SigilRejectionContext {
  if (result.decision === 'PENDING') {
    return {
      sigil_decision: 'PENDING',
      sigil_error_code: 'SIGIL_CONSENSUS_HOLD_REQUIRED',
      sigil_message: result.message ?? 'Action requires human approval.',
      sigil_hold_id: result.holdId,
      sigil_policy_hash: result.policyHash,
      sigil_action_taken: 'pending_approval',
      sigil_next_steps:
        'This action has been paused for human review. Do not retry. ' +
        'Notify the operator via Sigil Command.',
    };
  }

  return {
    sigil_decision: 'DENIED',
    sigil_error_code: result.errorCode ?? 'SIGIL_POLICY_VIOLATION',
    sigil_message: result.message ?? 'Action blocked by Sigil policy.',
    sigil_policy_hash: result.policyHash,
    sigil_action_taken: 'halted',
    sigil_next_steps:
      `The action "${action}" was blocked. ` +
      'Do not attempt to reframe or retry this action. ' +
      'Report the violation to the operator.',
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/agent-hooks && npx vitest run tests/rejection.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add packages/agent-hooks/src/rejection.ts packages/agent-hooks/tests/rejection.test.ts
git commit -m "feat(agent-hooks): add rejection context builder with tests"
```

---

### Task 5: Claude/Anthropic adapter — tests first

**Files:**
- Create: `packages/agent-hooks/src/adapters/claude.ts`
- Create: `packages/agent-hooks/tests/adapters/claude.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/adapters/claude.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkAnthropicToolUse } from '../../src/adapters/claude.js';
import type { AnthropicToolUseBlock } from '../../src/adapters/claude.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

describe('checkAnthropicToolUse', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null on APPROVED', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'p1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'Bash',
      input: { command: 'echo hello' },
    };

    const result = await checkAnthropicToolUse(block, BASE_CONFIG);
    expect(result).toBeNull();
  });

  it('returns tool_result block on DENIED', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_BASH_BLOCKED',
          message: 'Blocked',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'tool_2',
      name: 'Bash',
      input: { command: 'rm -rf /' },
    };

    const result = await checkAnthropicToolUse(block, BASE_CONFIG);

    expect(result).not.toBeNull();
    expect(result!.type).toBe('tool_result');
    expect(result!.tool_use_id).toBe('tool_2');
    expect(result!.is_error).toBe(true);

    const rejection = JSON.parse(result!.content);
    expect(rejection.sigil_decision).toBe('DENIED');
    expect(rejection.sigil_action_taken).toBe('halted');
  });

  it('maps Anthropic tool names to Sigil action types', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'tool_3',
      name: 'WebFetch',
      input: { url: 'https://example.com' },
    };

    await checkAnthropicToolUse(block, BASE_CONFIG);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.intent.action).toBe('web_fetch');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/agent-hooks && npx vitest run tests/adapters/claude.test.ts`
Expected: FAIL — module not found

**Step 3: Write the Claude adapter**

```typescript
// src/adapters/claude.ts
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';

const TOOL_ACTION_MAP: Record<string, string> = {
  Bash: 'bash',
  bash: 'bash',
  WebSearch: 'web_fetch',
  WebFetch: 'web_fetch',
  computer: 'bash',
  Write: 'file_write',
  Edit: 'file_write',
};

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export async function checkAnthropicToolUse(
  block: AnthropicToolUseBlock,
  config: SigilHookConfig,
): Promise<null | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }> {
  const action = TOOL_ACTION_MAP[block.name] ?? block.name.toLowerCase();

  const intent: SigilIntent = {
    action,
    command: block.input['command'] as string | undefined,
    url: block.input['url'] as string | undefined,
    path: block.input['path'] as string | undefined,
    metadata: block.input,
  };

  const result = await checkIntent(intent, config);

  if (result.decision === 'APPROVED') return null;

  const rejection = buildRejectionContext(result, action);
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content: JSON.stringify(rejection),
    is_error: true,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/agent-hooks && npx vitest run tests/adapters/claude.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add packages/agent-hooks/src/adapters/claude.ts packages/agent-hooks/tests/adapters/claude.test.ts
git commit -m "feat(agent-hooks): add Claude/Anthropic adapter with tests"
```

---

### Task 6: ELIZA adapter

**Files:**
- Create: `packages/agent-hooks/src/adapters/eliza.ts`

**Step 1: Write the ELIZA adapter**

```typescript
// src/adapters/eliza.ts
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig, SigilIntent } from '../types.js';

export interface ElizaAction {
  name: string;
  params?: Record<string, unknown>;
}

export async function checkElizaAction(
  action: ElizaAction,
  config: SigilHookConfig,
): Promise<null | { blocked: true; rejection: Record<string, unknown> }> {
  const intent: SigilIntent = {
    action: action.name.toLowerCase(),
    metadata: action.params,
  };

  const result = await checkIntent(intent, config);
  if (result.decision === 'APPROVED') return null;

  return {
    blocked: true,
    rejection: buildRejectionContext(result, action.name),
  };
}
```

**Step 2: Run typecheck**

Run: `cd packages/agent-hooks && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-hooks/src/adapters/eliza.ts
git commit -m "feat(agent-hooks): add ELIZA adapter"
```

---

### Task 7: LangChain adapter

**Files:**
- Create: `packages/agent-hooks/src/adapters/langchain.ts`

**Step 1: Write the LangChain adapter**

```typescript
// src/adapters/langchain.ts
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import type { SigilHookConfig } from '../types.js';

export function wrapLangChainTool<T extends { name: string; call: (input: string) => Promise<string> }>(
  tool: T,
  config: SigilHookConfig,
): T {
  const originalCall = tool.call.bind(tool);

  tool.call = async (input: string): Promise<string> => {
    const result = await checkIntent(
      { action: tool.name.toLowerCase(), metadata: { input } },
      config,
    );

    if (result.decision === 'APPROVED') {
      return originalCall(input);
    }

    const rejection = buildRejectionContext(result, tool.name);
    return JSON.stringify(rejection);
  };

  return tool;
}
```

**Step 2: Run typecheck**

Run: `cd packages/agent-hooks && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add packages/agent-hooks/src/adapters/langchain.ts
git commit -m "feat(agent-hooks): add LangChain adapter"
```

---

### Task 8: Public exports barrel

**Files:**
- Create: `packages/agent-hooks/src/index.ts`

**Step 1: Write barrel exports**

```typescript
// src/index.ts
export { checkIntent } from './interceptor.js';
export { buildRejectionContext } from './rejection.js';
export { checkAnthropicToolUse } from './adapters/claude.js';
export { checkElizaAction } from './adapters/eliza.js';
export { wrapLangChainTool } from './adapters/langchain.js';
export type {
  SigilDecision,
  SigilIntent,
  SigilHookConfig,
  SigilHookResult,
  SigilRejectionContext,
} from './types.js';
export type { AnthropicToolUseBlock } from './adapters/claude.js';
export type { ElizaAction } from './adapters/eliza.js';
```

**Step 2: Verify build produces ESM + CJS**

Run: `cd packages/agent-hooks && npx tsup`
Expected: `dist/index.js` (ESM), `dist/index.cjs` (CJS), `dist/index.d.ts` created

**Step 3: Run full test suite**

Run: `cd packages/agent-hooks && npx vitest run`
Expected: All tests PASS

**Step 4: Commit**

```bash
git add packages/agent-hooks/src/index.ts
git commit -m "feat(agent-hooks): add barrel exports and verify build"
```

---

### Task 9: README.md

**Files:**
- Create: `packages/agent-hooks/README.md`

**Step 1: Write README**

The README must contain these sections (written in full below):
1. One-paragraph description
2. Installation
3. Prerequisites
4. Quick start (Claude Code, ELIZA, LangChain examples)
5. Graceful Agent Degradation schema with example JSON
6. Configuration reference
7. Fail-open behavior
8. Links to docs.sigilcore.com and sigilcore.com/tools/keys

Full content:

```markdown
# @sigilcore/agent-hooks

PreToolUse interceptor for autonomous AI agents. Intercepts an agent's intended tool call **before** it executes, submits it to the Sigil Sign `/v1/authorize` endpoint, and blocks or holds the action based on the policy decision. Works with Claude Code, ELIZA, LangChain, or any framework via the generic `checkIntent` API.

## Installation

npm install @sigilcore/agent-hooks

## Prerequisites

You need a Sigil API key. Get one at [sigilcore.com/tools/keys](https://sigilcore.com/tools/keys).

## Quick Start

### Claude Code / Anthropic SDK

\`\`\`typescript
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
\`\`\`

### ELIZA

\`\`\`typescript
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
\`\`\`

### LangChain

\`\`\`typescript
import { wrapLangChainTool } from '@sigilcore/agent-hooks';

const config = {
  apiKey: process.env.SIGIL_API_KEY!,
  agentId: 'my-langchain-agent',
};

// Wrap any LangChain tool:
const safeTool = wrapLangChainTool(myTool, config);
// safeTool.call() now checks Sigil policy before executing
\`\`\`

## Graceful Agent Degradation

When an action is blocked, the package returns a typed JSON rejection context that agents can understand:

\`\`\`json
{
  "sigil_decision": "DENIED",
  "sigil_error_code": "SIGIL_BASH_BLOCKED",
  "sigil_message": "rm -rf is not allowed by policy",
  "sigil_policy_hash": "abc123def456",
  "sigil_action_taken": "halted",
  "sigil_next_steps": "The action \"bash\" was blocked. Do not attempt to reframe or retry this action. Report the violation to the operator."
}
\`\`\`

For held actions:

\`\`\`json
{
  "sigil_decision": "PENDING",
  "sigil_error_code": "SIGIL_CONSENSUS_HOLD_REQUIRED",
  "sigil_message": "Email requires human approval",
  "sigil_hold_id": "hold_abc123",
  "sigil_action_taken": "pending_approval",
  "sigil_next_steps": "This action has been paused for human review. Do not retry. Notify the operator via Sigil Command."
}
\`\`\`

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
\`\`\`

**Step 2: Commit**

```bash
git add packages/agent-hooks/README.md
git commit -m "docs(agent-hooks): add README with usage examples"
```

---

### Task 10: Final verification

**Step 1: Run full typecheck**

Run: `cd packages/agent-hooks && npx tsc --noEmit`
Expected: No errors

**Step 2: Run full test suite**

Run: `cd packages/agent-hooks && npx vitest run`
Expected: All tests PASS (12 tests across 3 files)

**Step 3: Verify build**

Run: `cd packages/agent-hooks && npx tsup`
Expected: ESM + CJS output in `dist/`

**Step 4: Verify exports are correct**

Run: `cd packages/agent-hooks && node -e "const m = require('./dist/index.cjs'); console.log(Object.keys(m))"`
Expected: `['checkIntent', 'buildRejectionContext', 'checkAnthropicToolUse', 'checkElizaAction', 'wrapLangChainTool']`

**Step 5: Final commit if needed, then done**

```bash
git add -A packages/agent-hooks/
git commit -m "chore(agent-hooks): final verification pass"
```
