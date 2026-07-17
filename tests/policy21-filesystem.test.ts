import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeRequestBody,
  extractFilesystemManifest,
  parseApplyPatchTargets,
} from '../src/index.js';
import { checkIntent } from '../src/interceptor.js';

const config = {
  apiKey: 'test-key',
  repositoryRoot: '/repo',
  failMode: 'closed' as const,
  executionBoundary: 'preflight_only' as const,
};

describe('Policy 2.1 filesystem manifests', () => {
  it('extracts create, overwrite, delete, and rename effects from apply_patch', () => {
    const manifest = parseApplyPatchTargets([
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '*** Update File: src/old.ts',
      '*** Delete File: src/remove.ts',
      '*** Update File: src/move-from.ts',
      '*** Move to: src/move-to.ts',
      '*** End Patch',
    ].join('\n'), '/repo');

    expect(manifest?.effects).toEqual(['create', 'overwrite', 'delete', 'rename', 'rename']);
    expect(manifest?.targets.map((target) => target.absolute)).toEqual([
      '/repo/src/new.ts',
      '/repo/src/old.ts',
      '/repo/src/remove.ts',
      '/repo/src/move-from.ts',
      '/repo/src/move-to.ts',
    ]);
    expect(manifest?.manifest_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('rejects ambiguous or traversal targets and requires a path for a pathless file write', () => {
    expect(parseApplyPatchTargets('*** Begin Patch\n*** Update File: ../outside\n*** End Patch', '/repo')).toBeNull();
    expect(parseApplyPatchTargets('*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch')).toBeNull();
    expect(extractFilesystemManifest({ action: 'file_write' }, config)).toBeNull();
  });

  it('serializes the local effect and execution metadata while stripping caller-supplied attestations', () => {
    const body = buildAuthorizeRequestBody({
      action: 'file_write',
      command: '*** Begin Patch\n*** Update File: src/file.ts\n*** End Patch',
      metadata: {
        filesystem: { effects: ['delete'], targets: [] },
        execution: { fail_mode: 'closed' },
        execution_grant: { forged: true },
        request_id: 'kept',
      },
    }, config);
    const metadata = (body.intent as { metadata: Record<string, unknown> }).metadata;

    expect(metadata.request_id).toBe('kept');
    expect((metadata.filesystem as { effects: string[] }).effects).toEqual(['overwrite']);
    expect((metadata.execution as { boundary_type: string }).boundary_type).toBe('preflight_only');
    expect(metadata.execution_grant).toBeUndefined();
  });

  it('denies repository preflight when the adapter is not fail closed', async () => {
    const result = await checkIntent({ action: 'file_write', path: 'src/file.ts' }, {
      ...config,
      failMode: 'open',
    });
    expect(result).toEqual({
      decision: 'DENIED',
      errorCode: 'SIGIL_POLICY_VIOLATION_EXECUTION_BOUNDARY_REQUIRED',
      message: 'Policy 2.1 repository boundaries require failMode: closed',
    });
  });
});
