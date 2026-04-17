// tests/interceptor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkIntent } from '../src/interceptor.js';
import type { SigilHookConfig, SigilIntent } from '../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

describe('checkIntent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns APPROVED for an allowed bash action', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'abc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const intent: SigilIntent = { action: 'bash', command: 'ls -la' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('APPROVED');
    expect(result.policyHash).toBe('abc123');
  });

  it('returns DENIED for a blocked bash command', async () => {
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

    const onDenied = vi.fn();
    const config = { ...BASE_CONFIG, onDenied };
    const intent: SigilIntent = { action: 'bash', command: 'rm -rf /' };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_BASH_BLOCKED');
    expect(result.message).toBe('rm -rf is not allowed');
    expect(onDenied).toHaveBeenCalledWith(intent, 'rm -rf is not allowed');
  });

  it('returns DENIED for a blocked domain in web_fetch', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_DOMAIN_BLOCKED',
          message: 'Domain evil.com is blocked',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const intent: SigilIntent = { action: 'web_fetch', url: 'https://evil.com/payload' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_DOMAIN_BLOCKED');
  });

  it('returns PENDING for email.send with require_approval', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'PENDING',
          holdId: 'hold_abc123',
          message: 'Email requires human approval',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const onPending = vi.fn();
    const config = { ...BASE_CONFIG, onPending };
    const intent: SigilIntent = { action: 'email.send', metadata: { to: 'ceo@example.com' } };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('PENDING');
    expect(result.holdId).toBe('hold_abc123');
    expect(onPending).toHaveBeenCalledWith(intent, 'hold_abc123');
  });

  it('returns APPROVED on network error (fail-open) with warn log', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { ...BASE_CONFIG, onError };
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('APPROVED');
    expect(result.message).toBe('Sigil unreachable — fail open');
    expect(onError).toHaveBeenCalledWith(intent, expect.any(Error));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('returns APPROVED on non-JSON response body (fail-open)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { ...BASE_CONFIG, onError };
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, config);

    expect(result.decision).toBe('APPROVED');
    expect(result.message).toBe('Sigil unreachable — fail open');
    expect(onError).toHaveBeenCalledWith(intent, expect.any(Error));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('preserves policyHash on DENIED result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_BASH_BLOCKED',
          message: 'Blocked',
          policyHash: 'policy_hash_xyz',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const intent: SigilIntent = { action: 'bash', command: 'rm -rf /' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.policyHash).toBe('policy_hash_xyz');
  });

  it('preserves policyHash on PENDING result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'PENDING',
          holdId: 'hold_abc',
          policyHash: 'policy_hash_pending',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const intent: SigilIntent = { action: 'email.send' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('PENDING');
    expect(result.policyHash).toBe('policy_hash_pending');
  });

  it('sends correct request shape to /v1/authorize', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const intent: SigilIntent = {
      action: 'wallet.transfer',
      to: '0xabc',
      amount: '1000000000000000000',
      chainId: 1,
    };
    await checkIntent(intent, { ...BASE_CONFIG, agentId: 'my-agent' });

    expect(fetch).toHaveBeenCalledWith(
      'https://sign.test.sigilcore.com/v1/authorize',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer sk_sigil_test_key',
        },
      }),
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.framework).toBe('agent-hooks');
    expect(body.agentId).toBe('my-agent');
    expect(body.intent.action).toBe('wallet.transfer');
    expect(body.intent.targetAddress).toBe('0xabc');
    expect(body.intent.amount).toBe('1000000000000000000');
    expect(body.chainId).toBe(1);
    expect(typeof body.txCommit).toBe('string');
  });

  it('uses custom framework from config when provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    await checkIntent(intent, { ...BASE_CONFIG, framework: 'openclaw' });

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.framework).toBe('openclaw');
  });

  describe('failMode: closed', () => {
    it('returns DENIED + SIGIL_UNREACHABLE when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const onError = vi.fn();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...BASE_CONFIG, failMode: 'closed' as const, onError };
      const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
      const result = await checkIntent(intent, config);

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).toBe('SIGIL_UNREACHABLE');
      expect(result.message).toBe('ECONNREFUSED');
      expect(onError).toHaveBeenCalledWith(intent, expect.any(Error));
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
