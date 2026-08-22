// tests/interceptor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkIntent } from '../src/interceptor.js';
import { isTransportFailOpenAuthorization } from '../src/decision.js';
import { SIGIL_UNREACHABLE } from '../src/types.js';
import type { SigilHookConfig, SigilIntent } from '../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  decisionVerificationMode: 'warn',
};

describe('checkIntent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to enforce and fails before network access without a policy pin', async () => {
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        apiKey: BASE_CONFIG.apiKey,
        apiUrl: BASE_CONFIG.apiUrl,
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses enforce verification when the mode is omitted and a policy pin exists', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ status: 'ALLOWED' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        apiKey: BASE_CONFIG.apiKey,
        apiUrl: BASE_CONFIG.apiUrl,
        expectedPolicyHash: 'a'.repeat(64),
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
      message: expect.stringContaining('record_missing'),
    });
    expect(result.authorization).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed before network access when enforce mode has no policy pin', async () => {
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      { ...BASE_CONFIG, decisionVerificationMode: 'enforce' },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '<html>not json</html>'],
    ['invalid shape', JSON.stringify({ status: 'ALLOWED', policyHash: 7 })],
  ])(
    'denies reachable %s in enforce plus fail-open mode',
    async (_case, body) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await checkIntent(
        { action: 'bash', command: 'ls -la' },
        {
          ...BASE_CONFIG,
          failMode: 'open',
          decisionVerificationMode: 'enforce',
          expectedPolicyHash: 'a'.repeat(64),
        },
      );

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).not.toBe(SIGIL_UNREACHABLE);
      expect(result.failOpen).toBeUndefined();
      expect(result.authorization).toBeUndefined();
    },
  );

  it.each([429, 500])(
    'denies reached HTTP %i in enforce plus fail-open mode',
    async (status) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'ALLOWED' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await checkIntent(
        { action: 'bash', command: 'ls -la' },
        {
          ...BASE_CONFIG,
          failMode: 'open',
          decisionVerificationMode: 'enforce',
          expectedPolicyHash: 'a'.repeat(64),
        },
      );

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).not.toBe(SIGIL_UNREACHABLE);
      expect(result.failOpen).toBeUndefined();
      expect(result.authorization).toBeUndefined();
    },
  );

  it('denies a reached redirect without minting transport fail-open authorization', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example/authorize' },
    }));
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      { ...BASE_CONFIG, failMode: 'open' },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_RESPONSE_INVALID',
    });
    expect(isTransportFailOpenAuthorization(result)).toBe(false);
    expect((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');
  });

  it('logs one missing policy-binding diagnostic on every warn-mode call', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({ status: 'ALLOWED' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await checkIntent({ action: 'bash', command: 'first' }, BASE_CONFIG);
    await checkIntent({ action: 'bash', command: 'second' }, BASE_CONFIG);

    const policyBindingDiagnostics = warnSpy.mock.calls
      .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
      .filter((entry) => entry['reason'] === 'policy_binding');
    expect(policyBindingDiagnostics).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('denies a verifier diagnostic exception in enforce plus fail-open mode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'ALLOWED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });

    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        ...BASE_CONFIG,
        failMode: 'open',
        decisionVerificationMode: 'enforce',
        expectedPolicyHash: 'a'.repeat(64),
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(result.failOpen).toBeUndefined();
    expect(result.authorization).toBeUndefined();
  });

  it('fails closed before network access on invalid enforce trust config', async () => {
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        ...BASE_CONFIG,
        apiUrl: 'http://sign.test.sigilcore.com/v1',
        decisionVerificationMode: 'enforce',
        expectedPolicyHash: 'NOT-A-PIN',
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTPS Sign origin before bearer transmission in warn mode', async () => {
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        ...BASE_CONFIG,
        apiUrl: 'http://sign.test.sigilcore.com',
        decisionVerificationMode: 'warn',
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a trailing slash on the exact canonical Sign origin', async () => {
    const result = await checkIntent(
      { action: 'bash', command: 'ls -la' },
      {
        ...BASE_CONFIG,
        apiUrl: 'https://sign.test.sigilcore.com/',
        decisionVerificationMode: 'warn',
      },
    );

    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_DECISION_VERIFICATION_FAILED',
    });
    expect(fetch).not.toHaveBeenCalled();
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

    expect(result.decision).toBe('ALLOWED');
    expect(result.policyHash).toBe('abc123');
  });

  it('preserves atomic response-policy authorization material for local verification', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'APPROVED',
          policy_hash: 'a'.repeat(64),
          intent_attestation: 'header.payload.signature',
          compiled_response_policy: 'policy.payload.signature',
          compiled_policy_digest: 'b'.repeat(64),
          compiled_policy_envelope_digest: 'c'.repeat(64),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await checkIntent(
      { action: 'mcp.example.server.fetch', taskId: 'task-1' },
      { ...BASE_CONFIG, failMode: 'closed' },
    );

    expect(result).toMatchObject({
      decision: 'ALLOWED',
      policyHash: 'a'.repeat(64),
      intentAttestation: 'header.payload.signature',
      responsePolicy: {
        compactJws: 'policy.payload.signature',
        compiledPolicyDigest: 'b'.repeat(64),
        envelopeDigest: 'c'.repeat(64),
      },
    });
  });

  it.each([
    {
      compiled_response_policy: 'policy.payload.signature',
    },
    {
      compiled_response_policy: 'policy.payload.signature',
      compiled_policy_digest: 'b'.repeat(64),
    },
    {
      compiled_response_policy: 7,
      compiled_policy_digest: 'b'.repeat(64),
      compiled_policy_envelope_digest: 'c'.repeat(64),
    },
    {
      compiled_response_policy: null,
      compiled_policy_digest: null,
      compiled_policy_envelope_digest: null,
    },
    {
      compiled_response_policy: 'policy.payload.signature',
      compiled_policy_digest: null,
      compiled_policy_envelope_digest: 'c'.repeat(64),
    },
  ])('fails closed for a partial or malformed response-policy triple: %#', async (fields) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', ...fields }), { status: 200 }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await checkIntent(
      { action: 'mcp.example.server.fetch' },
      { ...BASE_CONFIG, failMode: 'closed' },
    );
    expect(result).toMatchObject({
      decision: 'DENIED',
      errorCode: 'SIGIL_RESPONSE_INVALID',
    });
    warnSpy.mockRestore();
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

    expect(result.decision).toBe('ALLOWED');
    expect(result.message).toBe('Sigil unreachable — fail open');
    expect(result.failOpen).toBe(true);
    expect(onError).toHaveBeenCalledWith(intent, expect.any(Error));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('denies a reached non-JSON response without fail-open', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');
    expect(result.failOpen).toBeUndefined();
    expect(result.authorization).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it.each([
    ['a null response body', null],
    ['a pending response without a hold ID', { status: 'PENDING' }],
    ['an unknown response status', { status: 'UNKNOWN' }],
    ['a non-string policy hash', { status: 'APPROVED', policyHash: 7 }],
  ])('denies reached malformed response %s', async (_label, body) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onPending = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await checkIntent(
      { action: 'bash', command: 'echo hello' },
      { ...BASE_CONFIG, failMode: 'closed', onPending },
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');
    expect(result.failOpen).toBeUndefined();
    expect(result.authorization).toBeUndefined();
    expect(onPending).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not route local serialization errors through fail-open handling', async () => {
    const intent: SigilIntent = {
      action: 'bash',
      command: 'echo hello',
      metadata: { unsupported: 1n },
    };

    await expect(checkIntent(intent, BASE_CONFIG)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves an explicit denial with null optional response fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'DENIED',
        error_code: 'SIGIL_BASH_BLOCKED',
        message: 'blocked',
        hold_id: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'rm -rf /' },
      BASE_CONFIG,
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_BASH_BLOCKED');
    expect(result.failOpen).toBeUndefined();
  });

  it('denies malformed pending responses in open mode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'PENDING', hold_id: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'echo hello' },
      BASE_CONFIG,
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');
    expect(result.failOpen).toBeUndefined();
    expect(result.authorization).toBeUndefined();
  });

  it('returns an authentication failure for a 403 without a policy decision', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Forbidden API key' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'echo hello' },
      BASE_CONFIG,
    );

    expect(result).toEqual({
      decision: 'DENIED',
      errorCode: 'SIGIL_AUTH_FAILURE',
      message: 'Authentication failed (403)',
    });
  });

  it('returns an authentication failure for a non-JSON 403 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html>Forbidden</html>', {
        status: 403,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'echo hello' },
      BASE_CONFIG,
    );

    expect(result).toEqual({
      decision: 'DENIED',
      errorCode: 'SIGIL_AUTH_FAILURE',
      message: 'Authentication failed (403)',
    });
  });

  it('preserves an explicit policy denial returned with HTTP 403', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_BASH_BLOCKED',
          message: 'Command blocked by policy',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'rm -rf /' },
      BASE_CONFIG,
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_BASH_BLOCKED');
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

  it('accepts camelCase and snake_case response aliases', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          errorCode: 'SIGIL_CAMEL_CASE',
          policy_hash: 'policy_hash_alias',
          message: 'alias form',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await checkIntent({ action: 'bash' }, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_CAMEL_CASE');
    expect(result.policyHash).toBe('policy_hash_alias');
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
    expect(typeof body.intent.task_id).toBe('string');
  });

  it('sends a configured task_id on every authorize call', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await checkIntent(
      { action: 'bash', command: 'npm test' },
      { ...BASE_CONFIG, taskId: 'task-configured' },
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.intent.task_id).toBe('task-configured');
  });

  it('lets the intent taskId override the configured taskId', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await checkIntent(
      { action: 'bash', command: 'npm test', taskId: 'task-intent' },
      { ...BASE_CONFIG, taskId: 'task-configured' },
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.intent.task_id).toBe('task-intent');
  });

  it('returns a hard-stop denial when Sigil reports a loop ceiling', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_LOOP_LIMIT_EXCEEDED',
          message: 'Tool call count 51 exceeded per-task ceiling 50.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'npm test' },
      { ...BASE_CONFIG, taskId: 'task-loop' },
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_LOOP_LIMIT_EXCEEDED');
    expect(result.taskId).toBe('task-loop');
    expect(result.message).toContain('Hard-stop this agent run');
    expect(result.message).toContain('task_id task-loop');
  });

  it('surfaces loop store failures as distinct fail-closed denials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'DENIED',
          error_code: 'SIGIL_LIMIT_STORE_UNAVAILABLE',
          message: 'Execution limit store unavailable.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await checkIntent(
      { action: 'bash', command: 'npm test' },
      { ...BASE_CONFIG, taskId: 'task-loop' },
    );

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_LIMIT_STORE_UNAVAILABLE');
    expect(result.message).toContain('failed closed');
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

  it('returns a non-transport denial on 5xx in open mode', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, BASE_CONFIG);

    expect(result.decision).toBe('DENIED');
    expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');
    expect(result.failOpen).toBeUndefined();

    warnSpy.mockRestore();
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

    it('logs sigil_hook_unreachable at error level in closed mode', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...BASE_CONFIG, failMode: 'closed' as const };
      const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
      await checkIntent(intent, config);

      const payload = warnSpy.mock.calls
        .map(([value]) => JSON.parse(value as string))
        .find((entry) => entry.event === 'sigil_hook_unreachable');
      expect(payload).toBeDefined();
      expect(payload.event).toBe('sigil_hook_unreachable');
      expect(payload.level).toBe('error');
      expect(payload.failMode).toBe('closed');
      expect(payload.action).toBe('bash');
      expect(payload.message).toBe('ECONNREFUSED');

      warnSpy.mockRestore();
    });

    it('returns a non-transport denial on 500 response in closed mode', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'APPROVED' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...BASE_CONFIG, failMode: 'closed' as const };
      const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
      const result = await checkIntent(intent, config);

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');

      warnSpy.mockRestore();
    });

    it('returns a non-transport denial on 502/503 in closed mode', async () => {
      for (const status of [502, 503]) {
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response(JSON.stringify({}), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = { ...BASE_CONFIG, failMode: 'closed' as const };
        const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
        const result = await checkIntent(intent, config);

        expect(result.decision).toBe('DENIED');
        expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');
        warnSpy.mockRestore();
      }
    });

    it('returns a non-transport denial when a reached response is not JSON', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...BASE_CONFIG, failMode: 'closed' as const };
      const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
      const result = await checkIntent(intent, config);

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).toBe('SIGIL_RESPONSE_INVALID');

      warnSpy.mockRestore();
    });

    it('returns DENIED + SIGIL_UNREACHABLE when fetch times out (closed mode)', async () => {
      vi.mocked(fetch).mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = (init as RequestInit | undefined)?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted.');
                err.name = 'AbortError';
                reject(err);
              });
            }
          }),
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...BASE_CONFIG, failMode: 'closed' as const, requestTimeoutMs: 10 };
      const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
      const result = await checkIntent(intent, config);

      expect(result.decision).toBe('DENIED');
      expect(result.errorCode).toBe('SIGIL_UNREACHABLE');

      warnSpy.mockRestore();
    });
  });

  it('returns APPROVED + failOpen:true when fetch times out (open mode)', async () => {
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.');
              err.name = 'AbortError';
              reject(err);
            });
          }
        }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    const result = await checkIntent(intent, { ...BASE_CONFIG, requestTimeoutMs: 10 });

    expect(result.decision).toBe('ALLOWED');
    expect(result.failOpen).toBe(true);

    warnSpy.mockRestore();
  });

  it('logs sigil_hook_unreachable at warn level in open mode (default)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const intent: SigilIntent = { action: 'bash', command: 'echo hello' };
    await checkIntent(intent, BASE_CONFIG);

    const payload = warnSpy.mock.calls
      .map(([value]) => JSON.parse(value as string))
      .find((entry) => entry.event === 'sigil_hook_unreachable');
    expect(payload).toBeDefined();
    expect(payload.event).toBe('sigil_hook_unreachable');
    expect(payload.level).toBe('warn');
    expect(payload.failMode).toBe('open');

    warnSpy.mockRestore();
  });
});
