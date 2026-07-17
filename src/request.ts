import { createHash, randomUUID } from 'node:crypto';
import type { SigilHookConfig, SigilIntent } from './types.js';
import { buildSingleFileManifest, parseApplyPatchTargets, type FileEffectManifest } from './filesystem.js';

const DEFAULT_TASK_ID = randomUUID();

/**
 * Resolves the task identifier for execution-limit tracking.
 * Precedence is intent.taskId, then config.taskId, then a process-scoped default.
 *
 * @param intent - The authorization intent.
 * @param config - The hook configuration.
 * @returns The resolved task identifier.
 */
export function resolveTaskId(intent: SigilIntent, config: SigilHookConfig): string {
  return intent.taskId ?? config.taskId ?? DEFAULT_TASK_ID;
}

export function buildAuthorizeRequestBody(
  intent: SigilIntent,
  config: SigilHookConfig,
): Record<string, unknown> {
  const agentId = intent.agentId ?? config.agentId ?? 'agent';
  const txCommit = intent.txCommit ?? generateIntentCommit(intent);
  const taskId = resolveTaskId(intent, config);
  const metadataBase = intent.modelUsage
    ? { ...(intent.metadata ?? {}), model_usage: intent.modelUsage }
    : intent.metadata;
  const metadata: Record<string, unknown> = { ...(metadataBase ?? {}) };
  delete metadata['filesystem'];
  delete metadata['execution'];
  delete metadata['execution_grant'];

  const filesystem = extractFilesystemManifest(intent, config);
  if (filesystem) {
    metadata['filesystem'] = {
      cwd: process.cwd(),
      ...(config.repositoryRoot ? { repository_root: config.repositoryRoot } : {}),
      effects: filesystem.effects,
      targets: filesystem.targets,
      manifest_sha256: filesystem.manifest_sha256,
    };
  }
  if (config.repositoryRoot) {
    const roots = config.writableRoots ?? [config.repositoryRoot];
    metadata['execution'] = {
      adapter: 'agent-hooks-typescript',
      adapter_version: config.executionAdapterVersion ?? '2.1.0',
      fail_mode: config.failMode ?? 'open',
      boundary_type: config.executionBoundary ?? 'preflight_only',
      ...(config.mutationOwner ? { mutation_owner: config.mutationOwner } : {}),
      platform: process.platform,
      filesystem_types: ['host_attested'],
      case_behavior: 'host_attested',
      unicode_behavior: 'host_attested',
      writable_roots: roots,
      readable_roots: config.readableRoots ?? roots,
      credentials_exposed: false,
      race_safe_path_resolution: false,
      external_write_handles_exposed: true,
      special_files_allowed: false,
    };
  }

  return {
    framework: config.framework ?? 'agent-hooks',
    agentId,
    txCommit,
    chainId: intent.chainId,
    intent: {
      action: intent.action,
      command: intent.command,
      url: intent.url,
      method: intent.action === 'http' ? intent.method : undefined,
      path: intent.path,
      targetAddress: intent.to,
      amount: intent.amount,
      task_id: taskId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
  };
}

export function extractFilesystemManifest(
  intent: SigilIntent,
  config: SigilHookConfig,
): FileEffectManifest | null {
  if (intent.action !== 'file_write') return null;
  if (typeof intent.command === 'string' && intent.command.includes('*** Begin Patch')) {
    return parseApplyPatchTargets(intent.command, config.repositoryRoot);
  }
  return buildSingleFileManifest(intent.path, config.repositoryRoot);
}

export function serializeAuthorizeRequestBody(
  intent: SigilIntent,
  config: SigilHookConfig,
): string {
  return `${JSON.stringify(buildAuthorizeRequestBody(intent, config), null, 2)}\n`;
}

function generateIntentCommit(intent: SigilIntent): string {
  const preimage = JSON.stringify({
    action: intent.action,
    command: intent.command,
    url: intent.url,
    method: intent.action === 'http' ? intent.method : undefined,
    path: intent.path,
    to: intent.to,
    amount: intent.amount,
    ts: Math.floor(Date.now() / 1000),
  });
  return createHash('sha256').update(preimage).digest('hex');
}
