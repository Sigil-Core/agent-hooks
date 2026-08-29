/* eslint-env node */
/**
 * Resolve the source commit this workflow is allowed to publish.
 *
 * `@sigilcore/agent-hooks` stamps the exact source commit into the published
 * artifact, and the artifact emits it on `X-Sigil-Client`. That value must be a
 * real commit on `main`, never an annotated tag object, and never something a
 * fork or a stale branch produced. This script is the only thing that decides
 * it, and it fails closed.
 *
 * It accepts only a release tag whose name is exactly `v<package.version>`.
 * The tag is peeled with `^{commit}`, so an annotated tag yields the commit it
 * points at. The tag object SHA is never emitted.
 *
 * The resolved commit is then required to be an ancestor of `origin/main`. The
 * checkout supplies the history this needs: `fetch-depth: 0` plus
 * `fetch-tags: true`. When that history is missing, `origin/main` does not
 * resolve and the run stops here rather than publishing an unverifiable
 * artifact.
 *
 * The git call is injected so the resolution is unit-testable without a
 * repository.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { env, stderr as standardError, stdout as standardOut } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
/** Conservative ref name: no option prefix, no whitespace, no `..` range. */
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/;
const MAIN_REF = 'refs/remotes/origin/main';

export class SourceCommitError extends Error {}

/**
 * Runs one git command. Returns trimmed stdout, or undefined when git failed,
 * so "absent" and "present" stay distinguishable without throwing.
 *
 * @param {(args: string[]) => {status: number | null, stdout: string | Buffer}} git
 * @param {string[]} args
 * @returns {string | undefined}
 */
export function runGit(git, args) {
  const result = git(args);
  if (result.status !== 0) {
    return undefined;
  }
  const text = String(result.stdout).trim();
  return text.length === 0 ? undefined : text;
}

/** A git call that must succeed, with output matching a full object name. */
function requiredObject(git, description, args) {
  const value = runGit(git, args);
  if (value === undefined) {
    throw new SourceCommitError(`git could not resolve the ${description}.`);
  }
  if (!COMMIT_PATTERN.test(value)) {
    throw new SourceCommitError(
      `git returned a malformed object name for the ${description}.`,
    );
  }
  return value;
}

/** Peels any git object name down to the commit it names, and proves it is one. */
function peelToCommit(git, description, objectName) {
  const commit = requiredObject(git, description, [
    'rev-parse',
    '--verify',
    `${objectName}^{commit}`,
  ]);
  const type = runGit(git, ['cat-file', '-t', commit]);
  if (type !== 'commit') {
    throw new SourceCommitError(
      `the ${description} peeled to a ${type ?? 'unknown'} object, not a commit.`,
    );
  }
  return commit;
}

function tagNameFromRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new SourceCommitError('GITHUB_REF is missing.');
  }
  const name = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref;
  if (!REF_NAME_PATTERN.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new SourceCommitError(`GITHUB_REF is not a usable tag name: ${ref}`);
  }
  return name;
}

/**
 * Resolves the commit the workflow may emit.
 *
 * @param {{
 *   ref?: string,
 *   refType?: string,
 *   packageVersion?: string,
 *   git: (args: string[]) => {status: number | null, stdout: string | Buffer},
 * }} input
 * @returns {string} The 40-hex source commit.
 */
export function resolveSourceCommit({ ref, refType, packageVersion, git }) {
  if (refType !== 'tag') {
    throw new SourceCommitError(`GITHUB_REF_TYPE must be 'tag', got ${String(refType)}.`);
  }
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    throw new SourceCommitError('package version is missing.');
  }
  const tagName = tagNameFromRef(ref);
  const expectedTag = `v${packageVersion}`;
  if (tagName !== expectedTag) {
    throw new SourceCommitError(`release tag ${tagName} does not match package version ${expectedTag}.`);
  }
  const source = `refs/tags/${tagName}`;
  const candidate = peelToCommit(
    git,
    `tag ${tagName}`,
    source,
  );

  const base = requiredObject(git, 'origin/main branch head', [
    'rev-parse',
    '--verify',
    `${MAIN_REF}^{commit}`,
  ]);

  const ancestry = git(['merge-base', '--is-ancestor', candidate, base]);
  if (ancestry.status === 1) {
    throw new SourceCommitError(
      `source commit ${candidate} is not an ancestor of origin/main; refusing to publish it.`,
    );
  }
  if (ancestry.status !== 0) {
    throw new SourceCommitError(
      `git could not compare ${candidate} against origin/main; refusing to publish unverified.`,
    );
  }

  // Bind the emitted name to the tree that is actually being built. Whatever
  // this workflow checks out must be the commit we just resolved, so the header
  // cannot describe a commit that npm is not publishing.
  const head = peelToCommit(git, 'checked-out HEAD', 'HEAD');
  if (head !== candidate) {
    throw new SourceCommitError(
      `checked-out HEAD ${head} is not the resolved source commit ${candidate}.`,
    );
  }

  return candidate;
}

const gitFromSpawn = (args) => spawnSync('git', args, { encoding: 'utf8' });
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
    standardOut.write(`${resolveSourceCommit({
      ref: env.GITHUB_REF,
      refType: env.GITHUB_REF_TYPE,
      packageVersion: packageJson.version,
      git: gitFromSpawn,
    })}\n`);
  } catch (error) {
    if (error instanceof SourceCommitError) {
      standardError.write(`resolve-source-commit: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
