import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenRouterToolGate,
  recordOpenRouterModelUsageAndCheckBudget,
} from '../../src/adapters/openrouter.js';
import { clearModelUsage } from '../../src/model-usage.js';
import * as pkg from '../../src/index.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  taskId: 'openrouter-task-1',
};

describe('createOpenRouterToolGate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    clearModelUsage(BASE_CONFIG);
    vi.restoreAllMocks();
  });

  it('approves parsed tool calls and maps function names', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const gate = createOpenRouterToolGate(BASE_CONFIG, { run_shell: 'bash' });
    const result = await gate({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'run_shell',
        arguments: JSON.stringify({ command: 'npm test' }),
      },
    });

    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.name).toBe('run_shell');
      expect(result.args).toEqual({ command: 'npm test' });
    }

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.framework).toBe('openrouter');
    expect(body.intent.action).toBe('bash');
    expect(body.intent.command).toBe('npm test');
    expect(body.intent.metadata.openrouter.toolCallId).toBe('call_1');
  });

  it('returns a tool message with rejection context on denial', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'DENIED',
        error_code: 'SIGIL_BASH_BLOCKED',
        message: 'blocked',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const gate = createOpenRouterToolGate(BASE_CONFIG, { run_shell: 'bash' });
    const result = await gate({
      id: 'call_2',
      function: {
        name: 'run_shell',
        arguments: { command: 'rm -rf /' },
      },
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.toolResult).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_2',
      });
      expect(JSON.parse(result.toolResult.content).sigil_error_code).toBe('SIGIL_BASH_BLOCKED');
    }
  });

  it('handles malformed tool arguments without throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'DENIED',
        error_code: 'SIGIL_TOOL_ARGUMENTS_INVALID',
        message: 'invalid arguments',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const gate = createOpenRouterToolGate(BASE_CONFIG, { run_shell: 'bash' });
    const result = await gate({
      id: 'call_bad_json',
      function: {
        name: 'run_shell',
        arguments: '{"command":',
      },
    });

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.args).toEqual({});
      expect(JSON.parse(result.toolResult.content).sigil_error_code)
        .toBe('SIGIL_TOOL_ARGUMENTS_INVALID');
    }
  });

  it('records OpenRouter response usage and checks model budget', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'hash_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await recordOpenRouterModelUsageAndCheckBudget({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        total_tokens: 125,
        cost: 0.25,
      },
    }, BASE_CONFIG);

    expect(result).toMatchObject({ decision: 'APPROVED', policyHash: 'hash_123' });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.intent.action).toBe('model.inference');
    expect(body.intent.task_id).toBe('openrouter-task-1');
    expect(body.intent.metadata.model_usage).toMatchObject({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4',
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
      estimated_spend_usd: '0.25',
    });
  });

  it('is re-exported from the package index', () => {
    expect(pkg.createOpenRouterToolGate).toBe(createOpenRouterToolGate);
    expect(pkg.recordOpenRouterModelUsageAndCheckBudget)
      .toBe(recordOpenRouterModelUsageAndCheckBudget);
  });
});
