import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAgentPayTransfer } from '../../src/adapters/agentpay.js';
import { checkAnthropicToolUse } from '../../src/adapters/claude.js';
import { createCodexPreToolUseHook } from '../../src/adapters/codex.js';
import { createCoworkPreToolUseHook } from '../../src/adapters/cowork.js';
import { checkElizaAction } from '../../src/adapters/eliza.js';
import { createHermesPreToolCallHook } from '../../src/adapters/hermes.js';
import { wrapLangChainTool } from '../../src/adapters/langchain.js';
import { createOpenclawSigilHandler } from '../../src/adapters/openclaw.js';
import { createOpenRouterToolGate } from '../../src/adapters/openrouter.js';
import { verifyAuthorizationResponse, type DecisionJwk } from '../../src/decision.js';
import type { SigilHookConfig } from '../../src/types.js';

vi.stubGlobal('fetch', vi.fn());

const CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign-test.sigilcore.com',
  decisionVerificationMode: 'enforce',
  expectedPolicyHash: 'a'.repeat(64),
};

const UNSIGNED_STATUSES = ['APPROVED', 'ALLOWED'] as const;
const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), 'tests/contract-fixtures/v1/decision-records.json'),
  'utf8',
)) as { publicJwk: DecisionJwk; tokens: Record<string, string> };

const expectVerificationDeny = (result: unknown, reason = 'record_missing'): void => {
  const evidence = typeof result === 'string' ? result : JSON.stringify(result);
  expect(evidence).toContain('SIGIL_DECISION_VERIFICATION_FAILED');
  expect(evidence).toContain(reason);
  expect(fetch).toHaveBeenCalledTimes(1);
};

const forgedBody = (status: typeof UNSIGNED_STATUSES[number]): Response => new Response(JSON.stringify({ status }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

const respondUnsigned = (status: typeof UNSIGNED_STATUSES[number]): void => {
  vi.mocked(fetch).mockImplementation(() => Promise.resolve(forgedBody(status)));
};

describe('adapter authorization seams reject unsigned canonical bodies in enforce mode', () => {
  it.each(UNSIGNED_STATUSES)('blocks the Anthropic seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await checkAnthropicToolUse({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'echo test' },
    }, CONFIG);
    expect(result).toMatchObject({ is_error: true });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the Codex seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await createCodexPreToolUseHook(CONFIG)({
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
    });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the Cowork seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await createCoworkPreToolUseHook(CONFIG)({
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
    });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the Eliza seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await checkElizaAction({ name: 'Bash', params: { command: 'echo test' } }, CONFIG);
    expect(result).toMatchObject({ blocked: true });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the Hermes seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await createHermesPreToolCallHook(CONFIG)({
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
    });
    expect(result).toMatchObject({ decision: 'block' });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the LangChain seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const call = vi.fn(() => Promise.resolve('executed'));
    const tool = wrapLangChainTool({ name: 'Bash', call }, CONFIG);
    const result = await tool.call('{"command":"echo test"}');
    expectVerificationDeny(result);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(UNSIGNED_STATUSES)('blocks the OpenClaw seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await createOpenclawSigilHandler(CONFIG)(
      { toolName: 'Bash', params: { command: 'echo test' } },
      { toolName: 'Bash' },
    );
    expect(result).toMatchObject({ block: true });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the OpenRouter seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await createOpenRouterToolGate(CONFIG)({
      id: 'call-1',
      function: { name: 'Bash', arguments: '{"command":"echo test"}' },
    });
    expect(result).toMatchObject({ approved: false });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('blocks the AgentPay seam for unsigned %s', async (status) => {
    respondUnsigned(status);
    const result = await checkAgentPayTransfer({
      chainId: 1,
      amount: '1',
      to: '0xabc',
    }, CONFIG);
    expect(result).toMatchObject({ approved: false });
    expectVerificationDeny(result);
  });

  it.each(UNSIGNED_STATUSES)('keeps unsigned %s live only in warn mode', async (status) => {
    const seam = await verifyAuthorizationResponse({ status }, {
      mode: 'warn',
      signOrigin: CONFIG.apiUrl as string,
      txCommit: '',
      requestNonce: '',
      surface: 'authorize',
    });
    expect(seam).toMatchObject({
      decision: 'ALLOWED',
      reason: 'record_missing',
      authorization: { kind: 'legacy-unverified' },
    });

    respondUnsigned(status);
    const result = await createCodexPreToolUseHook({
      ...CONFIG,
      decisionVerificationMode: 'warn',
    })({
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
    });
    expect(result).toBeUndefined();
  });

  it('blocks a present but signature-tampered frozen decision record at the adapter seam', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      status: 'ALLOWED',
      decision_record: fixture.tokens['tampered'],
      intent_attestation: fixture.tokens['attestation'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await createCodexPreToolUseHook({
      ...CONFIG,
      decisionRecordJwk: fixture.publicJwk,
    })({
      tool_name: 'Bash',
      tool_input: { command: 'echo test' },
    });
    expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expectVerificationDeny(result, 'signature');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
