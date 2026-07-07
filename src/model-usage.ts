import { resolveTaskId } from './request.js';
import type {
  SigilHookConfig,
  SigilHookResult,
  SigilModelUsage,
  SigilModelUsageReport,
} from './types.js';
import { checkIntent } from './interceptor.js';

const MODEL_USAGE_TTL_MS = 24 * 60 * 60 * 1000;

interface ModelUsageEntry {
  report: SigilModelUsageReport;
  updatedAt: number;
}

const usageByTask = new Map<string, ModelUsageEntry>();

function evictExpiredModelUsage(now = Date.now()): void {
  for (const [taskId, entry] of usageByTask) {
    if (now - entry.updatedAt > MODEL_USAGE_TTL_MS) {
      usageByTask.delete(taskId);
    }
  }
}

function toSafeInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeSpend(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new Error('estimatedSpendUsd must be a decimal string with up to 6 fractional digits');
  }
  return value;
}

function addDecimalStrings(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;

  const micros = decimalToMicros(a) + decimalToMicros(b);
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function decimalToMicros(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

export function normalizeModelUsage(usage: SigilModelUsage): SigilModelUsageReport {
  const inputTokens = toSafeInteger(usage.inputTokens, 'inputTokens');
  const outputTokens = toSafeInteger(usage.outputTokens, 'outputTokens');
  const explicitTotal = toSafeInteger(usage.totalTokens, 'totalTokens');
  const totalTokens = explicitTotal ?? (inputTokens ?? 0) + (outputTokens ?? 0);

  return {
    provider: usage.provider,
    model: usage.model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_spend_usd: normalizeSpend(usage.estimatedSpendUsd),
  };
}

export function recordModelUsage(
  usage: SigilModelUsage,
  config: SigilHookConfig,
  taskId?: string,
): SigilModelUsageReport {
  evictExpiredModelUsage();
  const resolvedTaskId = taskId ?? config.taskId ?? resolveTaskId({ action: 'model.inference' }, config);
  const previous = usageByTask.get(resolvedTaskId)?.report;
  const next = normalizeModelUsage(usage);
  const cumulative: SigilModelUsageReport = {
    provider: next.provider ?? previous?.provider,
    model: next.model ?? previous?.model,
    input_tokens: (previous?.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (previous?.output_tokens ?? 0) + (next.output_tokens ?? 0),
    total_tokens: (previous?.total_tokens ?? 0) + next.total_tokens,
    estimated_spend_usd: addDecimalStrings(
      previous?.estimated_spend_usd,
      next.estimated_spend_usd,
    ),
  };

  usageByTask.set(resolvedTaskId, { report: cumulative, updatedAt: Date.now() });
  return cumulative;
}

export function getModelUsageReport(
  config: SigilHookConfig,
  taskId?: string,
): SigilModelUsageReport | undefined {
  evictExpiredModelUsage();
  return usageByTask.get(taskId ?? config.taskId ?? resolveTaskId({ action: 'model.inference' }, config))?.report;
}

export function clearModelUsage(config: SigilHookConfig, taskId?: string): void {
  usageByTask.delete(taskId ?? config.taskId ?? resolveTaskId({ action: 'model.inference' }, config));
}

export async function checkModelBudget(
  config: SigilHookConfig,
  taskId?: string,
): Promise<SigilHookResult> {
  evictExpiredModelUsage();
  const resolvedTaskId = taskId ?? config.taskId ?? resolveTaskId({ action: 'model.inference' }, config);
  const report = usageByTask.get(resolvedTaskId)?.report;

  return checkIntent(
    {
      action: 'model.inference',
      chainId: 1,
      taskId: resolvedTaskId,
      metadata: report ? { model_usage: report } : undefined,
    },
    config,
  );
}
