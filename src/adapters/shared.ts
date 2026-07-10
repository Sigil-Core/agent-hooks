import { HTTP_METHODS } from '../types.js';
import type { HttpMethod, SigilHookConfig, SigilIntent } from '../types.js';

export const TOOL_ACTION_MAP: Record<string, string> = {
  Bash: 'bash',
  bash: 'bash',
  terminal: 'bash',
  exec: 'bash',
  process: 'bash',
  code_execution: 'bash',
  apply_patch: 'file_write',
  Edit: 'file_write',
  Write: 'file_write',
  write: 'file_write',
  edit: 'file_write',
  write_file: 'file_write',
  patch: 'file_write',
  web_fetch: 'web_fetch',
  web_search: 'web_fetch',
  web_extract: 'web_fetch',
  WebFetch: 'web_fetch',
  WebSearch: 'web_fetch',
  x_search: 'web_fetch',
  browser: 'web_fetch',
  http: 'http',
  computer: 'bash',
  wallet_transfer: 'wallet.transfer',
  'wallet.transfer': 'wallet.transfer',
};

export function mapToolAction(toolName: string): string {
  return TOOL_ACTION_MAP[toolName] ?? toolName.toLowerCase();
}

export function valueAsString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function valueAsNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Returns an explicitly supplied, valid HTTP method. Methods are intentionally
 * not normalized: Sign requires uppercase values, and silently turning `get`
 * into `GET` would weaken validation at the adapter boundary.
 */
export function valueAsHttpMethod(value: unknown): HttpMethod | undefined {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value)
    ? value as HttpMethod
    : undefined;
}

function isWebAction(action: string): boolean {
  return action === 'http' || action === 'web_fetch';
}

/**
 * Promotes only known HTTP/web tool aliases to the typed `http` profile when a
 * method is explicitly present. No method means the legacy `web_fetch` alias;
 * an explicit non-empty invalid method stays typed with the method omitted so
 * Sign rejects it rather than silently treating it as an untyped fetch.
 */
function resolveWebAction(
  action: string,
  input: Record<string, unknown>,
): { action: string; method?: HttpMethod } {
  if (!isWebAction(action)) return { action };

  const rawMethod = input['method'];
  const hasNonEmptyExplicitMethod = rawMethod !== undefined
    && rawMethod !== null
    && (typeof rawMethod !== 'string' || rawMethod.length > 0);

  if (!hasNonEmptyExplicitMethod) return { action: 'web_fetch' };

  return {
    action: 'http',
    method: valueAsHttpMethod(rawMethod),
  };
}

export function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveTaskIdFromPayload(
  payload: Record<string, unknown>,
  config: SigilHookConfig,
): string | undefined {
  return config.taskId
    ?? valueAsString(payload['session_id'])
    ?? valueAsString(payload['conversation_id'])
    ?? valueAsString(payload['run_id'])
    ?? valueAsString(payload['turn_id'])
    ?? process.env['SIGIL_TASK_ID'];
}

export function intentFromToolInput(
  action: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): SigilIntent {
  const web = resolveWebAction(action, input);
  return {
    action: web.action,
    command: valueAsString(input['command']),
    url: valueAsString(input['url']),
    method: web.method,
    path: valueAsString(input['path']),
    to: valueAsString(input['to']) ?? valueAsString(input['targetAddress']),
    amount: valueAsString(input['amount']),
    chainId: valueAsNumber(input['chainId']) ?? valueAsNumber(input['chain_id']),
    txCommit: valueAsString(input['txCommit']) ?? valueAsString(input['tx_commit']),
    metadata,
  };
}
