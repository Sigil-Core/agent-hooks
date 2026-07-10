import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAnthropicToolUse } from '../../src/adapters/claude.js';
import { createCodexPreToolUseHook } from '../../src/adapters/codex.js';
import { checkElizaAction } from '../../src/adapters/eliza.js';
import { createHermesPreToolCallHook } from '../../src/adapters/hermes.js';
import { wrapLangChainTool } from '../../src/adapters/langchain.js';
import { createOpenclawSigilHandler } from '../../src/adapters/openclaw.js';
import { createOpenRouterToolGate } from '../../src/adapters/openrouter.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

function approvedResponse(): Response {
  return new Response(JSON.stringify({ status: 'APPROVED' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(): Record<string, any> {
  return JSON.parse((vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string);
}

describe('typed HTTP adapter promotion', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['Claude', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await checkAnthropicToolUse({
        type: 'tool_use', id: 'claude-http', name: 'WebFetch',
        input: { url: 'https://example.com/posts', method: 'POST' },
      }, BASE_CONFIG);
    }],
    ['Codex', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await createCodexPreToolUseHook(BASE_CONFIG)({
        tool_name: 'http', tool_input: { url: 'https://example.com/posts', method: 'PUT' },
      });
    }],
    ['Hermes', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await createHermesPreToolCallHook(BASE_CONFIG)({
        tool_name: 'web_fetch', tool_input: { url: 'https://example.com/posts', method: 'PATCH' },
      });
    }],
    ['OpenRouter', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await createOpenRouterToolGate(BASE_CONFIG)({
        function: { name: 'WebFetch', arguments: { url: 'https://example.com/posts', method: 'OPTIONS' } },
      });
    }],
    ['OpenClaw', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await createOpenclawSigilHandler(BASE_CONFIG)(
        { toolName: 'web_fetch', params: { url: 'https://example.com/posts', method: 'DELETE' } },
        { toolName: 'web_fetch' },
      );
    }],
    ['ELIZA', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      await checkElizaAction({
        name: 'http', params: { url: 'https://example.com/posts', method: 'GET' },
      }, BASE_CONFIG);
    }],
    ['LangChain', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const tool = { name: 'http', call: async (input: string) => input };
      await wrapLangChainTool(tool, BASE_CONFIG).call(
        JSON.stringify({ url: 'https://example.com/posts', method: 'HEAD' }),
      );
    }],
  ])('%s emits http only when method is explicit', async (_name, invoke) => {
    await invoke();
    const body = requestBody();
    expect(body.intent.action).toBe('http');
    expect(body.intent.method).toMatch(/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/);
    expect(body.intent.url).toBe('https://example.com/posts');
  });

  it('keeps web_fetch for methodless web tools and never infers GET', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
    await checkAnthropicToolUse({
      type: 'tool_use', id: 'legacy-fetch', name: 'WebFetch',
      input: { url: 'https://example.com/posts' },
    }, BASE_CONFIG);

    const body = requestBody();
    expect(body.intent.action).toBe('web_fetch');
    expect(body.intent.method).toBeUndefined();
  });

  it('keeps an invalid non-empty method typed so Sign fails closed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
    await createCodexPreToolUseHook(BASE_CONFIG)({
      tool_name: 'web_fetch',
      tool_input: { url: 'https://example.com/posts', method: 'TRACE' },
    });

    const body = requestBody();
    expect(body.intent.action).toBe('http');
    expect(body.intent.method).toBeUndefined();
    expect(body.intent.metadata.method).toBe('TRACE');
  });

  it('does not promote arbitrary actions based on a metadata method field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
    await createCodexPreToolUseHook(BASE_CONFIG)({
      tool_name: 'custom_web_tool',
      tool_input: { url: 'https://example.com/posts', method: 'POST' },
    });

    const body = requestBody();
    expect(body.intent.action).toBe('custom_web_tool');
    expect(body.intent.method).toBeUndefined();
  });
});
