import { describe, expect, it } from 'vitest';
import { verifyPublishedRelease } from '../scripts/verify-published-release.mjs';

const packageJson = {
  name: '@sigilcore/agent-hooks',
  version: '0.10.1',
  repository: { url: 'git+https://github.com/Sigil-Core/agent-hooks.git' },
};
const metadata = {
  name: packageJson.name,
  version: packageJson.version,
  repository: packageJson.repository,
  dist: {
    integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    attestations: {
      url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigilcore%2fagent-hooks@0.10.1',
      provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
    },
  },
};

describe('published release verification', () => {
  it('accepts the exact version with integrity and provenance', () => {
    expect(verifyPublishedRelease(packageJson, metadata)).toMatchObject({
      name: packageJson.name,
      version: packageJson.version,
    });
  });

  it.each([
    ['wrong package', { ...metadata, name: '@sigilcore/other' }],
    ['wrong version', { ...metadata, version: '0.10.0' }],
    ['wrong repository', { ...metadata, repository: { url: 'https://example.invalid/' } }],
    ['missing integrity', { ...metadata, dist: { ...metadata.dist, integrity: undefined } }],
    ['malformed integrity', { ...metadata, dist: { ...metadata.dist, integrity: 'sha512-not-a-digest' } }],
    ['wrong attestation identity', { ...metadata, dist: { ...metadata.dist, attestations: { ...metadata.dist.attestations, url: 'https://registry.npmjs.org/-/npm/v1/attestations/@sigilcore%2fother@0.10.1' } } }],
    ['missing provenance', { ...metadata, dist: { ...metadata.dist, attestations: undefined } }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => verifyPublishedRelease(packageJson, candidate)).toThrow();
  });
});
