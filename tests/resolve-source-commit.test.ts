import { describe, expect, it } from 'vitest';
import { SourceCommitError, resolveSourceCommit, runGit } from '../scripts/resolve-source-commit.mjs';

const COMMIT = '1'.repeat(40);
const OTHER = '2'.repeat(40);
const VERSION = '0.10.2';
const TAG = `v${VERSION}`;

interface GitResult { status: number | null; stdout: string; }
const ok = (stdout: string): GitResult => ({ status: 0, stdout });

function gitFake(overrides: Record<string, GitResult> = {}) {
  const answers: Record<string, GitResult> = {
    [`rev-parse --verify refs/tags/${TAG}^{commit}`]: ok(COMMIT),
    [`cat-file -t ${COMMIT}`]: ok('commit'),
    'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
    [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
    'rev-parse --verify HEAD^{commit}': ok(COMMIT),
    ...overrides,
  };
  return (args: string[]) => answers[args.join(' ')] ?? { status: 1, stdout: '' };
}

function resolve(git = gitFake(), input: Record<string, unknown> = {}) {
  return resolveSourceCommit({
    ref: `refs/tags/${TAG}`,
    refType: 'tag',
    packageVersion: VERSION,
    git,
    ...input,
  });
}

describe('release source commit', () => {
  it('peels the exact package-version tag and accepts a main ancestor', () => {
    expect(resolve()).toBe(COMMIT);
  });

  it('rejects branch and unknown trigger shapes', () => {
    for (const refType of ['branch', undefined, '']) {
      expect(() => resolve(gitFake(), { refType })).toThrow(/must be 'tag'/);
    }
  });

  it('rejects a release tag that does not equal v<package.version>', () => {
    expect(() => resolve(gitFake(), { ref: 'refs/tags/v0.10.1' })).toThrow(/does not match package version/);
    expect(() => resolve(gitFake(), { packageVersion: '' })).toThrow(/version is missing/);
  });

  it('rejects unsafe tag names', () => {
    for (const ref of ['refs/tags/..', 'refs/tags/-evil', 'refs/tags/a b', 'refs/tags/x.lock']) {
      expect(() => resolve(gitFake(), { ref })).toThrow(SourceCommitError);
    }
  });

  it('rejects a tag that cannot peel to a commit', () => {
    const git = gitFake({ [`rev-parse --verify refs/tags/${TAG}^{commit}`]: { status: 1, stdout: '' } });
    expect(() => resolve(git)).toThrow(/could not resolve/);
  });

  it('rejects a non-commit peeled object', () => {
    const git = gitFake({ [`cat-file -t ${COMMIT}`]: ok('tree') });
    expect(() => resolve(git)).toThrow(/not a commit/);
  });

  it('rejects a source commit outside origin/main', () => {
    const git = gitFake({ [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: { status: 1, stdout: '' } });
    expect(() => resolve(git)).toThrow(/not an ancestor/);
  });

  it('rejects missing main history', () => {
    const git = gitFake({ 'rev-parse --verify refs/remotes/origin/main^{commit}': { status: 1, stdout: '' } });
    expect(() => resolve(git)).toThrow(/origin\/main/);
  });

  it('rejects a checkout that differs from the release tag', () => {
    const git = gitFake({
      'rev-parse --verify HEAD^{commit}': ok(OTHER),
      [`cat-file -t ${OTHER}`]: ok('commit'),
    });
    expect(() => resolve(git)).toThrow(/checked-out HEAD/);
  });

  it('rejects an indeterminate ancestry check', () => {
    const git = gitFake({ [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: { status: 128, stdout: '' } });
    expect(() => resolve(git)).toThrow(/could not compare/);
  });
});

describe('runGit', () => {
  it('returns trimmed output only on success', () => {
    expect(runGit(() => ({ status: 0, stdout: ' value\n' }), ['x'])).toBe('value');
    expect(runGit(() => ({ status: 1, stdout: 'value' }), ['x'])).toBeUndefined();
    expect(runGit(() => ({ status: 0, stdout: '' }), ['x'])).toBeUndefined();
  });
});
