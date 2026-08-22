# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-08-21

### Added

- A deterministic 29-case enforce-mode source preflight with separate zero
  counters for unexpected valid-case failures, negative-case tamper accepts,
  legacy-path fallbacks, stable reason-code mismatches, and negative decision
  mismatches. Exact published-artifact ESM and CommonJS proof remains a release
  gate, not a local claim.
- Named library-level drills for the clock-skew boundaries, cold-cache JWKS
  outage, two-key rotation overlap, oversized token and JWKS input, and signed-
  record tampering.

### Changed

- Decision-record verification now defaults to `enforce`; callers must provide
  a trusted lowercase SHA-256 policy pin. Explicit `warn` remains available as
  the documented package-rollback compatibility mode.
- Literal hygiene, opaque-capability, and execution-import controls are
  explicit blocking CI gates.

### Security

- Omitting `decisionVerificationMode` can no longer reach the unsigned legacy
  response path. Missing or malformed policy pins deny before network access.

## [0.9.0] - 2026-08-21

### Added

- Strict Ed25519 decision-record and Intent Attestation verification with
  request nonce, intent, policy, audience, surface, time, and key bindings.
- Separate opaque `VerifiedAuthorization` and
  `LegacyUnverifiedAuthorization` capabilities for enforce and warn rollout
  modes.
- Frozen decision-record fixtures shared with `agent-hooks-rs`, plus advisory
  literal and architecture gates with forced-failure tests.

### Changed

- Authorization results now use `ALLOWED`. The deprecated `APPROVED` value is
  accepted permanently as an input alias, normalized at the parse boundary,
  and never returned.
- Authorize requests include a fresh `request_nonce` for signed response
  binding.
- `apiUrl` must be an exact canonical HTTPS origin in every verification mode,
  and enforce mode requires a lowercase 64-character policy hash before any
  bearer-bearing request.
- Transport fail mode now applies only when no HTTP response is received.
  Reached malformed, unverifiable, 429, and 5xx responses deny with a
  non-transport error code.
- Bearer-bearing authorize requests use manual redirect handling so reached 3xx
  responses deny as protocol input instead of being misclassified as transport
  failure.
- Warn mode preserves legacy `ALLOWED` execution when signed material is missing
  or invalid, emits a stable verification diagnostic, and returns a
  `LegacyUnverifiedAuthorization` that is not proof of verification.

### Security

- Execution adapters no longer branch on raw decision strings. They require an
  opaque capability created by the verification boundary.

## [0.8.1] - 2026-08-16

### Added

- Policy 2.3 response controls on the separate async `checkResultV2` API and the
  explicit `verifyResponsePolicyAuthorizationV2` verifier. Format 1 remains on
  the Policy 2.2 API; neither verifier reinterprets the other format.
- `AuthenticatedScannerTransport` injection point. The SDK ships no scanner,
  endpoint, credentials, certificate handling, model, Python runtime, or network
  client. The operator adapter receives one private copy of the bounded
  `sof-rp-projection-v1` bytes and returns authenticated raw JSON bytes.
- Enforced scanner bounds: 2,000 ms deadline, 1 MiB response limit,
  duplicate-aware strict JSON parsing, and verification of every execution,
  policy, profile, content, class, offset, confidence, and evidence-digest
  binding. Hostile extra fields are rejected.
- Deterministic disposition precedence: BLOCK over REDACT over ALLOW. Verified
  redaction spans are merged deterministically and bound to the exact input
  projection by `redactionPlanDigest`. Observe findings never change disposition.

### Changed

- Compact JWS verification now requires exact Warrant Core `0.4.0`, up from
  `0.3.0`.

### Security

- Content that already reaches a deterministic block or redaction is never sent
  to the scanner. A required-scanner failure blocks; an optional-scanner failure
  records bounded metadata and continues deterministic evaluation. No response
  bytes or scanner error text enter logs, metrics, traces, hosted Sign, or
  hosted receipts through this API.
- `npm run publish:guard` enforces the trusted-publishing workflow
  configuration: the expected repository and registry URLs, the
  `npm-production` environment, the release and dispatch event conditions, job
  permissions, and a mandatory `--provenance` flag on every publish command. It
  validates how publication is configured, not the contents or integrity of the
  published artifact.

## [0.8.0] - 2026-08-07

### Added

- Policy 2.2 format-1 `checkResult`, separate from `checkIntent`, with
  schema-closed ALLOW/BLOCK decisions and exact execution, request, result,
  tenant, task, tool, policy, content-type, authorization, and projection
  bindings.
- Exact Warrant Core `0.3.0` signed-envelope verification through
  `verifyResponsePolicyAuthorization`, plus the fail-closed
  `verifyAndCheckResult` composition. Verification context remains
  caller-supplied trusted state and is never derived from envelope claims.
- Frozen `sof-rp-projection-v1` framing for SDK-decoded MCP
  `CallToolResult` values. Text, embedded-resource text, resource-link strings,
  and canonical structured content are covered; binary, mixed, unknown,
  oversized, over-depth, or malformed results fail closed.
- Pinned `sof-response-rules-v1` and `sof-response-classes-v1` manifests,
  digests, deterministic local findings, exact response-literal matching, and
  UTF-8 byte offsets over the framed projection.
- Adversarial tests for binary refusal, mixed-result refusal, depth bounds,
  canonical structured content, `isError` parity, binding failures, expiry,
  projection tampering, Unicode non-normalization, exact literals, and zero
  response egress.

### Security

- Result bytes have no path to Sign, `fetch`, logging, diagnostics, callbacks,
  telemetry, or hosted receipts. Covered calls fail closed regardless of the
  general TypeScript client's pre-execution fail-mode default.
- `checkResult` accepts only a format-1 policy payload already verified by the
  Warrant Core compact-JWS verifier. Callers must never construct the verified
  policy object from untrusted JSON.

## [0.7.0] - 2026-08-02

Version note: this release is `0.7.0`, not `0.6.0`, because `0.6.0` shipped to npm on 2026-08-02 carrying only the basic Cowork adapter. The remaining Phase C surface below is additive public API, hence a further minor bump.

### Added

- `readStrictJson` / `mapStrictJsonError` (`src/strict-json.ts`), supported package-root exports: a duplicate-aware strict JSON reader operating on raw bytes. Rejects duplicate keys at every nesting level (`JSON.parse` destroys that evidence), enforces a UTF-8 byte cap, decodes UTF-8 strictly, bounds nesting depth, and requires an object root. Each failure class maps to exactly one public error code; `oversize` splits by context (`SIGIL_INPUT_TOO_LARGE` on stdin, `SIGIL_RESPONSE_INVALID` on a response).
- `strictResponse` interceptor mode, selected by the Cowork adapter: the Sign response body is read under a 64 KiB cap with a body-read deadline, parsed by the strict reader, and validated against an exact status schema **before** any positive authorization can be produced. Only a strictly schema-valid explicit positive status (object; `status`; optional string `policy_hash`/`task_id`; any unknown field rejects) can approve. Malformed JSON, missing/unknown/wrong-typed `status`, duplicate keys, truncated or oversized bodies, HTML interstitials, 204/206/3xx/4xx, `PENDING` without `hold_id`, `DENIED` without `error_code`, and a positive status carrying cross-status fields (`hold_id`, `error_code`, `failOpen`) all deny with `SIGIL_RESPONSE_INVALID`; 429 denies fast with `SIGIL_RATE_LIMITED`. The default path for every other adapter is unchanged and pinned by a before-and-after regression suite.
- `signal?: AbortSignal` on `SigilHookConfig`, propagated into `fetch` so an aborted caller deadline cancels the in-flight socket rather than leaving it open behind a settled process.
- `onDiagnostic?: (d: SigilDiagnostic) => void`: structured audit fields (`decision`, `errorCode`, `holdId`, `policyHash`, `taskId`, `toolName`, `classification`, `latencyMs`, `reachability`) so hook wrappers never parse the deny reason string. An approved governed call is distinguishable from an excluded-tool skip.
- Cowork adapter rework (`src/adapters/cowork.ts`):
  - `COWORK_GOVERNED_TOOLS`, the frozen versioned governed-tool inventory (`inventoryVersion: 1`), and `COWORK_TOOL_MANIFEST`, a supported frozen data export carrying the inventory, the Cowork-local action map, and the inventory version.
  - `classifyCoworkTool`: exact-name inventory match, the anchored two-segment `mcp__<server>__<tool>` pattern, and — per the 2026-08-02 Phase A capture — opaque per-tool names (`mcp__<12-hex>`) classified by `tool_input` shape (`command` string = Bash class, `url` string = WebFetch class, otherwise generic MCP passthrough). Unclassified names deny with `SIGIL_TOOL_UNCLASSIFIED` while the observation request still reaches Sign for the coverage-gap alert.
  - `projectArguments`: per-action allowlist projection with UTF-8-byte caps; over-cap values are rejected with `SIGIL_INPUT_OVERSIZE`, never truncated. MCP tools send server name, tool name, and sorted argument key names — never argument values.
  - `canonicalize` (`sigil-canon/1`), `policyProjectionDigest`, and `executionBindingDigest`: byte-pinned canonical serialization (UTF-8-byte key sort, NFC normalization, type tags, order-significant arrays, depth bound 32, safe-integers only) with known-answer fixtures generated by an independent implementation. The execution digest covers the complete raw `tool_input` including withheld fields, so a hold binds to what will actually execute without that plaintext leaving the endpoint. Deliberate boundary: a prohibited numeric form (fractional, `-0`, outside the safe-integer range) anywhere in the raw `tool_input` denies the call with `SIGIL_INPUT_MALFORMED` — rejection instead of a rounding convention is the specified behavior, because an encoding convention for those forms would let two implementations silently disagree on hold identity.
  - `clampCoworkTimeout`: only a finite integer in [250, 2500] passes verbatim; everything else resolves to 2500 with one logged substitution.
  - `createCoworkPreToolUseHook` now forces `framework: 'cowork'`, `failMode: 'closed'`, and `strictResponse: true` unconditionally (not defaulted — configuration cannot weaken them), accepts raw payload bytes/strings parsed through the strict reader, binds `task_id` to the Cowork `session_id`, and appends `hold_id` and next-steps to the deny reason.
- Additive error-code constants: `SIGIL_TOOL_UNCLASSIFIED`, `SIGIL_RESPONSE_INVALID`, `SIGIL_RATE_LIMITED`, `SIGIL_INPUT_OVERSIZE`, `SIGIL_INPUT_DUPLICATE_KEY`, `SIGIL_CONFIG_MISSING`, `SIGIL_HOOK_INTERNAL`, `SIGIL_HOOK_TIMEOUT`, `SIGIL_INPUT_MALFORMED`, `SIGIL_INPUT_TOO_LARGE`, `SIGIL_INPUT_ENCODING`, `SIGIL_INPUT_TIMEOUT`, `SIGIL_INPUT_ERROR`.
- Contract fixture `tests/contract-fixtures/v1/cowork_pretooluse.json`: the outgoing wire body for a Cowork Bash-class call captured through the real HTTP path, whose input field set exactly matches the real captured Bash record (opaque tool name, `effort.level`, `prompt_id`, no `turn_id`, no `model`) with deterministic canary values. Hash added to `SHA256SUMS`.
- Shared-map regression suite (`tests/adapters/shared-map-regression.test.ts`) against a committed canonical serialization of `TOOL_ACTION_MAP` generated from tag `v0.5.3` — `src/adapters/shared.ts` is untouched, so no existing adapter's action names move on this upgrade.

### Hardening (adversarial review)

- Prototype-chain tool names (`__proto__`, `constructor`, `toString`, `hasOwnProperty`) now fall to unclassified and deny with `SIGIL_TOOL_UNCLASSIFIED` instead of classifying as governed-with-undefined-action and throwing; `classifyCoworkTool` and `projectArguments` use `Object.hasOwn` for every record lookup.
- Opaque per-tool names shape-classify to the Bash or WebFetch class only when the entire `tool_input` key set is a subset of that class's real field set (Bash: `{command}`; WebFetch: `{url, method?}`). A smuggled extra key (e.g. `{command, path}`) falls through to generic MCP passthrough, so a model-authored key cannot reroute an opaque MCP tool into the bash/web_fetch policy class.
- Canonicalization and the strict JSON reader reject non-well-formed strings (lone surrogates), which would otherwise collide on one digest via UTF-8 `U+FFFD` substitution. This is a rejection, not an encoding change, so no canon version bump. Added `numeric_negative_zero` and `string_lone_surrogate` rejection fixtures (regenerated through the same independent implementation, so the provenance note holds).
- `strictResponse` requests set `redirect: 'error'` so a real 3xx becomes a fail-closed deny rather than a silently followed redirect; the default (non-strict) path keeps normal follow behavior.
- Contract fixture command value aligned to the `CANARY_COMMAND_01` canary form (regenerated through the real HTTP path; `SHA256SUMS` updated).
- New regression tests for every item above, plus: a confinement test proving a sensitive value appears in exactly its declared positions (`intent.arguments.command` and the deliberately-retained `intent.command` that Sign's Lex evaluates) and nowhere else (metadata, deny reason, diagnostics); a README governed-tool-table drift test rendering the table from `COWORK_TOOL_MANIFEST`; an action-map/inventory consistency test; and a programmatic assertion that every reader-side error-code constant is produced by a fixture (the five wrapper-phase constants are marked Phase D obligations and asserted on the export surface).

### Changed

- `CoworkPreToolUsePayload` reconciled to the real captured field set: added `transcript_path`, `prompt_id`, `effort`, `agent_id`, `agent_type`; removed the provisional `turn_id` and `model` fields (they do not exist on the surface). `agent_id`/`agent_type` appear only on a subagent's own calls.
- `SigilIntent` gains an optional `arguments` field (the per-action projection), serialized on the wire only when present; absent for every other adapter, whose wire bodies remain byte-identical (pinned by the existing contract fixtures).
- `FRAMEWORKS.cowork.notes` now records the PENDING-to-deny rule, the forced fail-closed mode, and the completion-boundary qualifier.

## [0.6.0] - 2026-08-02

### Added

- Basic Cowork `PreToolUse` adapter: `createCoworkPreToolUseHook` with the `hookSpecificOutput` deny shape, fail-closed default, and the `cowork` framework-registry entry (#23). Payload type provisional pending the Phase A capture.

## [0.5.3] - 2026-07-24

### Fixed

- Fail closed on authentication 403 responses (#17): HTTP 401 and non-`DENIED` 403 map to `SIGIL_AUTH_FAILURE` denials instead of routing through the fail-open transport path.

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
- `SigilHookResult.failOpen?: boolean` — set to `true` when a positive result was returned via the fail-open fallback rather than real policy evaluation.
- `SIGIL_UNREACHABLE` — new error code surfaced on `DENIED` in `failMode: 'closed'` when Sigil is unreachable. Exported as both a runtime constant and a type-level discriminant.
- `buildRejectionContext` now produces a dedicated branch for `SIGIL_UNREACHABLE` with transient-failure `sigil_next_steps` ("pause and retry when restored; do not report a policy violation").
- `createOpenclawSigilHandler` — native adapter for OpenClaw's `before_tool_call` plugin hook. Also covers NVIDIA NemoClaw (same hook surface).
- `FRAMEWORKS` registry — typed enumeration of eight recognized framework identifiers (`agent-hooks`, `anthropic-sdk`, `eliza`, `langchain`, `openclaw`, `nemoclaw`, `ironclaw`, `agentpay`). Advisory; `config.framework` remains a free string.
- README sections for OpenClaw / NemoClaw, IronClaw (dispatch-host pattern), and a rolled-up Supported Frameworks table.
- AgentPay section now carries an explicit `failMode: 'closed'` requirement callout.

### Changed

- **Behavior change — 5xx responses in `failMode: 'open'`:** a `5xx` response with a valid-but-empty JSON body previously surfaced as `DENIED` + `SIGIL_POLICY_VIOLATION`. It now surfaces as a positive result with `failOpen: true` — consistent with the fail-open contract. Hosts that branched on the old `SIGIL_POLICY_VIOLATION` for 5xx should migrate to branching on `failOpen`.
- Log event renamed: `sigil_hook_network_error` → `sigil_hook_unreachable`. Payload now includes `failMode` and uses `error` level in closed mode (was always `warn`).

### Deferred

- Deprecation of the default `failMode: 'open'` — revisit in v0.3.0 once adoption data is available.
- Native Rust integration for IronClaw's `Hook` trait — queued as a separate package, `@sigilcore/agent-hooks-rs`.
- Per-action `failMode` overrides (e.g., automatic `'closed'` for `wallet.*`) — documentation-only guidance for now; no surprising runtime behavior.
