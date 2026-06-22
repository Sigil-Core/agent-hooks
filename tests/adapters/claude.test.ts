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

  it('propagates task_id from config into Claude tool checks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'tool_4',
      name: 'Bash',
      input: { command: 'npm test' },
    };

    await checkAnthropicToolUse(block, { ...BASE_CONFIG, taskId: 'claude-session-1' });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.intent.task_id).toBe('claude-session-1');
  });

  it('returns a hard-stop tool_result when Sigil reports a loop ceiling', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_LOOP_LIMIT_EXCEEDED',
          message: 'Tool call count 51 exceeded per-task ceiling 50.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const block: AnthropicToolUseBlock = {
      type: 'tool_use',
      id: 'tool_5',
      name: 'Bash',
      input: { command: 'npm test' },
    };

    const result = await checkAnthropicToolUse(block, { ...BASE_CONFIG, taskId: 'claude-session-1' });
    const rejection = JSON.parse(result!.content);

    expect(result!.is_error).toBe(true);
    expect(rejection.sigil_error_code).toBe('SIGIL_LOOP_LIMIT_EXCEEDED');
    expect(rejection.sigil_task_id).toBe('claude-session-1');
    expect(rejection.sigil_next_steps).toContain('Hard-stop');
  });
});
