# Decision vocabulary Wave 0 evidence

Date: August 20, 2026

Baseline: `Sigil-Core/agent-hooks` `origin/main` at
`0d3c86adb738fb3a79e90c79d474c4db7b260fdf`.

## Occurrence classification

The baseline contains 141 case-sensitive `APPROVED` occurrences in 28 text
files. The classification is exhaustive for this repository.

| Class | Files | Occurrences | Disposition |
| --- | ---: | ---: | --- |
| Runtime authorization decision | 11 | 28 | Normalize at the verifier boundary and emit `ALLOWED` only. |
| Tests and contract fixtures | 14 | 85 | Keep legacy inputs where they prove alias compatibility; expect canonical output. |
| README and changelog | 2 | 11 | Update current documentation; retain historical changelog evidence. |
| Historical implementation plan | 1 | 17 | Historical evidence, excluded from runtime and the literal gate. |
| Foreign approval domain | 0 | 0 | No allowlist entry required. |

The totals reconcile to 28 files and 141 occurrences. Runtime source contains
no foreign approval domain. The response-policy literals `ALLOW`, `BLOCK`, and
`REDACT` remain separate and unchanged.

### Exact baseline artifact

Each row below classifies every `APPROVED` occurrence in that baseline file.
The count is literal occurrences, not matching lines. No baseline file with a
match is omitted.

| Baseline file | Occurrences | Classification |
| --- | ---: | --- |
| `CHANGELOG.md` | 5 | Historical/current documentation |
| `README.md` | 6 | Current documentation and samples |
| `docs/plans/2026-03-27-agent-hooks-package.md` | 17 | Historical implementation plan |
| `src/adapters/agentpay.ts` | 1 | Runtime authorization decision |
| `src/adapters/claude.ts` | 1 | Runtime authorization decision |
| `src/adapters/codex.ts` | 1 | Runtime authorization decision |
| `src/adapters/cowork.ts` | 5 | Runtime authorization decision |
| `src/adapters/eliza.ts` | 1 | Runtime authorization decision |
| `src/adapters/hermes.ts` | 1 | Runtime authorization decision |
| `src/adapters/langchain.ts` | 1 | Runtime authorization decision |
| `src/adapters/openclaw.ts` | 1 | Runtime authorization decision |
| `src/adapters/openrouter.ts` | 1 | Runtime authorization decision |
| `src/interceptor.ts` | 12 | Runtime authorization decision |
| `src/types.ts` | 3 | Runtime authorization decision |
| `tests/adapters/agentpay.test.ts` | 2 | Authorization test/fixture |
| `tests/adapters/claude.test.ts` | 4 | Authorization test/fixture |
| `tests/adapters/codex.test.ts` | 4 | Authorization test/fixture |
| `tests/adapters/cowork.test.ts` | 22 | Authorization test/fixture |
| `tests/adapters/hermes.test.ts` | 2 | Authorization test/fixture |
| `tests/adapters/http-intents.test.ts` | 1 | Authorization test/fixture |
| `tests/adapters/openclaw.test.ts` | 9 | Authorization test/fixture |
| `tests/adapters/openrouter.test.ts` | 3 | Authorization test/fixture |
| `tests/adapters/shared-map-regression.test.ts` | 1 | Authorization test/fixture |
| `tests/contract-fixtures.test.ts` | 1 | Authorization test/fixture |
| `tests/interceptor-default-path.test.ts` | 9 | Authorization test/fixture |
| `tests/interceptor.test.ts` | 22 | Authorization test/fixture |
| `tests/model-usage.test.ts` | 2 | Authorization test/fixture |
| `tests/strict-json.test.ts` | 3 | Authorization test/fixture |

Reconciliation: 28 files, 141 occurrences. Runtime authorization is 28,
tests and fixtures are 85, current or historical documentation is 11, and the
historical implementation plan is 17. Foreign-domain count is zero.

## Frozen contract

- Fixture directory: `tests/contract-fixtures/v1`
- Decision fixture: `tests/contract-fixtures/v1/decision-records.json`
- Decision fixture SHA-256:
  `f8abe5060f44ce5cbc83047f1513107a18d5e50c8695d40f48ea6c5bd52df28a`
- Minimum decision-vector count: 23
- Minimum malformed-JOSE vector count: 6
- Runtime allowlist: `decision-literal-allowlist.json`
- Runtime allowlist SHA-256:
  `81a592a6d6c7d86cea4f54150c6c04a736568dd4e9089c88af4c0651a866abbe`

The vectors cover canonical and alias allow inputs, all three decisions,
literal and token substitution, signature tampering, expiration, audience,
all three signed surfaces, intent, policy, nonce, missing and mixed attestations,
token-profile confusion, rotation overlap, shared malformed-JOSE mutations,
missing records, and unknown literals. The TypeScript loader asserts
the vector-count floor so an empty fixture set cannot pass.

## Deployed-component by wave compatibility matrix

The deployed unit is `@sigilcore/agent-hooks`; all nine adapters in this
repository ship in that package and therefore have the same row. "Wire only"
means the build can parse the response but is not an eligible Wave 3 deployed
posture because it still permits the legacy path.

| Deployed component/build | Wave 0: legacy unsigned emitter | Wave 1: widened consumers | Wave 2: signed `ALLOWED` emitter | Wave 3: enforced consumers | Wave 4: cleanup |
| --- | --- | --- | --- | --- | --- |
| `@sigilcore/agent-hooks@0.8.1` | Compatible | Compatible until replacement | Incompatible: `ALLOWED` is unknown and Cowork strict parsing rejects the added record | Incompatible | Incompatible |
| `@sigilcore/agent-hooks@0.9.0`, warn mode | Compatible: normalize alias and issue only a legacy capability | Compatible, required deployment posture | Compatible: verify record and attestation and issue a verified capability | Wire only, prohibited as final Wave 3 posture | Wire only, prohibited as final posture |
| `@sigilcore/agent-hooks@0.9.0`, enforce mode | Incompatible by design: unsigned allow denies | Incompatible by design until the emitter signs | Compatible | Compatible, required deployment posture | Compatible |

Response-level tolerances shared by every `0.9.0` adapter:

| Sign response | Warn mode | Enforce mode |
| --- | --- | --- |
| Legacy `APPROVED`, no record | Return canonical `ALLOWED` with `LegacyUnverifiedAuthorization`; log `record_missing`. | Deny. |
| Canonical `ALLOWED`, valid record and attestation | Return `ALLOWED` with `VerifiedAuthorization`. | Return `ALLOWED` with `VerifiedAuthorization`. |
| Either allow literal, invalid signed material | Return canonical `ALLOWED` with `LegacyUnverifiedAuthorization`; log the stable reason code. | Deny. |
| `DENIED` or `PENDING`, no record | Preserve the conservative outcome; log `record_missing`. | Preserve deny or pending without an execution capability. |
| Transport failure with fail-open configured | Preserve the documented transport fallback with a distinct legacy capability. | Preserve the documented transport fallback. Verification failure is not treated as transport failure. |

## Gate status

Security-seam trigger map version 1.1 treats GitHub workflow changes and diffs
containing the configured `policyHash` and `verifySignature` symbols as
security-seam. The literal gate is advisory in Wave 1. Its committed negative
control proves blocking mode exits nonzero on a planted runtime literal. The
architecture lint and capability compile checks also carry committed negative
controls. Architecture lint confines raw JOSE libraries and Node
signature-verification primitives to `src/decision.ts`. Purpose-specific
hashing and nonce generation outside that verifier remain allowed because they
do not parse or verify authorization tokens.
