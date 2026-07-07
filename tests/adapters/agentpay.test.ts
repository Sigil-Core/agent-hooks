import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAgentPayTransfer } from '../../src/adapters/agentpay.js';
import * as pkg from '../../src/index.js';
import type { SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  failMode: 'open',
};

describe('checkAgentPayTransfer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes AgentPay transfer fields into a wallet.transfer intent', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'hash_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await checkAgentPayTransfer({
      chainId: '56',
      recipient: '0xRecipient',
      amount: '1000000000000000000',
      txCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      token: 'USD1',
    }, BASE_CONFIG);

    expect(result.approved).toBe(true);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.framework).toBe('agentpay');
    expect(body.chainId).toBe(56);
    expect(body.intent.action).toBe('wallet.transfer');
    expect(body.intent.targetAddress).toBe('0xRecipient');
    expect(body.intent.amount).toBe('1000000000000000000');
    expect(body.intent.metadata.agentpay).toMatchObject({
      token: 'USD1',
      walletAction: 'wallet.transfer',
      recipient: '0xRecipient',
    });
  });

  it('normalizes hex EVM chain ids', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await checkAgentPayTransfer({
      chainId: '0x38',
      recipient: '0xRecipient',
      amount: '1',
    }, BASE_CONFIG);

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.chainId).toBe(56);
  });

  it('forces fail closed even if caller config defaults to open', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checkAgentPayTransfer({
      chainId: 1,
      to: '0xRecipient',
      amount: '1',
    }, BASE_CONFIG);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.rejection.sigil_error_code).toBe('SIGIL_UNREACHABLE');
    }

    warnSpy.mockRestore();
  });

  it('is re-exported from the package index', () => {
    expect(pkg.checkAgentPayTransfer).toBe(checkAgentPayTransfer);
  });
});
