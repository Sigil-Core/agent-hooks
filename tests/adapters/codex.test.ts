import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexPreToolUseHook } from '../../src/adapters/codex.js';
import * as pkg from '../../src/index.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

describe('createCodexPreToolUseHook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when Sigil approves', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createCodexPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'session-1',
    });

    expect(result).toBeUndefined();
  });

  it('normalizes Bash payloads and defaults Codex checks to fail closed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createCodexPreToolUseHook(BASE_CONFIG);
    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'session-1',
      cwd: '/repo',
      model: 'gpt-5-codex',
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.framework).toBe('codex');
    expect(body.intent.action).toBe('bash');
    expect(body.intent.command).toBe('npm test');
    expect(body.intent.task_id).toBe('session-1');
    expect(body.intent.metadata.codex.coverage).toContain('simple Bash');
  });

  it('maps apply_patch and MCP tool calls without losing raw metadata', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }));

    const hook = createCodexPreToolUseHook(BASE_CONFIG);
    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** End Patch' },
      turn_id: 'turn-1',
    });
    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__filesystem__read_file',
      tool_input: { path: '/tmp/a.txt' },
      turn_id: 'turn-2',
    });

    const patchBody = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    const mcpBody = JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string);
    expect(patchBody.intent.action).toBe('file_write');
    expect(mcpBody.intent.action).toBe('mcp__filesystem__read_file');
    expect(mcpBody.intent.metadata.path).toBe('/tmp/a.txt');
    expect(mcpBody.intent.metadata.codex.coverage).toContain('MCP');
  });

  it('returns the documented Codex deny shape on denial', async () => {
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

    const hook = createCodexPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'SIGIL_BASH_BLOCKED: blocked',
      },
    });
  });

  it('is re-exported from the package index', () => {
    expect(pkg.createCodexPreToolUseHook).toBe(createCodexPreToolUseHook);
  });
});
