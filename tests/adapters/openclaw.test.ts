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
});
