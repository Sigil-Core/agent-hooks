// tests/resolve-source-commit.test.ts
//
// Safety proof for the commit the publish workflow stamps into the artifact and
// reports on `X-Sigil-Client`. Every case here is a way the workflow could be
// tempted into emitting a value that is not the source commit it published: an
// annotated tag object, a commit that never reached `main`, a fork's branch, a
// shallow checkout with no `origin/main`, or a trigger shape the resolver does
// not recognize. Each one must fail closed.
//
// The git call is injected, so no case needs a repository.
import { describe, expect, it } from 'vitest';
import {
  SourceCommitError,
  resolveSourceCommit,
  runGit,
} from '../scripts/resolve-source-commit.mjs';

const COMMIT = '1'.repeat(40);
const OTHER_COMMIT = '2'.repeat(40);
const TAG_OBJECT = '3'.repeat(40);
const ANNOTATED_TAG = 'v0.10.0';

interface GitResult {
  status: number | null;
  stdout: string;
  stderr?: string;
}

const ok = (stdout: string): GitResult => ({ status: 0, stdout });

/** A git fake driven by a table of `rev-parse`/`cat-file` answers. */
const gitFake = (answers: Record<string, GitResult>) => {
  const calls: string[][] = [];
  const git = (args: string[]): GitResult => {
    calls.push(args);
    const key = args.join(' ');
    const answer = answers[key];
    if (answer === undefined) {
      return { status: 1, stdout: '', stderr: `no fake answer for ${key}` };
    }
    return answer;
  };
  return { git, calls };
};

const annotatedTagRepository = ({ headCommit = COMMIT, mainCommit = COMMIT } = {}) =>
  gitFake({
    [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
    [`cat-file -t ${COMMIT}`]: ok('commit'),
    'rev-parse --verify refs/remotes/origin/main^{commit}': ok(mainCommit),
    [`merge-base --is-ancestor ${COMMIT} ${mainCommit}`]: ok(''),
    'rev-parse --verify HEAD^{commit}': ok(headCommit),
    [`cat-file -t ${headCommit}`]: ok('commit'),
  });

describe('tag triggers', () => {
  it('peels an annotated tag to the commit it points at', () => {
    const repository = annotatedTagRepository();
    expect(resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toBe(COMMIT);
  });

  it('accepts a bare tag name and a lightweight tag alike', () => {
    const lightweight = gitFake({
      'rev-parse --verify refs/tags/v1.0.0^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
    });
    expect(resolveSourceCommit({
      ref: 'v1.0.0',
      refType: 'tag',
      sha: TAG_OBJECT,
      git: lightweight.git,
    })).toBe(COMMIT);
  });

  it('accepts SemVer build metadata in a release tag', () => {
    const releaseTag = 'v1.0.0+build.5';
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${releaseTag}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
    });

    expect(resolveSourceCommit({
      ref: `refs/tags/${releaseTag}`,
      refType: 'tag',
      sha: COMMIT,
      git: repository.git,
    })).toBe(COMMIT);
  });

  it('never emits the annotated tag object SHA', () => {
    const repository = annotatedTagRepository();
    const commit = resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      // A release event can report the tag object itself as the event SHA.
      sha: TAG_OBJECT,
      git: repository.git,
    });
    expect(commit).not.toBe(TAG_OBJECT);
    expect(commit).toBe(COMMIT);
    // The peel is the only route to the emitted value.
    const peeled = repository.calls.find((args) => args[1] === '--verify');
    expect(peeled?.[2]).toBe(`refs/tags/${ANNOTATED_TAG}^{commit}`);
  });

  it('rejects a tag ref that does not peel to a commit', () => {
    const repository = gitFake({
      'rev-parse --verify refs/tags/v1.0.0^{commit}': { status: 1, stdout: '' },
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
    });
    expect(() => resolveSourceCommit({
      ref: 'refs/tags/v1.0.0',
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(SourceCommitError);
  });

  it('rejects a tag name that could be mistaken for something else', () => {
    for (const ref of ['refs/tags/..', 'refs/tags/-evil', 'refs/tags/a b', 'refs/tags/x.lock']) {
      expect(() => resolveSourceCommit({
        ref,
        refType: 'tag',
        sha: TAG_OBJECT,
        git: annotatedTagRepository().git,
      })).toThrow(SourceCommitError);
    }
  });

  it('rejects a peeled object that is not a commit', () => {
    const repository = gitFake({
      'rev-parse --verify refs/tags/v1.0.0^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('tree'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
    });
    expect(() => resolveSourceCommit({
      ref: 'refs/tags/v1.0.0',
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/not a commit/);
  });
});

describe('branch triggers', () => {
  it('peels the event commit', () => {
    const repository = gitFake({
      [`rev-parse --verify ${COMMIT}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
    });
    expect(resolveSourceCommit({
      ref: 'refs/heads/codex/fleet-phase6',
      refType: 'branch',
      sha: COMMIT,
      git: repository.git,
    })).toBe(COMMIT);
  });

  it('peels an annotated tag object reported as a branch event SHA', () => {
    const repository = gitFake({
      [`rev-parse --verify ${TAG_OBJECT}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
    });
    expect(resolveSourceCommit({
      ref: 'refs/heads/main',
      refType: 'branch',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toBe(COMMIT);
  });

  it('rejects a missing or malformed event SHA', () => {
    const repository = annotatedTagRepository();
    for (const sha of [undefined, '', 'short', 'g'.repeat(40)]) {
      expect(() => resolveSourceCommit({
        ref: 'refs/heads/main',
        refType: 'branch',
        sha,
        git: repository.git,
      })).toThrow(/GITHUB_SHA/);
    }
  });
});

describe('ancestry and provenance', () => {
  it('fails closed when the resolved commit is not on main', () => {
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(OTHER_COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${OTHER_COMMIT}`]: { status: 1, stdout: '' },
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
    });
    expect(() => resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/not an ancestor of origin\/main/);
  });

  it('fails closed when git cannot compare against main', () => {
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(OTHER_COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${OTHER_COMMIT}`]: { status: 128, stdout: '' },
      'rev-parse --verify HEAD^{commit}': ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
    });
    expect(() => resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/could not compare/);
  });

  it('fails closed when main cannot be resolved at all', () => {
    // A shallow checkout that never fetched main's history lands here, which is
    // exactly the case that must stop the release rather than publish anyway.
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': { status: 1, stdout: '' },
    });
    expect(() => resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/origin\/main/);
  });

  it('fails closed when the checked-out tree is not the resolved commit', () => {
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok(COMMIT),
      [`merge-base --is-ancestor ${COMMIT} ${COMMIT}`]: ok(''),
      'rev-parse --verify HEAD^{commit}': ok(OTHER_COMMIT),
      [`cat-file -t ${OTHER_COMMIT}`]: ok('commit'),
    });
    expect(() => resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/checked-out HEAD/);
  });

  it('rejects a trigger shape it does not recognize', () => {
    expect(() => resolveSourceCommit({
      ref: 'refs/heads/main',
      refType: 'pull_request',
      sha: COMMIT,
      git: annotatedTagRepository().git,
    })).toThrow(/GITHUB_REF_TYPE/);
  });

  it('rejects a malformed origin/main answer', () => {
    const repository = gitFake({
      [`rev-parse --verify refs/tags/${ANNOTATED_TAG}^{commit}`]: ok(COMMIT),
      [`cat-file -t ${COMMIT}`]: ok('commit'),
      'rev-parse --verify refs/remotes/origin/main^{commit}': ok('origin/main'),
    });
    expect(() => resolveSourceCommit({
      ref: `refs/tags/${ANNOTATED_TAG}`,
      refType: 'tag',
      sha: TAG_OBJECT,
      git: repository.git,
    })).toThrow(/malformed object name/);
  });
});

describe('runGit', () => {
  it('returns trimmed stdout on success and undefined on failure', () => {
    expect(runGit(() => ok(`  ${COMMIT}\n` ), ['rev-parse'])).toBe(COMMIT);
    expect(runGit(() => ({ status: 1, stdout: '' }), ['rev-parse'])).toBeUndefined();
    expect(runGit(() => ({ status: 0, stdout: '   \n' }), ['rev-parse'])).toBeUndefined();
  });
});
