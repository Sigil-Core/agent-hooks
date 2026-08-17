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

Publication is release-gated, so neither of these blocks a merge; a mismatch
surfaces on the next published release, not on the default branch.

## Staged probe acceptance

**This repository's `publish.yml` contains exactly one job, the release-gated
production `publish` job. There is no manual staged job here.** The rules below
describe the contract the guard enforces *if* a staged path is added, and the
contract the separate P-12 probe package must satisfy in its own workflow. They
are not a description of a job that exists today.

The P-12 probe is a separate, non-production publication path. Its manual job
may submit exactly one reviewed tarball with `npm stage publish`, a non-latest
dist-tag, and provenance. A direct `npm publish` is not valid in the probe
job. The publication guard rejects a second command, a command hidden in a
different step, or a direct publish spelled with backslash escapes or quote
characters. Its shell handling is deliberately bounded: it does not resolve
variable expansion, command substitution, `eval`, or encoded payloads. See
`docs/architecture.md` for the full statement of what the guard does and does
not promise.

The production package has one trusted npm publisher: the release workflow
for `Sigil-Core/agent-hooks`. A temporary P-12 probe package must use its own
temporary publisher record restricted to staged publication. Never reuse the
production package's publisher for the probe.

Acceptance is bound to the exact staged package name, version, tarball digest,
repository metadata, provenance receipt, and reviewed workflow ref. Keep the
bootstrap package available under its non-latest `s12-probe` rollback tag while
these checks run.

After the exact staged approval is recorded, the operator may perform one
`latest` dist-tag repoint for the approved version. The acceptance path keeps
the bootstrap rollback tag and the previous version available; it does not
depend on removing the only `latest` release. If the staged artifact or its
approval changes, stop and start a new staged run instead of repeating the
repoint.

## One-challenge rule

Once both publisher records are configured, the `npm-production` gate permits
one challenge for an exact staged artifact.
When the challenge is not satisfied, the run stops. A new artifact and a fresh
staged review are required before another challenge or any `latest` repoint.
This prevents repeated prompts from becoming an implicit approval loop.
