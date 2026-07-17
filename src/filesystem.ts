import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';

export interface FileEffectTarget {
  supplied: string;
  absolute: string;
  resolved_parent: string;
  bytes?: number;
}

export interface FileEffectManifest {
  effects: string[];
  targets: FileEffectTarget[];
  manifest_sha256: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function manifestHash(value: Omit<FileEffectManifest, 'manifest_sha256'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function targetForPath(supplied: string, repositoryRoot?: string): FileEffectTarget | null {
  if (!supplied || supplied.includes('\0')) return null;
  const suppliedParts = supplied.replaceAll('\\', '/').split('/');
  if (suppliedParts.includes('..')) return null;
  const root = repositoryRoot ? normalize(repositoryRoot) : undefined;
  const absolute = root && !isAbsolute(supplied) ? normalize(join(root, supplied)) : normalize(supplied);
  if (!isAbsolute(absolute)) return null;
  const lastSlash = absolute.lastIndexOf('/');
  const resolvedParent = lastSlash > 0 ? absolute.slice(0, lastSlash) : '/';
  return { supplied, absolute, resolved_parent: resolvedParent };
}

/**
 * Extract every file target from the Codex apply_patch grammar. The parser is
 * deliberately narrow and returns null when any mutation target is ambiguous.
 */
export function parseApplyPatchTargets(patch: string, repositoryRoot?: string): FileEffectManifest | null {
  if (!patch.includes('*** Begin Patch')) return null;
  const targets: FileEffectTarget[] = [];
  const effects: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const add = line.match(/^\*\*\* Add File:\s*(.+)$/);
    const update = line.match(/^\*\*\* Update File:\s*(.+)$/);
    const remove = line.match(/^\*\*\* Delete File:\s*(.+)$/);
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/);
    const match = add ?? update ?? remove ?? move;
    if (!match) continue;
    const supplied = match[1]!.trim();
    const target = targetForPath(supplied, repositoryRoot);
    if (!target) return null;
    if (add) {
      targets.push(target);
      effects.push('create');
    } else if (update) {
      targets.push(target);
      effects.push('overwrite');
    } else if (remove) {
      targets.push(target);
      effects.push('delete');
    } else if (move) {
      const priorIndex = effects.length - 1;
      if (priorIndex < 0) return null;
      effects[priorIndex] = 'rename';
      targets.push(target);
      effects.push('rename');
    }
  }
  if (targets.length === 0) return null;
  const body = { effects, targets };
  return { ...body, manifest_sha256: manifestHash(body) };
}

export function buildSingleFileManifest(
  path: string | undefined,
  repositoryRoot: string | undefined,
  effect: string = 'overwrite',
): FileEffectManifest | null {
  if (!path) return null;
  const target = targetForPath(path, repositoryRoot);
  if (!target) return null;
  const body = { effects: [effect], targets: [target] };
  return { ...body, manifest_sha256: manifestHash(body) };
}
