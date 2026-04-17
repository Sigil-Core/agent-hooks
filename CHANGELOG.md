# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-04-17

### Fixed

- Cross-language `/v1/authorize` wire parity is now enforced at the actual HTTP boundary, not just at helper serialization boundaries. TypeScript and Rust now send the same pretty-printed request body with a trailing newline.
- `agentId` precedence is aligned across implementations: per-intent `agentId` now overrides config-level `agentId` in both clients.
- Auto-generated `txCommit` hashing now omits absent optional fields instead of hashing `null` placeholders, matching the TypeScript serializer and preventing cross-language digest drift.
- TypeScript now accepts both snake_case and camelCase response fields for `errorCode`/`error_code`, `holdId`/`hold_id`, and `policyHash`/`policy_hash`.

### Added

- Raw-wire fixture regression tests for `bash`, `web_fetch`, `wallet.transfer`, and `intent_agent_override` request bodies.
- Deterministic `txCommit` parity coverage for the auto-generated commit path.
- `tests/UPSTREAM_AGENT_HOOKS_RS_COMMIT` now pins the exact `agent-hooks-rs` commit used to generate vendored fixtures, and fixture-parity tests enforce that the pin is a real 40-character SHA.
- CI workflow for source-level verification (`typecheck`, `lint`, `test`, `build`) on push and pull request.

## [0.2.0] — 2026-04-17

### Added

- `SigilHookConfig.failMode?: 'open' | 'closed'` — configurable unreachability behavior. Default `'open'` preserves v0.1.0 behavior.
- `SigilHookConfig.requestTimeoutMs?: number` — request timeout via `AbortController` (default `10_000` ms).
- `SigilHookResult.failOpen?: boolean` — set to `true` when `APPROVED` was returned via the fail-open fallback rather than real policy evaluation.
- `SIGIL_UNREACHABLE` — new error code surfaced on `DENIED` in `failMode: 'closed'` when Sigil is unreachable. Exported as both a runtime constant and a type-level discriminant.
- `buildRejectionContext` now produces a dedicated branch for `SIGIL_UNREACHABLE` with transient-failure `sigil_next_steps` ("pause and retry when restored; do not report a policy violation").
- `createOpenclawSigilHandler` — native adapter for OpenClaw's `before_tool_call` plugin hook. Also covers NVIDIA NemoClaw (same hook surface).
- `FRAMEWORKS` registry — typed enumeration of eight recognized framework identifiers (`agent-hooks`, `anthropic-sdk`, `eliza`, `langchain`, `openclaw`, `nemoclaw`, `ironclaw`, `agentpay`). Advisory; `config.framework` remains a free string.
- README sections for OpenClaw / NemoClaw, IronClaw (dispatch-host pattern), and a rolled-up Supported Frameworks table.
- AgentPay section now carries an explicit `failMode: 'closed'` requirement callout.

### Changed

- **Behavior change — 5xx responses in `failMode: 'open'`:** a `5xx` response with a valid-but-empty JSON body previously surfaced as `DENIED` + `SIGIL_POLICY_VIOLATION`. It now surfaces as `APPROVED + failOpen: true` — consistent with the fail-open contract. Hosts that branched on the old `SIGIL_POLICY_VIOLATION` for 5xx should migrate to branching on `failOpen`.
- Log event renamed: `sigil_hook_network_error` → `sigil_hook_unreachable`. Payload now includes `failMode` and uses `error` level in closed mode (was always `warn`).

### Deferred

- Deprecation of the default `failMode: 'open'` — revisit in v0.3.0 once adoption data is available.
- Native Rust integration for IronClaw's `Hook` trait — queued as a separate package, `@sigilcore/agent-hooks-rs`.
- Per-action `failMode` overrides (e.g., automatic `'closed'` for `wallet.*`) — documentation-only guidance for now; no surprising runtime behavior.
