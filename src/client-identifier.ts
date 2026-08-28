// src/client-identifier.ts
//
// Observability-only client identity for outbound governed requests.
//
// `X-Sigil-Client` is untrusted diagnostic metadata. Sign echoes its own build
// back on `X-Sigil-Service-Commit`; that name lives here too so both halves of
// the contract sit in one place. Neither header is an input to any
// authorization, rate-limit, policy-selection, retry, or trust decision. The
// interceptor treats both as opaque strings carried for support triage.
//
// Grammar, fixed and unquoted:
//
//   name=<package>; version=<semver>; commit=<40-hex>
//
// Keys are always in that order, separated by exactly `; `. `commit` is omitted
// entirely when the publish workflow did not inject one; no placeholder value is
// ever emitted. The serialized value is capped at 256 bytes.
//
// Package identity comes from build-time constants, never from runtime git or
// filesystem discovery. tsup replaces the three exact static `process.env`
// property accesses below with package and publish-workflow literals. In
// an unbundled execution (the test suite, or a consumer running the raw
// TypeScript) those constants are absent, so the identity is unavailable and no
// header is emitted rather than a wrong one.

/**
 * Outbound header carrying the untrusted client identity.
 */
export const SIGIL_CLIENT_HEADER = 'X-Sigil-Client' as const;

/**
 * Response header carrying Sign's own build commit. Observability only: never
 * validated here and never consulted for a decision.
 */
export const SIGIL_SERVICE_COMMIT_HEADER = 'X-Sigil-Service-Commit' as const;

/** Maximum serialized `X-Sigil-Client` value, in bytes. */
export const SIGIL_CLIENT_HEADER_MAX_BYTES = 256;

/** The fixed grammar, restated for documentation and diagnostics. */
export const SIGIL_CLIENT_HEADER_GRAMMAR =
  'name=<package>; version=<semver>; commit=<40-hex>' as const;

const FIELD_SEPARATOR = '; ';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
// The canonical semver grammar, so a version that a semver tool would reject
// cannot reach the wire.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/**
 * A bare token: printable ASCII with no separator, whitespace, or quoting. This
 * is deliberately tighter than npm's own name grammar, because the value is
 * placed verbatim in an HTTP header and must never be able to carry `;`, `=`, a
 * comma, a quote, or a control character.
 */
const BARE_TOKEN_PATTERN = /^[A-Za-z0-9@/._-]+$/;

export class SigilClientIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigilClientIdentifierError';
  }
}

export interface SigilClientIdentity {
  /** npm package name, emitted bare. */
  name: string;
  /** Package version, strict semver. */
  version: string;
  /** Source commit injected by the publish workflow. Absent when unavailable. */
  commit?: string;
}

/**
 * A validated `X-Sigil-Client` value. Construction is the only place a grammar
 * violation can exist, and it throws there, so nothing downstream can emit a
 * malformed header by forgetting to check.
 */
export class SigilClientIdentifier {
  readonly name: string;
  readonly version: string;
  readonly commit: string | undefined;
  /** The exact header value: validated once, emitted byte-identically forever. */
  readonly headerValue: string;

  constructor(identity: SigilClientIdentity) {
    const { name, version } = identity;
    const commit = identity.commit;

    // Every field is type-checked before its pattern, because a pattern only
    // sees whatever a non-string value coerces to.
    if (typeof name !== 'string' || !BARE_TOKEN_PATTERN.test(name)) {
      throw new SigilClientIdentifierError(
        `client identifier name must be a bare token, got ${JSON.stringify(name)}`,
      );
    }
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
      throw new SigilClientIdentifierError(
        `client identifier version must be strict semver, got ${JSON.stringify(version)}`,
      );
    }
    if (commit !== undefined && (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))) {
      throw new SigilClientIdentifierError(
        'client identifier commit must be exactly 40 lowercase hex characters when present, got '
          + `${JSON.stringify(commit)}`,
      );
    }

    const headerValue = commit === undefined
      ? `name=${name}${FIELD_SEPARATOR}version=${version}`
      : `name=${name}${FIELD_SEPARATOR}version=${version}${FIELD_SEPARATOR}commit=${commit}`;
    const headerBytes = Buffer.byteLength(headerValue, 'utf8');
    if (headerBytes > SIGIL_CLIENT_HEADER_MAX_BYTES) {
      throw new SigilClientIdentifierError(
        `serialized client identifier is ${headerBytes} bytes, over the `
          + `${SIGIL_CLIENT_HEADER_MAX_BYTES}-byte cap`,
      );
    }

    this.name = name;
    this.version = version;
    this.commit = commit;
    this.headerValue = headerValue;
    Object.freeze(this);
  }
}

/**
 * Normalizes one build-time constant. tsup injects each exact static property
 * access as a string literal; in an unbundled execution the key is absent. An
 * empty injected value means the
 * workflow did not produce one, which is the documented "unavailable" state and
 * never a placeholder to emit.
 */
const buildConstant = (value: string | undefined): string | undefined => {
  return value === undefined || value.length === 0 ? undefined : value;
};

/**
 * The identifier this build emits, or undefined when the build carried no
 * package identity. A value that is present but malformed throws here, before
 * the interceptor can send anything.
 */
export const resolveClientIdentifier = (): SigilClientIdentifier | undefined => {
  // Keep these as static property accesses. esbuild's define substitution is
  // deliberately exact and must leave no runtime-selectable environment key in
  // the published artifact.
  const name = buildConstant(process.env.SIGIL_PACKAGE_NAME);
  const version = buildConstant(process.env.SIGIL_PACKAGE_VERSION);
  if (name === undefined || version === undefined) {
    return undefined;
  }
  return new SigilClientIdentifier({
    name,
    version,
    commit: buildConstant(process.env.SIGIL_SOURCE_COMMIT),
  });
};
