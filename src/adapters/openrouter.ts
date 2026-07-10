import { buildRejectionContext } from '../rejection.js';
import { checkIntent } from '../interceptor.js';
import { checkModelBudget, recordModelUsage } from '../model-usage.js';
import type { SigilHookConfig, SigilHookResult, SigilRejectionContext } from '../types.js';
import { intentFromToolInput, mapToolAction, objectInput, valueAsString } from './shared.js';

export interface OpenRouterToolCall {
  id?: string;
  type?: 'function' | string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
}

export interface OpenRouterToolResultMessage {
  role: 'tool';
  tool_call_id?: string;
  content: string;
}

export interface OpenRouterToolGateAllowed {
  approved: true;
  name: string;
  args: Record<string, unknown>;
  result: SigilHookResult;
}

export interface OpenRouterToolGateBlocked {
  approved: false;
  name: string;
  args: Record<string, unknown>;
  rejection: SigilRejectionContext;
  toolResult: OpenRouterToolResultMessage;
}

export type OpenRouterToolGateResult = OpenRouterToolGateAllowed | OpenRouterToolGateBlocked;

export interface OpenRouterResponseUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | string;
}

export interface OpenRouterResponseLike {
  model?: string;
  provider?: string;
  usage?: OpenRouterResponseUsage;
}

export function createOpenRouterToolGate(
  config: SigilHookConfig,
  toolActionMap: Record<string, string> = {},
) {
  return async (toolCall: OpenRouterToolCall): Promise<OpenRouterToolGateResult> => {
    const name = toolCall.function?.name ?? '';
    const args = parseToolArguments(toolCall.function?.arguments);
    const action = toolActionMap[name] ?? mapToolAction(name);
    const intent = intentFromToolInput(action, args, {
      ...args,
      openrouter: {
        toolCallId: toolCall.id,
        originalFunctionName: name,
      },
    });
    const result = await checkIntent(
      intent,
      {
        ...config,
        framework: config.framework ?? 'openrouter',
        failMode: config.failMode ?? 'closed',
      },
    );

    if (result.decision === 'APPROVED') {
      return { approved: true, name, args, result };
    }

    const rejection = buildRejectionContext(result, intent.action);
    return {
      approved: false,
      name,
      args,
      rejection,
      toolResult: {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(rejection),
      },
    };
  };
}

export async function recordOpenRouterModelUsageAndCheckBudget(
  response: OpenRouterResponseLike,
  config: SigilHookConfig,
  taskId?: string,
): Promise<SigilHookResult> {
  const usage = response.usage ?? {};
  recordModelUsage({
    provider: response.provider,
    model: response.model,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    estimatedSpendUsd: normalizeCost(usage.cost),
  }, config, taskId);

  return await checkModelBudget(config, taskId);
}

function parseToolArguments(value: string | Record<string, unknown> | undefined): Record<string, unknown> {
  if (typeof value === 'string') {
    if (!value.trim()) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return objectInput(parsed);
    } catch {
      return {};
    }
  }
  return objectInput(value);
}

function normalizeCost(value: number | string | undefined): string | undefined {
  if (typeof value === 'number') return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return valueAsString(value);
}
