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
