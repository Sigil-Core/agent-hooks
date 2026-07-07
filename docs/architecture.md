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
3. npm validates the trusted publisher configuration for
   `Sigil-Core/agent-hooks` and `publish.yml`.
4. `npm publish --access public` publishes `@sigilcore/agent-hooks` with
   provenance.

The `repository.url` in `package.json` is part of that trust boundary and must
remain `git+https://github.com/Sigil-Core/agent-hooks.git`.
