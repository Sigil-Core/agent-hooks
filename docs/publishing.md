# Agent Hooks publishing acceptance

Production publication is an npm trusted-publishing operation from the
GitHub-hosted `ubuntu-latest` runner. The workflow requests `id-token: write`,
uses the exact `git+https://github.com/Sigil-Core/agent-hooks.git` repository
URL, and publishes with provenance. It does not use an `NPM_TOKEN` secret.
The workflow names the `npm-production` GitHub environment. That name is not a
gate by itself.

Two external controls back that name.

1. **A protected GitHub `npm-production` environment.** Created 2026-08-17 and
   restricted to protected branches, so only `main` can deploy to it.
2. **The npm trusted publisher for this package.** npm treats the environment
   field as optional and validates only the fields it has recorded, so
   publication keeps working whether or not that field is set. Setting it to
   `npm-production` is what turns the environment name into an actual
   restriction rather than a label. Until it is set, the environment is
   documentation, not a gate.

Production publication is release-gated. The Phase 6 candidate path is a
manual staged publication from the same workflow and environment. It makes the
candidate unavailable to public installs until an operator completes npm's
proof-of-presence approval.

## Published source commit

The publish job checks out full history and every tag, then resolves one commit
before it builds. `scripts/resolve-source-commit.mjs` peels the release ref with
`^{commit}`, so an annotated tag yields the commit it points at and the tag
object SHA is never emitted; the same peel covers a branch trigger, where an
event can report a tag object as the commit. It then requires that commit to be
an ancestor of `origin/main`, requires the checked-out tree to be that commit,
and fails closed on every other outcome — including a checkout with no
`origin/main` to compare against. The resolved commit is injected into the build
as `SIGIL_SOURCE_COMMIT` and is what the published artifact reports on
`X-Sigil-Client`. A local or fork build with no such value omits `commit`
instead of guessing.

## Phase 6 staged release and rollback

`publish.yml` contains one manual `stage-publish` job. It builds the exact
`main` commit with the same checks as the release job, then submits the package
with `npm stage publish` under the non-latest `fleet-phase6` dist-tag. The
trusted publisher must allow staged publication. The job cannot make the
version publicly installable or move `latest` by itself.

The publication guard permits exactly one staged command in the manual job. A
direct `npm publish` is invalid there. The guard rejects a second command, a
command hidden in a different step, or a direct publish spelled with backslash
escapes or quote characters. Its shell handling is deliberately bounded: it
does not resolve variable expansion, command substitution, `eval`, or encoded
payloads. See `docs/architecture.md` for the full boundary.

The production package has one trusted npm publisher: this workflow for
`Sigil-Core/agent-hooks`. No npm token is stored in GitHub.

Acceptance is bound to the exact staged package name, version, tarball digest,
repository metadata, provenance receipt, and reviewed workflow ref. Keep the
previous version available under the non-latest `fleet-phase6` rollback tag
while these checks run.

After the exact staged approval is recorded, the operator rehearses rollback
by moving `fleet-phase6` to the previous version and proving that version
resolves, then restores `fleet-phase6` to the approved candidate. Only then may
the operator move `latest` to the approved version. If the staged artifact or
its approval changes, stop and start a new staged run instead of repeating the
repoint.

## One-challenge rule

Once the trusted publisher allows both direct and staged publication, the
`npm-production` gate permits one challenge for an exact staged artifact.
When the challenge is not satisfied, the run stops. A new artifact and a fresh
staged review are required before another challenge or any `latest` repoint.
This prevents repeated prompts from becoming an implicit approval loop.
