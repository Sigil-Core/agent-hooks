import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHermesPreToolCallHook } from '../../src/adapters/hermes.js';
import * as pkg from '../../src/index.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

describe('createHermesPreToolCallHook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env['SIGIL_TASK_ID'];
  });

  it('returns an empty object when Sigil approves', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createHermesPreToolCallHook(BASE_CONFIG);
    const result = await hook({
      tool_name: 'terminal',
      tool_input: { command: 'ls -la' },
      session_id: 'session-1',
    });

    expect(result).toEqual({});
  });

  it('normalizes Hermes payloads and prefers config task id before SIGIL_TASK_ID', async () => {
    process.env['SIGIL_TASK_ID'] = 'env-task-1';
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createHermesPreToolCallHook({ ...BASE_CONFIG, taskId: 'config-task' });
    await hook({
      tool_name: 'write_file',
      tool_input: { path: '/tmp/out.txt', content: 'hello' },
      session_id: 'session-1',
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.framework).toBe('hermes');
    expect(body.intent.action).toBe('file_write');
    expect(body.intent.path).toBe('/tmp/out.txt');
    expect(body.intent.task_id).toBe('config-task');
    expect(body.intent.metadata.hermes.originalToolName).toBe('write_file');
  });

  it('returns the Hermes block shape on denial', async () => {
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

    const hook = createHermesPreToolCallHook(BASE_CONFIG);
    const result = await hook({
      tool_name: 'terminal',
      tool_input: { command: 'rm -rf /' },
    });

    expect(result).toEqual({
      decision: 'block',
      reason: 'SIGIL_BASH_BLOCKED: blocked',
    });
  });

  it('is re-exported from the package index', () => {
    expect(pkg.createHermesPreToolCallHook).toBe(createHermesPreToolCallHook);
  });
});
