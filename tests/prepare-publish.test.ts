import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildArtifactManifest,
  determinePublication,
  packArtifact,
  writeGithubOutputs,
} from '../scripts/prepare-publish.mjs';
import { PREDICATE_TYPE } from '../scripts/verify-published-release.mjs';

const packageJson = {
  name: '@sigilcore/agent-hooks',
  version: '0.10.2',
  repository: { url: 'git+https://github.com/Sigil-Core/agent-hooks.git' },
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

describe('prepare exact publication artifact', () => {
  it('computes sha1 and sha512 over the exact tarball bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prepare-publish-test-'));
    const tarball = join(directory, 'package.tgz');
    writeFileSync(tarball, 'exact bytes');
    const artifact = buildArtifactManifest(packageJson, tarball);
    expect(artifact).toMatchObject({ name: packageJson.name, version: packageJson.version, size: 11 });
    expect(artifact.shasum).toMatch(/^[0-9a-f]{40}$/);
    expect(artifact.integrity).toMatch(/^sha512-/);
  });

  it('packs exactly one artifact into an isolated directory', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'prepare-publish-root-'));
    const pack = vi.fn((args: string[]) => {
      const directory = args[args.indexOf('--pack-destination') + 1];
      writeFileSync(join(directory, 'sigilcore-agent-hooks-0.10.2.tgz'), 'package');
      return JSON.stringify([{ filename: 'sigilcore-agent-hooks-0.10.2.tgz' }]);
    });
    const artifact = packArtifact(packageJson, { pack, outputRoot });
    expect(artifact.tarball).toContain('agent-hooks-pack-');
    expect(pack).toHaveBeenCalledOnce();
  });

  it('publishes only when the exact version is absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ name: packageJson.name, versions: {} }));
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    await expect(determinePublication(packageJson, artifact, { fetchImpl })).resolves.toMatchObject({
      publishRequired: true,
    });
  });

  it('rejects malformed package metadata before publication', async () => {
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const sleep = vi.fn(() => Promise.resolve());
    await expect(determinePublication(packageJson, artifact, {
      fetchImpl,
      sleep,
    })).rejects.toThrow(/npm package document is malformed/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();

    await expect(determinePublication(packageJson, artifact, {
      fetchImpl: vi.fn().mockResolvedValue(response({ name: packageJson.name, versions: {} })),
    })).resolves.toMatchObject({ publishRequired: true });
  });

  it('rejects invalid registry JSON without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('invalid JSON')),
    } as Response);
    const sleep = vi.fn(() => Promise.resolve());
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    await expect(determinePublication(packageJson, artifact, {
      fetchImpl,
      sleep,
    })).rejects.toThrow(/returned invalid JSON/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails closed after bounded transient package-document 404s', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, 404));
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    let clock = 0;
    await expect(determinePublication(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 5,
      retryDelayMs: 2,
    })).rejects.toThrow(/publication preparation exceeded 5 ms/);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('skips publication only for an exact existing release', async () => {
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    const metadata = {
      ...packageJson,
      dist: {
        shasum: artifact.shasum,
        integrity: artifact.integrity,
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigilcore%2fagent-hooks@0.10.2',
          provenance: { predicateType: PREDICATE_TYPE },
        },
      },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({
      name: packageJson.name,
      versions: { '0.10.2': metadata },
      'dist-tags': { latest: '0.10.2' },
    }));
    await expect(determinePublication(packageJson, artifact, { fetchImpl })).resolves.toMatchObject({
      publishRequired: false,
    });
  });

  it('fails closed when an existing immutable version differs', async () => {
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    const metadata = {
      ...packageJson,
      dist: {
        shasum: 'b'.repeat(40),
        integrity: artifact.integrity,
      },
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({
      name: packageJson.name,
      versions: { '0.10.2': metadata },
      'dist-tags': { latest: '0.10.2' },
    }));
    await expect(determinePublication(packageJson, artifact, { fetchImpl })).rejects.toThrow(/sha1/);
  });

  it('waits for bounded provenance and latest propagation without republishing', async () => {
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    const exact = {
      ...packageJson,
      dist: {
        shasum: artifact.shasum,
        integrity: artifact.integrity,
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigilcore%2fagent-hooks@0.10.2',
          provenance: { predicateType: PREDICATE_TYPE },
        },
      },
    };
    const delayed = { ...exact, dist: { ...exact.dist, attestations: undefined } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({
        name: packageJson.name,
        versions: { '0.10.2': delayed },
        'dist-tags': { latest: '0.10.1' },
      }))
      .mockResolvedValueOnce(response(exact))
      .mockResolvedValueOnce(response({ 'dist-tags': { latest: '0.10.2' } }));
    let clock = 0;
    await expect(determinePublication(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 10,
      retryDelayMs: 1,
    })).resolves.toMatchObject({ publishRequired: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('shares one deadline across availability and propagation retries', async () => {
    const artifact = {
      name: packageJson.name,
      version: packageJson.version,
      tarball: '/tmp/package.tgz',
      size: 1,
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    };
    const delayed = {
      ...packageJson,
      dist: {
        shasum: artifact.shasum,
        integrity: artifact.integrity,
      },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({
        name: packageJson.name,
        versions: { '0.10.2': delayed },
        'dist-tags': { latest: '0.10.1' },
      }))
      .mockResolvedValueOnce(response({}, 503));
    let clock = 0;
    await expect(determinePublication(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 10,
      retryDelayMs: 9,
    })).rejects.toThrow(/publication preparation exceeded 10 ms/);
    expect(clock).toBeLessThanOrEqual(10);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('writes escaped GitHub outputs without exposing artifact bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prepare-publish-output-'));
    const output = join(directory, 'github-output');
    writeGithubOutputs(output, { publish_required: true, tarball: '/tmp/a%b.tgz' });
    expect(readFileSync(output, 'utf8')).toBe('publish_required=true\ntarball=/tmp/a%25b.tgz\n');
  });
});
