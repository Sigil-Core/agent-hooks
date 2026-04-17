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
});
