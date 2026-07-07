import type { SigilHookConfig, SigilIntent } from '../types.js';

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
  http: 'web_fetch',
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
  metadata: Record<string, unknown>,
): SigilIntent {
  return {
    action,
    command: valueAsString(input['command']),
    url: valueAsString(input['url']),
    path: valueAsString(input['path']),
    to: valueAsString(input['to']) ?? valueAsString(input['targetAddress']),
    amount: valueAsString(input['amount']),
    chainId: valueAsNumber(input['chainId']) ?? valueAsNumber(input['chain_id']),
    txCommit: valueAsString(input['txCommit']) ?? valueAsString(input['tx_commit']),
    metadata,
  };
}
