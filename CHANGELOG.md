# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-07-20

### Fixed

- Native EVM value precedence now depends on the intent action. For `contract.call`, an explicit `value` key takes precedence (native value attached to the call) and falls back to `amount`; for other EVM actions such as `wallet.transfer`, `amount` takes precedence and falls back to `value`. Previously `amount` always won, which could mask a contract call's native `value`. `resolveEvmAmount` / `resolveSuppliedEvmAmount` now receive the resolved action.

## [0.5.1] - 2026-07-19

### Added

- EVM intents carry an amount only when the tool input can prove one: a supplied `amount`/`value` passes through verbatim (finite numbers stringified); an EVM action with neither key — a `contract.call` or a `wallet.transfer` — is left absent on purpose, because the adapter cannot prove that an alternate field such as `valueWei` or `tx.value` is not carrying native value and inventing `"0"` would let an unknown value pass under the cap. Sigil Sign then denies it with `LEX_AMOUNT_REQUIRED` instead of treating an unknown value under the cap as zero.
- `decodeErc20Calldata` shim (`src/evm-calldata.ts`): decodes the 4-byte selector for the ERC-20 set (`transfer`, `transferFrom`, `approve`, `increaseAllowance`, `permit`) and emits `metadata.evm` (`selector`, `token_target`, `spender`/`recipient`, `token_amount` in base units) on `contract.call` intents. Unknown selectors emit selector-only metadata so a strict policy can deny them; partial decodes never emit guessed values.
- `SigilIntent.calldata` — decoded EVM calldata passed through on the `/v1/authorize` request body.

### Fixed

- EVM calldata is bound and validated before it is emitted.
- Contract-call action aliases are normalized to the canonical `contract.call` action.
- Adapters fail closed on unproven EVM value rather than passing an unknown amount under the policy cap.

### Known limitations

- Out of scope for this release: proxy contracts, multicall unwrapping, and non-ERC-20 token standards.

## [0.5.0] - 2026-07-10

### Added

- Typed HTTP intent profile: adapters emit `action: "http"` only when a known HTTP/web tool input carries an explicit uppercase method (`GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`). New `HTTP_METHODS` constant and `HttpMethod` / `SigilHttpMethod` exported types.
- `SigilIntent.method?: HttpMethod` — set on typed `http` intents only; adapters never infer `GET`. `SigilIntent.url` now applies to both `web_fetch` and `http`.
- README "Typed HTTP intents" section documenting the per-adapter method-extraction surface.

### Changed

- Methodless web calls continue to use the legacy `web_fetch` action, so existing policies remain compatible. An explicit non-empty method outside the supported set still selects the typed `http` profile but omits the invalid method from the wire intent, so Sigil Sign rejects the incomplete typed request instead of silently downgrading it to an untyped fetch.

## [0.4.0] - 2026-07-07

### Added

- Dedicated adapter exports for OpenAI Codex, Hermes Agent, OpenRouter, and AgentPay:
  `createCodexPreToolUseHook`, `createHermesPreToolCallHook`,
  `createOpenRouterToolGate`, `recordOpenRouterModelUsageAndCheckBudget`, and
  `checkAgentPayTransfer`.
- Adapter tests for Codex hook-specific deny output, Hermes block output,
  OpenRouter tool-call rejection messages, OpenRouter model-budget usage
  recording, and AgentPay fail-closed transfer checks.
- Framework registry entries for `codex`, `hermes`, `openrouter`, `agentpay`,
  `openclaw`, and `ironclaw`; AgentPay now resolves to the dedicated
  `checkAgentPayTransfer` adapter export.

## [0.3.0] — 2026-06-22

### Added

- Execution-limit support: exported `SIGIL_LOOP_LIMIT_EXCEEDED` and `SIGIL_LIMIT_STORE_UNAVAILABLE` constants, plus optional `taskId` fields on `SigilIntent`, `SigilHookConfig`, and `SigilHookResult`.
- Rejection contexts now include optional `sigil_task_id` when a denial is tied to a per-task execution ceiling.

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
