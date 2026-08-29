import { describe, expect, it, vi } from 'vitest';
import {
  PREDICATE_TYPE,
  RegistryRequestError,
  fetchJson,
  verifyPublishedRelease,
  verifyRegistryWithRetry,
} from '../scripts/verify-published-release.mjs';

const packageJson = {
  name: '@sigilcore/agent-hooks',
  version: '0.10.2',
  repository: { url: 'git+https://github.com/Sigil-Core/agent-hooks.git' },
};
const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const artifact = {
  name: packageJson.name,
  version: packageJson.version,
  tarball: '/tmp/sigilcore-agent-hooks-0.10.2.tgz',
  size: 123,
  shasum: 'a'.repeat(40),
  integrity,
};
const metadata = {
  ...packageJson,
  dist: {
    shasum: artifact.shasum,
    integrity,
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigilcore%2fagent-hooks@0.10.2',
      provenance: { predicateType: PREDICATE_TYPE },
    },
  },
};

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response;
}

describe('published release verification', () => {
  it('binds npm metadata, exact tarball digests, provenance, and latest', () => {
    expect(verifyPublishedRelease(packageJson, metadata, artifact, '0.10.2')).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
      shasum: artifact.shasum,
      integrity,
      provenance: PREDICATE_TYPE,
      latest: '0.10.2',
    });
  });

  it.each([
    ['name', { ...metadata, name: '@sigilcore/other' }, artifact, '0.10.2'],
    ['version', { ...metadata, version: '0.10.1' }, artifact, '0.10.2'],
    ['repository', { ...metadata, repository: { url: 'https://example.invalid/repo' } }, artifact, '0.10.2'],
    ['sha1', { ...metadata, dist: { ...metadata.dist, shasum: 'b'.repeat(40) } }, artifact, '0.10.2'],
    ['sha512', { ...metadata, dist: { ...metadata.dist, integrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}` } }, artifact, '0.10.2'],
    ['attestation', { ...metadata, dist: { ...metadata.dist, attestations: undefined } }, artifact, '0.10.2'],
    ['provenance', { ...metadata, dist: { ...metadata.dist, attestations: { ...metadata.dist.attestations, provenance: undefined } } }, artifact, '0.10.2'],
    ['latest', metadata, artifact, '0.10.1'],
    ['artifact name', metadata, { ...artifact, name: '@sigilcore/other' }, '0.10.2'],
    ['artifact shasum', metadata, { ...artifact, shasum: 'not-a-sha' }, '0.10.2'],
  ])('rejects a %s mismatch', (_label, candidate, expectedArtifact, latest) => {
    expect(() => verifyPublishedRelease(packageJson, candidate, expectedArtifact, latest)).toThrow();
  });

  it('retries transient registry propagation and then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(metadata))
      .mockResolvedValueOnce(response({ 'dist-tags': { latest: '0.10.2' } }));
    let clock = 0;
    const result = await verifyRegistryWithRetry(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 10,
      retryDelayMs: 1,
    });
    expect(result.latest).toBe('0.10.2');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries delayed provenance and latest propagation', async () => {
    const withoutProvenance = {
      ...metadata,
      dist: { ...metadata.dist, attestations: undefined },
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(withoutProvenance))
      .mockResolvedValueOnce(response({ 'dist-tags': { latest: '0.10.1' } }))
      .mockResolvedValueOnce(response(metadata))
      .mockResolvedValueOnce(response({ 'dist-tags': { latest: '0.10.2' } }));
    let clock = 0;
    await expect(verifyRegistryWithRetry(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 10,
      retryDelayMs: 1,
    })).resolves.toMatchObject({ version: '0.10.2' });
  });

  it('does not retry an immutable digest mismatch', async () => {
    const wrong = { ...metadata, dist: { ...metadata.dist, shasum: 'b'.repeat(40) } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(wrong))
      .mockResolvedValueOnce(response({ 'dist-tags': { latest: '0.10.2' } }));
    await expect(verifyRegistryWithRetry(packageJson, artifact, { fetchImpl })).rejects.toThrow(/sha1/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops at the shared retry deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}, 503));
    let clock = 0;
    await expect(verifyRegistryWithRetry(packageJson, artifact, {
      fetchImpl,
      now: () => clock,
      sleep: (milliseconds: number) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      deadlineMs: 5,
      retryDelayMs: 2,
    })).rejects.toThrow(/exceeded 5 ms/);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('classifies authorization failures as non-transient', async () => {
    await expect(fetchJson('https://registry.npmjs.org/example', {
      fetchImpl: () => Promise.resolve(response({}, 403)),
    })).rejects.toMatchObject<Partial<RegistryRequestError>>({ transient: false, status: 403 });
  });
});
