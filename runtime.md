# @sigilcore/agent-hooks Runtime Notes

## npm direct OIDC release path

`@sigilcore/agent-hooks` publishes from `.github/workflows/publish.yml` through
an npm trusted publisher. Keep these values aligned:

- GitHub repository: `Sigil-Core/agent-hooks`
- Workflow filename: `publish.yml`
- GitHub environment: `npm-production`
- Runner: GitHub-hosted `ubuntu-latest`
- Release-job permissions: `contents: read` and `id-token: write`
- Node: `22.14.0`
- npm CLI: `11.17.0`
- `setup-node`: pinned v7 commit, package-manager caching disabled
- Registry: `https://registry.npmjs.org/`
- Repository URL: `git+https://github.com/Sigil-Core/agent-hooks.git`
- Publish mode: direct, public, provenance enabled, tag `latest`

Routine releases need no npm token, browser session, passkey, or TOTP. The npm
trusted publisher must allow direct publication for this repository, workflow,
and environment. A stage-only relationship is incompatible.

The release tag must equal `v<package.version>`. The workflow proves the tag's
commit is on `origin/main`, runs the full test and build gates, packs one exact
tarball, publishes only when that version is absent, and verifies the tarball
digests, repository, provenance, and `latest` from npm. An exact existing
release is a successful idempotent rerun. Any immutable mismatch fails closed.

Rollback uses the next patch from a reviewed revert. Routine automation does
not delete versions or move `latest` backward.

## One-time trusted-publisher maintenance

Converting the old relationship requires authenticated npm CLI access. Revoke
the old relationship, create one direct publisher for the same repository,
workflow, and environment, then verify it before publishing `v0.10.2`. npm may
require a fresh TOTP for each trust-management command. This is the last
expected interactive npm step; it is not part of future releases.

If npm reports OIDC permission denied, inspect the trusted-publisher record
instead of adding `NPM_TOKEN`. If npm already contains the version, do not
republish it. Run the exact-artifact verifier and either accept an exact match
or publish the next patch after fixing the mismatch.

Verification baseline before creating a release:

```bash
npm run publish:guard
npm run typecheck
npm run lint
npm test
npm run build
```

## CodeRabbit local review support note

On June 23, 2026, CodeRabbit Support confirmed that a Sigil local committed
review that looked stalled completed successfully in about 2 minutes 30 seconds
with 0 findings. The review spent most of its time in `analyzing/summarizing`
while backend summarization, MCP context gathering, and Review Stack artifact
generation ran. Support also saw one transient repository clone failure that
retried successfully and a non-fatal Mermaid sanitizer warning.

If a local review appears hung, let it run for 5 to 10 minutes before stopping
it. If it still does not return, capture:

```bash
DEBUG=* coderabbit review --agent --type committed --base-commit <base_commit>
coderabbit --version
git rev-parse HEAD
```

For an uncommitted review, keep the same `DEBUG=*` prefix and use the actual
review command being debugged. Include the exact start and stop time with
timezone and the full terminal output when opening or updating the support
ticket. This lets CodeRabbit correlate the local process with the backend
review attempt.
