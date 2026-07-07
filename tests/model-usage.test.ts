import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkModelBudget,
  clearModelUsage,
  getModelUsageReport,
  normalizeModelUsage,
  recordModelUsage,
} from '../src/model-usage.js';
import { buildAuthorizeRequestBody } from '../src/request.js';
import { buildRejectionContext } from '../src/rejection.js';
import type { SigilHookConfig } from '../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
  taskId: 'task-model-1',
};

describe('model usage ledger', () => {
  afterEach(() => {
    clearModelUsage(BASE_CONFIG);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('normalizes provider usage into Sigil model_usage shape', () => {
    expect(normalizeModelUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20260601',
      inputTokens: 12,
      outputTokens: 3,
      estimatedSpendUsd: '0.1425',
    })).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20260601',
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      estimated_spend_usd: '0.1425',
    });
  });

  it('accumulates task-local token and spend usage', () => {
    recordModelUsage({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20260601',
      inputTokens: 100,
      outputTokens: 50,
      estimatedSpendUsd: '0.100001',
    }, BASE_CONFIG);

    const report = recordModelUsage({
      inputTokens: 10,
      outputTokens: 5,
      estimatedSpendUsd: '0.000009',
    }, BASE_CONFIG);

    expect(report).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20260601',
      input_tokens: 110,
      output_tokens: 55,
      total_tokens: 165,
      estimated_spend_usd: '0.10001',
    });
    expect(getModelUsageReport(BASE_CONFIG)).toEqual(report);
  });

  it('evicts stale model usage after the task TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));

    recordModelUsage({
      inputTokens: 100,
      outputTokens: 25,
      estimatedSpendUsd: '0.25',
    }, BASE_CONFIG);

    vi.setSystemTime(new Date('2026-07-08T11:59:59Z'));
    expect(getModelUsageReport(BASE_CONFIG)).toBeDefined();

    vi.setSystemTime(new Date('2026-07-08T12:00:00Z'));
    expect(getModelUsageReport(BASE_CONFIG)).toBeDefined();

    vi.setSystemTime(new Date('2026-07-08T12:00:01Z'));

    expect(getModelUsageReport(BASE_CONFIG)).toBeUndefined();
  });

  it('serializes model usage into intent metadata', () => {
    const body = buildAuthorizeRequestBody({
      action: 'model.inference',
      taskId: 'task-model-1',
      modelUsage: {
        total_tokens: 123,
        estimated_spend_usd: '0.50',
      },
      metadata: {
        source: 'unit-test',
      },
    }, BASE_CONFIG);

    expect(body).toMatchObject({
      intent: {
        action: 'model.inference',
        task_id: 'task-model-1',
        metadata: {
          source: 'unit-test',
          model_usage: {
            total_tokens: 123,
            estimated_spend_usd: '0.50',
          },
        },
      },
    });
  });

  it('checks the current cumulative model budget against Sigil Sign', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'APPROVED', policyHash: 'hash_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ));

    recordModelUsage({
      inputTokens: 100,
      outputTokens: 25,
      estimatedSpendUsd: '0.25',
    }, BASE_CONFIG);

    const result = await checkModelBudget(BASE_CONFIG);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const body = JSON.parse(init!.body as string);

    expect(url).toBe('https://sign.test.sigilcore.com/v1/authorize');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BASE_CONFIG.apiKey}`,
    });
    expect(result).toMatchObject({ decision: 'APPROVED', policyHash: 'hash_123' });
    expect(body.chainId).toBe(1);
    expect(body.intent).toMatchObject({
      action: 'model.inference',
      task_id: 'task-model-1',
      metadata: {
        model_usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          estimated_spend_usd: '0.25',
        },
      },
    });
  });

  it('builds hard-stop context for model budget denials', () => {
    const rejection = buildRejectionContext({
      decision: 'DENIED',
      errorCode: 'SIGIL_MODEL_TOKEN_LIMIT_EXCEEDED',
      message: 'Model token usage 50001 exceeded per-task cap 50000 for task_id task-model-1',
      taskId: 'task-model-1',
    }, 'model.inference');

    expect(rejection).toMatchObject({
      sigil_decision: 'DENIED',
      sigil_error_code: 'SIGIL_MODEL_TOKEN_LIMIT_EXCEEDED',
      sigil_task_id: 'task-model-1',
      sigil_action_taken: 'halted',
    });
    expect(rejection.sigil_next_steps).toContain('Do not start another model call');
  });

  it('builds hard-stop context for model spend limit denials', () => {
    const rejection = buildRejectionContext({
      decision: 'DENIED',
      errorCode: 'SIGIL_MODEL_SPEND_LIMIT_EXCEEDED',
      message: 'Model spend exceeded cap for task_id task-model-1',
      taskId: 'task-model-1',
    }, 'model.inference');

    expect(rejection).toMatchObject({
      sigil_decision: 'DENIED',
      sigil_error_code: 'SIGIL_MODEL_SPEND_LIMIT_EXCEEDED',
      sigil_task_id: 'task-model-1',
      sigil_action_taken: 'halted',
    });
    expect(rejection.sigil_next_steps).toContain('Do not start another model call');
  });

  it('builds fail-closed context when model usage is unavailable', () => {
    const rejection = buildRejectionContext({
      decision: 'DENIED',
      errorCode: 'SIGIL_MODEL_USAGE_UNAVAILABLE',
      message: 'No model usage recorded for task_id task-model-1',
      taskId: 'task-model-1',
    }, 'model.inference');

    expect(rejection).toMatchObject({
      sigil_decision: 'DENIED',
      sigil_error_code: 'SIGIL_MODEL_USAGE_UNAVAILABLE',
      sigil_task_id: 'task-model-1',
      sigil_action_taken: 'halted',
    });
    expect(rejection.sigil_next_steps).toContain('requires model usage reporting');
  });
});
