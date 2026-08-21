import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/interceptor.js', () => ({
  checkIntent: vi.fn(async () => ({ decision: 'ALLOWED' })),
}));

vi.mock('../../src/decision.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/decision.js')>();
  return {
    ...original,
    authorizationPermitsExecution: (result: { decision: string }) =>
      result.decision === 'ALLOWED',
  };
});

import { wrapLangChainTool } from '../../src/adapters/langchain.js';

describe('forced raw-literal adapter mutant', () => {
  it('keeps the real wrapped action at zero executions', async () => {
    const execute = vi.fn(async () => 'executed');
    const tool = wrapLangChainTool(
      { name: 'Bash', call: execute },
      {
        apiKey: 'sk_sigil_test_key',
        apiUrl: 'https://sign-test.sigilcore.com',
        decisionVerificationMode: 'enforce',
        expectedPolicyHash: 'a'.repeat(64),
      },
    );

    const outcome = await tool.call('{"command":"echo mutant"}');

    expect({
      blocked: outcome.includes('"sigil_decision":"DENIED"'),
      executions: execute.mock.calls.length,
    }).toEqual({ blocked: true, executions: 0 });
  });
});
