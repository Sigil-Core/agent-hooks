# Agent Hooks publishing acceptance

Production publication is an npm trusted-publishing operation from the
GitHub-hosted `ubuntu-latest` runner. The workflow requests `id-token: write`,
uses the exact `git+https://github.com/Sigil-Core/agent-hooks.git` repository
URL, and publishes with provenance. It does not use an `NPM_TOKEN` secret.
The workflow names the `npm-production` GitHub environment. That name is not a
gate by itself.

Before enabling this workflow, an operator must configure a protected GitHub
`npm-production` environment and update the npm trusted publisher for this
package to the exact same environment name. This worktree does not perform
that external configuration. Until both sides are configured, keep release
publication fail-closed or in draft: npm will reject an OIDC subject that does
not match its publisher record.

## Staged probe acceptance

The P-12 probe is a separate, non-production publication path. Its manual job
may submit exactly one reviewed tarball with `npm stage publish`, a non-latest
dist-tag, and provenance. A direct `npm publish` is not valid in the probe
job. The publication guard rejects a second command, a command hidden in a
different step, or a direct publish hidden behind shell syntax.

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
