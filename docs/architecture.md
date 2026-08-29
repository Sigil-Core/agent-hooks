# @sigilcore/agent-hooks Architecture

`@sigilcore/agent-hooks` is a public npm package that intercepts agent tool
calls before execution and routes them to Sigil Sign for policy evaluation.

## Package boundary

The package stays framework-agnostic at the core:

- The core interceptor maps a proposed tool call into a Sigil intent.
- Adapters translate Claude Code, Codex, Hermes, OpenClaw, OpenRouter,
  AgentPay, and other framework shapes into the core intent contract.
- Model-budget helpers keep task-local usage and submit cumulative
  `metadata.model_usage` through the same `/v1/authorize` contract.
- Sigil Sign remains the policy engine and attestation issuer.
- Agent Hooks does not embed Sigil Lex or production policy evaluation logic.

## Build output

The package ships dual module output from `tsup`:

- ESM: `dist/index.js`
- CommonJS: `dist/index.cjs`
- Types: `dist/index.d.ts`

Only `dist/` and `README.md` publish to npm.

## Publishing architecture

Publishing uses npm trusted publishing from GitHub Actions, not a long-lived npm
token. The trust chain is:

1. A published GitHub release starts `.github/workflows/publish.yml` on
   GitHub-hosted `ubuntu-latest`.
2. The one release job receives `contents: read` and `id-token: write` inside
   the protected `npm-production` environment.
   The pinned `setup-node` action uses its OIDC-safe path and disables package
   manager caching for the privileged job.
3. The release tag must equal `v<package.version>`, peel to the checked-out
   commit, and name a commit on `origin/main`.
4. The workflow packs one exact tarball after tests and build.
5. npm validates the OIDC identity against its trusted publisher for
   `Sigil-Core/agent-hooks`, `publish.yml`, and `npm-production`.
6. The workflow publishes the tarball directly with public access, SLSA
   provenance, and `latest`, then reads npm back and verifies the same artifact.

`scripts/prepare-publish.mjs` makes an interrupted run idempotent. It skips the
publication command only when npm already contains the exact SHA-1, SHA-512
integrity, repository, provenance, and `latest` binding. A different immutable
artifact fails closed. `scripts/verify-published-release.mjs` retries bounded
registry propagation but never retries an authentication, authorization, or
digest failure.

`scripts/publish-guard.mjs` parses the workflow as YAML and enforces the static
boundary: release-only trigger, one protected GitHub-hosted job, exact
permissions, exact registry, tag-bound checkout, required test ordering, no
`NPM_TOKEN`, one visible direct publication command, provenance, public access,
`latest`, and exact post-publish verification. It detects escaped and quoted
spellings of `npm publish` so a second command cannot hide behind formatting.

The guard controls drift and mistakes. It is not a shell interpreter and does
not defeat an authenticated attacker who can merge a workflow change. Review
of `.github/workflows/**` remains the security control for variable expansion,
command substitution, encoded payloads, and other shell semantics.

The production package has one trusted publisher for this workflow. No second
publisher or bootstrap package is required. The `repository.url` in
`package.json` is part of the trust boundary and remains
`git+https://github.com/Sigil-Core/agent-hooks.git`.

Rollback does not overwrite a package or move `latest` backward. It publishes
the next patch from a reviewed revert through the same OIDC release path.
