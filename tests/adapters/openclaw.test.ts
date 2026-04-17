// tests/adapters/openclaw.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenclawSigilHandler } from '../../src/adapters/openclaw.js';
import type { SigilHookConfig } from '../../src/types.js';
import type {
  OpenclawBeforeToolCallEvent,
  OpenclawToolContext,
} from '../../src/adapters/openclaw.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

const BASE_CTX: OpenclawToolContext = {
  toolName: 'exec',
  sessionKey: 'session_abc',
  runId: 'run_xyz',
  toolCallId: 'call_1',
};

describe('createOpenclawSigilHandler', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when Sigil decision is APPROVED', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const handler = createOpenclawSigilHandler(BASE_CONFIG);
    const event: OpenclawBeforeToolCallEvent = {
      toolName: 'exec',
      params: { command: 'ls -la' },
    };
    const result = await handler(event, BASE_CTX);

    expect(result).toBeUndefined();
  });

  it('returns block:true with rejection details on DENIED', async () => {
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

    const handler = createOpenclawSigilHandler(BASE_CONFIG);
    const event: OpenclawBeforeToolCallEvent = {
      toolName: 'exec',
      params: { command: 'rm -rf /' },
    };
    const result = await handler(event, BASE_CTX);

    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('SIGIL_BASH_BLOCKED');
    expect(result!.blockReason).toContain('rm -rf is not allowed');
  });

  it('returns requireApproval on PENDING', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'PENDING',
          holdId: 'hold_abc',
          message: 'Email requires human approval',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const handler = createOpenclawSigilHandler(BASE_CONFIG);
    const event: OpenclawBeforeToolCallEvent = {
      toolName: 'email_send',
      params: { to: 'ceo@example.com' },
    };
    const result = await handler(event, BASE_CTX);

    expect(result).toBeDefined();
    expect(result!.requireApproval).toBeDefined();
    expect(result!.requireApproval!.title).toContain('email_send');
    expect(result!.requireApproval!.description).toContain('human approval');
    expect(result!.requireApproval!.severity).toBe('warning');
    expect(result!.block).toBeUndefined();
  });

  it('returns block:true with transient guidance on DENIED + SIGIL_UNREACHABLE', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createOpenclawSigilHandler({ ...BASE_CONFIG, failMode: 'closed' });
    const event: OpenclawBeforeToolCallEvent = {
      toolName: 'exec',
      params: { command: 'ls' },
    };
    const result = await handler(event, BASE_CTX);

    expect(result).toBeDefined();
    expect(result!.block).toBe(true);
    expect(result!.blockReason).toContain('SIGIL_UNREACHABLE');
    expect(result!.blockReason).toContain('transient');

    warnSpy.mockRestore();
  });

  it('maps exec/process/code_execution to bash', async () => {
    for (const toolName of ['exec', 'process', 'code_execution']) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'APPROVED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const handler = createOpenclawSigilHandler(BASE_CONFIG);
      const event: OpenclawBeforeToolCallEvent = { toolName, params: { command: 'ls' } };
      await handler(event, { ...BASE_CTX, toolName });

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string,
      );
      expect(body.intent.action).toBe('bash');
    }
  });

  it('maps write/edit/apply_patch to file_write', async () => {
    for (const toolName of ['write', 'edit', 'apply_patch']) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'APPROVED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const handler = createOpenclawSigilHandler(BASE_CONFIG);
      const event: OpenclawBeforeToolCallEvent = { toolName, params: { path: '/tmp/x' } };
      await handler(event, { ...BASE_CTX, toolName });

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string,
      );
      expect(body.intent.action).toBe('file_write');
    }
  });

  it('maps web_fetch/web_search/x_search/browser to web_fetch', async () => {
    for (const toolName of ['web_fetch', 'web_search', 'x_search', 'browser']) {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'APPROVED' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const handler = createOpenclawSigilHandler(BASE_CONFIG);
      const event: OpenclawBeforeToolCallEvent = {
        toolName,
        params: { url: 'https://example.com' },
      };
      await handler(event, { ...BASE_CTX, toolName });

      const body = JSON.parse(
        (vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string,
      );
      expect(body.intent.action).toBe('web_fetch');
    }
  });

  it('passes unknown tool names through as lowercase', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const handler = createOpenclawSigilHandler(BASE_CONFIG);
    const event: OpenclawBeforeToolCallEvent = {
      toolName: 'Sessions_List',
      params: {},
    };
    await handler(event, { ...BASE_CTX, toolName: 'Sessions_List' });

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.intent.action).toBe('sessions_list');
  });
});
