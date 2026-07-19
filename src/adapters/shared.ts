import { HTTP_METHODS } from '../types.js';
import type { HttpMethod, SigilHookConfig, SigilIntent } from '../types.js';
import { decodeErc20Calldata } from '../evm-calldata.js';

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

const EVM_ACTIONS = ['wallet.transfer', 'contract.call'] as const;

function isEvmAction(action: string): boolean {
  return (EVM_ACTIONS as readonly string[]).includes(action);
}

/**
 * Accepts canonical non-negative decimal strings. Numeric inputs must be
 * non-negative safe integers so conversion cannot round an authorization
 * amount; callers use strings for fractional or larger values.
 */
function valueAsAmount(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

/** Normalizes raw contract calldata to lowercase, even-length, 0x-prefixed hex. */
function valueAsCalldata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const hex = trimmed.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return undefined;
  return `0x${hex.toLowerCase()}`;
}

function resolveEvmCalldata(input: Record<string, unknown>): string | undefined {
  const preferred = valueAsString(input['calldata']);
  if (preferred !== undefined) return valueAsCalldata(preferred);
  return valueAsCalldata(valueAsString(input['data']));
}

/** A supplied amount/value as a canonical decimal string. */
function resolveSuppliedEvmAmount(input: Record<string, unknown>): string | undefined {
  const amount = valueAsAmount(input['amount']);
  if (amount !== undefined) return amount;
  const value = valueAsAmount(input['value']);
  if (value !== undefined) return value;
  return undefined;
}

/**
 * EVM intents always carry an amount when the tool input can prove one.
 * Sign fails closed on a missing amount under Policy 2.1 (and under the
 * SIGIL_EVM_AMOUNT_REQUIRED deployment flag for legacy policies), so:
 * - a supplied amount/value field is passed through verbatim;
 * - a contract.call whose input carries neither an amount nor a value key
 *   provably moves no native value in the tool's own schema → "0";
 * - a wallet.transfer without any amount stays absent on purpose — the
 *   adapter cannot prove the transfer's value, and inventing "0" would let
 *   an unknown-value transfer pass under the cap. Sign denies it.
 */
function resolveEvmAmount(action: string, input: Record<string, unknown>): string | undefined {
  const supplied = resolveSuppliedEvmAmount(input);
  if (supplied !== undefined) return supplied;
  if (action === 'contract.call' && !('amount' in input) && !('value' in input)) return '0';
  return undefined;
}

export function intentFromToolInput(
  action: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): SigilIntent {
  const web = resolveWebAction(action, input);
  const evm = isEvmAction(web.action);
  const calldata = web.action === 'contract.call'
    ? resolveEvmCalldata(input)
    : undefined;
  const decodedCalldata = web.action === 'contract.call'
    ? decodeErc20Calldata(valueAsString(input['to']) ?? valueAsString(input['targetAddress']), calldata)
    : undefined;
  const mergedMetadata = decodedCalldata
    ? { ...(metadata ?? {}), evm: decodedCalldata }
    : metadata;
  return {
    action: web.action,
    command: valueAsString(input['command']),
    url: valueAsString(input['url']),
    method: web.method,
    path: valueAsString(input['path']),
    to: valueAsString(input['to']) ?? valueAsString(input['targetAddress']),
    amount: evm ? resolveEvmAmount(web.action, input) : valueAsString(input['amount']),
    calldata,
    chainId: valueAsNumber(input['chainId']) ?? valueAsNumber(input['chain_id']),
    txCommit: valueAsString(input['txCommit']) ?? valueAsString(input['tx_commit']),
    metadata: mergedMetadata,
  };
}
