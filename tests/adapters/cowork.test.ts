import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCoworkPreToolUseHook,
  type CoworkPreToolUsePayload,
} from '../../src/adapters/cowork.js';
import * as pkg from '../../src/index.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

const deny = (code: string, message: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `${code}: ${message}`,
  },
});

describe('createCoworkPreToolUseHook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns undefined when Sigil approves', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'session-1',
    });

    expect(result).toBeUndefined();
  });

  it('normalizes Bash payloads and records only measured Cowork coverage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'session-1',
      cwd: '/repo',
      model: 'claude-sonnet-4',
    });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.framework).toBe('cowork');
    expect(body.intent.action).toBe('bash');
    expect(body.intent.command).toBe('npm test');
    expect(body.intent.task_id).toBe('session-1');
    expect(body.intent.metadata.cowork.coverage).toContain('Linux sandbox VM');
    expect(body.intent.metadata.cowork.coverage).toContain('macOS host');
  });

  it('records the measured file, WebFetch, MCP, and subagent coverage boundaries', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }));

    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    await hook({ tool_name: 'Write', tool_input: { path: '/folder/a.txt' } });
    await hook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
    await hook({ tool_name: 'mcp__example__tool', tool_input: {} });
    await hook({ tool_name: 'CustomTool', tool_input: {} });

    const coverage = vi.mocked(fetch).mock.calls.map((call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return body.intent.metadata.cowork.coverage as string;
    });
    expect(coverage[0]).toContain('connected folders');
    expect(coverage[0]).toContain('refuse targets outside');
    expect(coverage[1]).toContain('No web-search tool exists');
    expect(coverage[2]).toContain('MCP tool classes are reachable');
    expect(coverage[3]).toContain('reaches subagent invocation');
  });

  it.each([
    {
      name: 'DENIED',
      response: {
        status: 'DENIED',
        error_code: 'SIGIL_BASH_BLOCKED',
        message: 'blocked',
      },
      expected: deny('SIGIL_BASH_BLOCKED', 'blocked'),
    },
    {
      name: 'PENDING',
      response: {
        status: 'PENDING',
        hold_id: 'hold-1',
        message: 'approval required',
      },
      expected: deny('SIGIL_CONSENSUS_HOLD_REQUIRED', 'approval required'),
    },
  ])('returns the Cowork deny shape for $name', async ({ response, expected }) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    expect(result).toEqual(expected);
  });

  it('defaults Cowork checks to fail closed when Sign is unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));

    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(result).toEqual(deny('SIGIL_UNREACHABLE', 'network down'));
  });

  it('denies when checkIntent rejects after the request completes', async () => {
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

    const hook = createCoworkPreToolUseHook({
      ...BASE_CONFIG,
      onDenied: () => {
        throw new Error('denial callback failed');
      },
    });
    const result = await hook({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });

    expect(result).toEqual(deny('SIGIL_UNREACHABLE', 'denial callback failed'));
  });

  it('denies a payload missing tool_name without calling Sign', async () => {
    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      tool_input: { command: 'npm test' },
    } as unknown as CoworkPreToolUsePayload);

    expect(result).toEqual(
      deny('SIGIL_COWORK_PAYLOAD_INVALID', 'Cowork PreToolUse payload is missing tool_name.'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies a payload with non-object tool_input without calling Sign', async () => {
    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook({
      tool_name: 'Bash',
      tool_input: 'npm test',
    } as unknown as CoworkPreToolUsePayload);

    expect(result).toEqual(
      deny(
        'SIGIL_COWORK_PAYLOAD_INVALID',
        'Cowork PreToolUse payload tool_input must be an object.',
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies unparseable JSON without calling Sign', async () => {
    const hook = createCoworkPreToolUseHook(BASE_CONFIG);
    const result = await hook('{"tool_name":"Bash","tool_input":');

    expect(result).toEqual(
      deny('SIGIL_COWORK_PAYLOAD_INVALID', 'Cowork PreToolUse payload is not valid JSON.'),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is re-exported from the package index', () => {
    expect(pkg.createCoworkPreToolUseHook).toBe(createCoworkPreToolUseHook);
  });
});
