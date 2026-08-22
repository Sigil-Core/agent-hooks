// tests/interceptor-default-path.test.ts
//
// Before-and-after proof that the strictResponse addition leaves the default
// path byte-identical in behavior for every other adapter. Each assertion
// pins the pre-change (0.6.0) semantics of the default (non-strict) response
// handling; a strict-mode behavior leaking into the default path fails here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIntent } from '../src/interceptor.js';
import { createCodexPreToolUseHook } from '../src/adapters/codex.js';
import type { SigilHookConfig } from '../src/types.js';

const OPEN_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  decisionVerificationMode: 'warn',
};

describe('default response path is unchanged by the strictResponse addition', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('APPROVED with unknown extra fields still approves (default path is lenient)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"APPROVED","extra":"field","failOpen":true}', { status: 200 }),
    );
    const result = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(result.decision).toBe('ALLOWED');
  });

  it('camelCase policyHash is still read on the default path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"APPROVED","policyHash":"abc"}', { status: 200 }),
    );
    const result = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(result).toMatchObject({ decision: 'ALLOWED', policyHash: 'abc' });
  });

  it('malformed JSON denies without treating the reached response as unreachable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_RESPONSE_INVALID',
    });
    expect(result.failOpen).toBeUndefined();
  });

  it('PENDING with camelCase holdId is still honored on the default path', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"PENDING","holdId":"hold-camel"}', { status: 200 }),
    );
    const result = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(result).toMatchObject({ decision: 'PENDING', holdId: 'hold-camel' });
  });

  it('DENIED without error_code still defaults to SIGIL_POLICY_VIOLATION', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"DENIED"}', { status: 200 }),
    );
    const result = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_POLICY_VIOLATION',
    });
  });

  it('429 denies as a reached invalid response regardless of failMode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"retry":"later"}', { status: 429 }),
    );
    const open = await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    expect(open).toMatchObject({ decision: 'DENIED', errorCode: 'SIGIL_RESPONSE_INVALID' });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"retry":"later"}', { status: 429 }),
    );
    const closed = await checkIntent(
      { action: 'bash', command: 'ls' },
      { ...OPEN_CONFIG, failMode: 'closed' },
    );
    expect(closed).toMatchObject({ decision: 'DENIED', errorCode: 'SIGIL_RESPONSE_INVALID' });
  });

  it('the Codex adapter denies malformed 200 bodies as invalid responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const hook = createCodexPreToolUseHook(OPEN_CONFIG);
    const result = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(result?.hookSpecificOutput.permissionDecisionReason).toContain('SIGIL_RESPONSE_INVALID');
  });

  it('the wire body for a default-path adapter carries no arguments field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"APPROVED"}', { status: 200 }),
    );
    const hook = createCodexPreToolUseHook(OPEN_CONFIG);
    await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((call?.[1] as RequestInit).body as string) as {
      intent: Record<string, unknown>;
    };
    expect('arguments' in body.intent).toBe(false);
  });

  it('no AbortSignal is required for the default path and none is injected from config', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('{"status":"APPROVED"}', { status: 200 }),
    );
    await checkIntent({ action: 'bash', command: 'ls' }, OPEN_CONFIG);
    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    // The internal timeout controller signal is always present (pre-existing
    // behavior); it must not be pre-aborted.
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});
