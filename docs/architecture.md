# @sigilcore/agent-hooks Architecture

`@sigilcore/agent-hooks` is a public npm package that intercepts agent tool
calls before execution and routes them to Sigil Sign for pre-execution policy
evaluation.

## Package boundary

The package stays framework-agnostic at the core:

- Core interceptor maps a proposed tool call into a Sigil intent.
- Adapters translate Claude Code, Codex, Hermes, OpenClaw, OpenRouter,
  AgentPay, and other framework shapes into the core intent contract.
- Model-budget helpers keep a task-local usage ledger and submit cumulative
  `metadata.model_usage` reports through the same `/v1/authorize` contract.
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

1. `.github/workflows/publish.yml` runs on GitHub-hosted Actions.
2. The workflow requests an OIDC token via `permissions.id-token: write`.
3. The workflow names the `npm-production` GitHub environment. A protected
   environment and the matching npm trusted-publisher environment must be
   configured before this is an effective human release gate.
4. npm validates the trusted publisher configuration for
   `Sigil-Core/agent-hooks` and `publish.yml`.
5. The manual Phase 6 path submits the candidate with
   `npm stage publish --access public --provenance --tag fleet-phase6`. The
   release path only verifies that the approved version already exists with
   registry integrity and SLSA provenance.

Only the manual path can publish the production package, through the stage-only
trusted publisher and protected `npm-production` environment. The
reusable `scripts/publish-guard.mjs` check confines the manual job to the
GitHub-hosted runner, public npm registry, exact `fleet-phase6` tag, public
access, provenance, and staged-only publication. The tag is moved to the prior
version for rollback rehearsal, restored to the approved candidate, and only
then may `latest` move.

**The guard parses the workflow; it does not match its text.** It reads the
YAML into an object model and asserts against resolved values, so block
scalars, inline mappings, quoting style, and key order all normalise before any
check runs. This replaced a regex-over-source implementation whose every
high-severity defect was the same mistake in a new place: an escape that
escaped nothing and let a lookalike registry host pass, a substring test
satisfied by `--provenance=false`, and a permission check that matched a grant
to any job in the file rather than the publish job.

**What the guard does and does not promise.** It is a static control against
drift and accident, not against an authenticated attacker who can already edit
the workflow. It normalises backslash escapes and quote characters in shell
commands, so `n\pm publish` and `'"npm" publish'` are caught alongside the
literal spelling. It does not interpret variable expansion, command
substitution, `eval`, encoded payloads, or `$IFS` manipulation, and it is not a
shell interpreter. Anyone who can merge a workflow change can defeat it; the
control that matters against that threat is review of the workflow diff, which
is why `.github/workflows/**` is a security-seam path.

The production package has one npm trusted publisher for this workflow. That
publisher allows staged publication only; no temporary package, direct
publication authority, second publisher, or bootstrap tag is part of the
Phase 6 design.

The `repository.url` in `package.json` is part of that trust boundary and must
remain `git+https://github.com/Sigil-Core/agent-hooks.git`.
