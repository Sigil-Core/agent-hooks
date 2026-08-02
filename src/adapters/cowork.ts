// src/adapters/cowork.ts
//
// Claude Cowork PreToolUse adapter. Behavioral authority: the Sigil Cowork
// plugin design (2026-07-29, revision 3) and implementation plan Phase C.
// Payload contract ground truth: the Phase A capture
// (cowork-plugin docs/evidence/phase-a/payload-capture-2026-08-02.json).
//
// Three properties are load-bearing and enforced by tests:
// - PENDING and DENIED both emit permissionDecision 'deny'; the literal type
//   makes a locally approvable hold a compile error.
// - failMode and framework are forced, not defaulted; configuration cannot
//   weaken either.
// - Only a strictly schema-valid explicit APPROVED returns undefined; every
//   other outcome denies (strictResponse mode in the interceptor).

import { createHash } from 'node:crypto';
import { checkIntent } from '../interceptor.js';
import { buildRejectionContext } from '../rejection.js';
import { mapStrictJsonError, readStrictJson } from '../strict-json.js';
import {
  SIGIL_INPUT_MALFORMED,
  SIGIL_INPUT_OVERSIZE,
  SIGIL_RESPONSE_INVALID,
  SIGIL_TOOL_UNCLASSIFIED,
  SIGIL_UNREACHABLE,
} from '../types.js';
import type {
  SigilDiagnostic,
  SigilHookConfig,
  SigilHookResult,
  SigilIntent,
} from '../types.js';
import { intentFromToolInput, resolveTaskIdFromPayload } from './shared.js';

/**
 * The real Cowork PreToolUse field set, reconciled to the Phase A capture of
 * 2026-08-02 (macOS client 1.24012.9). `agent_id` and `agent_type` appear only
 * on a subagent's own calls, never on the parent Agent call. There is no
 * `turn_id` and no `model` field on this surface.
 */
export interface CoworkPreToolUsePayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt_id?: string;
  permission_mode?: string;
  effort?: { level?: string; [key: string]: unknown };
  hook_event_name?: string;
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  [key: string]: unknown;
}

export interface CoworkPreToolUseDenyResult {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export type CoworkPreToolUseResult = CoworkPreToolUseDenyResult | undefined;

// ---------------------------------------------------------------------------
// Governed-tool inventory and classifier
// ---------------------------------------------------------------------------

export interface CoworkToolInventoryEntry {
  classification: 'governed' | 'excluded';
  /** Canonical Sigil action for governed entries. */
  action?: string;
  reason: string;
}

/**
 * The versioned governed-tool inventory. Coverage is this explicit list plus
 * the two anchored mcp__ name patterns handled by `classifyCoworkTool`, never
 * a matcher side effect; the hooks.json matcher is `.*` and classification
 * happens here where every invocation is visible.
 */
export const COWORK_GOVERNED_TOOLS = Object.freeze({
  inventoryVersion: 1,
  tools: Object.freeze({
    Bash: Object.freeze({
      classification: 'governed',
      action: 'bash',
      reason: 'Shell execution; governed by tool_calls.allowed: bash and bash.blocked_commands.',
    }),
    Edit: Object.freeze({
      classification: 'governed',
      action: 'file_write',
      reason: 'File mutation; governed by file_write.blocked_paths and the filesystem profile.',
    }),
    Write: Object.freeze({
      classification: 'governed',
      action: 'file_write',
      reason: 'File creation/overwrite; governed by file_write.blocked_paths and the filesystem profile.',
    }),
    Read: Object.freeze({
      classification: 'governed',
      action: 'file_read',
      reason: 'Filesystem read; file_read is the read effect of the filesystem profile.',
    }),
    Glob: Object.freeze({
      classification: 'governed',
      action: 'file_read',
      reason: 'Filesystem read over a path scope; shares file_read with Read and Grep.',
    }),
    Grep: Object.freeze({
      classification: 'governed',
      action: 'file_read',
      reason: 'Filesystem content search; shares file_read with Read and Glob.',
    }),
    Agent: Object.freeze({
      classification: 'governed',
      action: 'agent_spawn',
      reason: 'Subagent dispatch multiplies the tool surface; subagent calls are themselves hooked.',
    }),
    WebFetch: Object.freeze({
      classification: 'governed',
      action: 'web_fetch',
      reason: 'Network fetch; governed by web_fetch.blocked_domains, promoted to http with an explicit method.',
    }),
    WebSearch: Object.freeze({
      classification: 'governed',
      action: 'web_fetch',
      reason: 'Governed if it ever appears; absent from the Cowork surface per the 2026-08-02 Phase A capture.',
    }),
    AskUserQuestion: Object.freeze({
      classification: 'excluded',
      reason: 'No external effect; a fail-closed block here would deadlock the session.',
    }),
    ExitPlanMode: Object.freeze({
      classification: 'excluded',
      reason: 'No external effect; session-state transition only.',
    }),
  }) as Readonly<Record<string, CoworkToolInventoryEntry>>,
});

/**
 * Cowork-local action map, consulted before the shared mapToolAction fallback.
 * `src/adapters/shared.ts` is deliberately untouched so no other adapter's
 * action names move on a minor upgrade.
 */
const COWORK_TOOL_ACTION_MAP: Readonly<Record<string, string>> = Object.freeze({
  Bash: 'bash',
  Edit: 'file_write',
  Write: 'file_write',
  Read: 'file_read',
  Glob: 'file_read',
  Grep: 'file_read',
  Agent: 'agent_spawn',
  WebFetch: 'web_fetch',
  WebSearch: 'web_fetch',
});

/**
 * Supported frozen data export consumed by the plugin bundle and the
 * documentation generator, so neither duplicates the inventory or the map.
 */
export const COWORK_TOOL_MANIFEST = Object.freeze({
  inventoryVersion: COWORK_GOVERNED_TOOLS.inventoryVersion,
  inventory: COWORK_GOVERNED_TOOLS.tools,
  actionMap: COWORK_TOOL_ACTION_MAP,
});

/** Ordinary two-segment MCP tool name: mcp__<server>__<tool>. Anchored. */
const MCP_TOOL_NAME_PATTERN = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
/**
 * Opaque per-tool name observed on the real Cowork host (Phase A capture,
 * 2026-08-02): built-in tool classes arrive as mcp__<12-hex-digest>, e.g.
 * Bash as `mcp__c44359886c49` and WebFetch as `mcp__4ded42abd557`. Anchored.
 */
const OPAQUE_COWORK_TOOL_PATTERN = /^mcp__[0-9a-f]{12}$/;

export type CoworkToolClassification =
  | {
      classification: 'governed';
      /** Canonical class driving projection: an inventory key or 'mcp'. */
      toolClass: string;
      action: string;
    }
  | { classification: 'excluded' }
  | { classification: 'unclassified' };

/**
 * Classifier: exact-string equality against the frozen inventory, then the
 * two anchored mcp__ patterns. Opaque single-segment names are classified by
 * tool_input shape, because the Phase A capture proves the real host delivers
 * Bash and WebFetch under opaque per-tool digests where a literal-name
 * classifier catches nothing: a string `command` is the Bash class, a string
 * `url` is the WebFetch class, and anything else is generic MCP passthrough.
 * Everything unmatched is unclassified and denies.
 */
export function classifyCoworkTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): CoworkToolClassification {
  const entry = COWORK_GOVERNED_TOOLS.tools[toolName];
  if (entry !== undefined) {
    if (entry.classification === 'excluded') return { classification: 'excluded' };
    return {
      classification: 'governed',
      toolClass: toolName,
      action: entry.action as string,
    };
  }
  if (OPAQUE_COWORK_TOOL_PATTERN.test(toolName)) {
    if (typeof toolInput['command'] === 'string') {
      return { classification: 'governed', toolClass: 'Bash', action: 'bash' };
    }
    if (typeof toolInput['url'] === 'string') {
      return { classification: 'governed', toolClass: 'WebFetch', action: 'web_fetch' };
    }
    return {
      classification: 'governed',
      toolClass: 'mcp',
      action: toolName.toLowerCase(),
    };
  }
  if (MCP_TOOL_NAME_PATTERN.test(toolName)) {
    return {
      classification: 'governed',
      toolClass: 'mcp',
      action: toolName.toLowerCase(),
    };
  }
  return { classification: 'unclassified' };
}

// ---------------------------------------------------------------------------
// Argument projection (design section 8.4). All caps are UTF-8 bytes.
// ---------------------------------------------------------------------------

const MCP_NAME_CAP_BYTES = 128;
const MCP_MAX_ARGUMENT_KEYS = 32;

/** Per-class allowlist: input field name -> byte cap. */
const PROJECTION_FIELDS: Readonly<Record<string, ReadonlyArray<readonly [string, number]>>> =
  Object.freeze({
    Bash: [['command', 4096]],
    Write: [['file_path', 1024]],
    Edit: [['file_path', 1024]],
    Read: [['file_path', 1024]],
    Glob: [['pattern', 512], ['path', 1024]],
    Grep: [['pattern', 512], ['path', 1024], ['glob', 256]],
    WebFetch: [['url', 2048], ['method', 16]],
    WebSearch: [['query', 512]],
    Agent: [['subagent_type', 128], ['description', 256]],
  });

export type CoworkProjectionResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errorCode: string; message: string };

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

const oversize = (field: string, cap: number): CoworkProjectionResult => ({
  ok: false,
  errorCode: SIGIL_INPUT_OVERSIZE,
  message: `Field ${field} exceeds its ${cap}-byte cap. Oversize values are rejected, never truncated.`,
});

const malformedProjection = (message: string): CoworkProjectionResult => ({
  ok: false,
  errorCode: SIGIL_INPUT_MALFORMED,
  message,
});

/** Strips userinfo (https://user:pass@host/) without otherwise normalizing the URL. */
function stripUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Per-action allowlist projection. Copies only the named fields for the
 * classified tool, coerces each primitive to a string, rejects any value over
 * its declared cap rather than truncating it, and drops everything else. The
 * raw tool input is never forwarded wholesale. MCP tools send the server
 * name, the tool name, and the sorted key names of the arguments object; every
 * argument value is withheld and covered only by the execution digest.
 */
export function projectArguments(
  toolClass: string,
  toolName: string,
  raw: Record<string, unknown>,
): CoworkProjectionResult {
  if (toolClass === 'mcp') return projectMcpArguments(toolName, raw);
  const fields = PROJECTION_FIELDS[toolClass];
  if (fields === undefined) {
    return malformedProjection(`No projection is defined for tool class ${toolClass}.`);
  }
  const args: Record<string, unknown> = {};
  for (const [field, cap] of fields) {
    if (!(field in raw)) continue;
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return malformedProjection(
        `Field ${field} must be a primitive value on tool class ${toolClass}.`,
      );
    }
    let text = typeof value === 'string' ? value : String(value);
    if (toolClass === 'WebFetch' && field === 'url') {
      text = stripUrlUserinfo(text);
    }
    if (byteLength(text) > cap) return oversize(field, cap);
    args[field] = text;
  }
  return { ok: true, args };
}

function projectMcpArguments(
  toolName: string,
  raw: Record<string, unknown>,
): CoworkProjectionResult {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(toolName);
  // Opaque single-segment names have no server/tool split; the opaque name
  // stands in for both so the projection key set stays uniform.
  const server = match ? `mcp__${match[1]}` : toolName;
  const tool = match ? (match[2] as string) : toolName;
  if (byteLength(server) > MCP_NAME_CAP_BYTES) return oversize('server', MCP_NAME_CAP_BYTES);
  if (byteLength(tool) > MCP_NAME_CAP_BYTES) return oversize('tool', MCP_NAME_CAP_BYTES);
  const keys = Object.keys(raw);
  if (keys.length > MCP_MAX_ARGUMENT_KEYS) {
    return oversize('argument_keys', MCP_MAX_ARGUMENT_KEYS);
  }
  for (const key of keys) {
    if (byteLength(key) > MCP_NAME_CAP_BYTES) {
      return oversize(`argument key ${key.slice(0, 32)}`, MCP_NAME_CAP_BYTES);
    }
  }
  const argumentKeys = [...keys].sort((a, b) =>
    Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
  );
  return { ok: true, args: { server, tool, argument_keys: argumentKeys } };
}

// ---------------------------------------------------------------------------
// Canonical serialization sigil-canon/1 and the two digests
// ---------------------------------------------------------------------------

export const SIGIL_CANON_VERSION = 'sigil-canon/1';
const CANON_MAX_DEPTH = 32;

export type CanonicalizeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; message: string };

class CanonError extends Error {}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

function encodeCanonical(value: unknown, depth: number, out: Buffer[]): void {
  if (depth > CANON_MAX_DEPTH) {
    throw new CanonError(`Nesting depth exceeds the bound of ${CANON_MAX_DEPTH}.`);
  }
  if (value === null) {
    out.push(utf8('z;'));
    return;
  }
  if (typeof value === 'boolean') {
    out.push(utf8(value ? 't;' : 'f;'));
    return;
  }
  if (typeof value === 'number') {
    // Deliberate design decision (implementation plan section 4): numbers are
    // handled by rejection rather than by a rounding convention, because every
    // convention for encoding fractionals, -0, or unsafe integers invites two
    // implementations to differ and silently invalidate hold identity. Both
    // digests share this one serialization (design 7.9), so a prohibited
    // numeric form ANYWHERE in the raw tool_input denies the call with
    // SIGIL_INPUT_MALFORMED — a documented fail-closed over-block, not a bug.
    // If pilot telemetry shows legitimate traffic hitting it, the format
    // version moves (sigil-canon/2), never the reject-do-not-guess rule.
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new CanonError(
        'Prohibited numeric form: only integers within the safe-integer range serialize.',
      );
    }
    out.push(utf8(`i${String(value)};`));
    return;
  }
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC');
    const bytes = utf8(normalized);
    out.push(utf8(`s${bytes.byteLength}:`), bytes, utf8(';'));
    return;
  }
  if (Array.isArray(value)) {
    out.push(utf8(`a${value.length}:`));
    for (const element of value) encodeCanonical(element, depth + 1, out);
    out.push(utf8(';'));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const normalizedKeys = new Map<string, unknown>();
    for (const [key, entryValue] of entries) {
      const normalizedKey = key.normalize('NFC');
      if (normalizedKeys.has(normalizedKey)) {
        throw new CanonError(
          `Duplicate object key after NFC normalization: ${JSON.stringify(normalizedKey)}.`,
        );
      }
      normalizedKeys.set(normalizedKey, entryValue);
    }
    const sortedKeys = [...normalizedKeys.keys()].sort((a, b) =>
      Buffer.compare(utf8(a), utf8(b)),
    );
    out.push(utf8(`o${sortedKeys.length}:`));
    for (const key of sortedKeys) {
      encodeCanonical(key, depth + 1, out);
      encodeCanonical(normalizedKeys.get(key), depth + 1, out);
    }
    out.push(utf8(';'));
    return;
  }
  throw new CanonError(`Unsupported value type: ${typeof value}.`);
}

/**
 * Canonical serialization, version sigil-canon/1, specified to the byte and
 * pinned by known-answer fixtures (tests/fixtures/canon). Keys sort by UTF-8
 * byte sequence, keys and string values are NFC-normalized, types are tagged,
 * arrays are order-significant, an absent key differs from a null key, depth
 * is bounded at 32, and only safe integers serialize; -0, fractional values,
 * Infinity, and NaN are rejected. The version string is embedded so a format
 * change moves every digest visibly and old holds fail closed.
 */
export function canonicalize(value: unknown): CanonicalizeResult {
  const out: Buffer[] = [utf8(`${SIGIL_CANON_VERSION}|`)];
  try {
    encodeCanonical(value, 1, out);
  } catch (error: unknown) {
    if (error instanceof CanonError) return { ok: false, message: error.message };
    throw error;
  }
  return { ok: true, bytes: Buffer.concat(out) };
}

export type CanonicalDigestResult =
  | { ok: true; digest: string }
  | { ok: false; message: string };

const canonicalDigest = (value: unknown): CanonicalDigestResult => {
  const canonical = canonicalize(value);
  if (!canonical.ok) return canonical;
  return {
    ok: true,
    digest: createHash('sha256').update(canonical.bytes).digest('hex'),
  };
};

/**
 * SHA-256 over the canonical serialization of the per-action projection: what
 * Sign evaluates. One implementation serves both digests so they cannot drift.
 */
export function policyProjectionDigest(
  args: Record<string, unknown>,
): CanonicalDigestResult {
  return canonicalDigest(args);
}

/**
 * SHA-256 over the canonical serialization of the complete raw tool_input,
 * including every field deliberately withheld from Sign as plaintext
 * (Write.content, Edit.old_string/new_string, Agent.prompt, MCP argument
 * values). Only the digest travels; the withheld plaintext never leaves the
 * endpoint, so a hold binds to what will actually execute.
 */
export function executionBindingDigest(
  rawToolInput: Record<string, unknown>,
): CanonicalDigestResult {
  return canonicalDigest(rawToolInput);
}

// ---------------------------------------------------------------------------
// Timeout clamp
// ---------------------------------------------------------------------------

export const COWORK_MIN_REQUEST_TIMEOUT_MS = 250;
export const COWORK_MAX_REQUEST_TIMEOUT_MS = 2500;

/**
 * Accepts only a finite integer between 250 and 2500 verbatim; everything
 * else (Infinity, NaN, 0, -1, 60000, wrong types, in-range fractionals)
 * resolves to 2500 with the substitution logged once at hook creation. The
 * clamped value can never outlive the wrapper's own deadline or reach the
 * platform hook timeout.
 */
export function clampCoworkTimeout(value: unknown): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= COWORK_MIN_REQUEST_TIMEOUT_MS &&
    value <= COWORK_MAX_REQUEST_TIMEOUT_MS
  ) {
    return value;
  }
  if (value !== undefined) {
    console.warn(
      JSON.stringify({
        event: 'sigil_cowork_timeout_substituted',
        requested: String(value),
        effectiveMs: COWORK_MAX_REQUEST_TIMEOUT_MS,
      }),
    );
  }
  return COWORK_MAX_REQUEST_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAYLOAD_MAX_DEPTH = 32;

type ReachabilityFromResult = 'ok' | 'unreachable' | 'http_error';

function reachabilityFor(result: SigilHookResult): ReachabilityFromResult {
  if (result.errorCode === SIGIL_UNREACHABLE) return 'unreachable';
  if (
    result.errorCode === 'SIGIL_AUTH_FAILURE' ||
    result.errorCode === SIGIL_RESPONSE_INVALID ||
    result.errorCode === 'SIGIL_RATE_LIMITED'
  ) {
    return 'http_error';
  }
  return 'ok';
}

function coworkCoverage(toolClass: string): string {
  if (toolClass === 'Bash') {
    return 'Cowork Bash executes in a Linux sandbox VM and arrives under an opaque per-tool mcp__ name, classified by tool_input shape.';
  }
  if (['Write', 'Read', 'Edit', 'Glob', 'Grep'].includes(toolClass)) {
    return "Cowork file tools (Write, Read, Edit, Glob, and Grep) are scoped to the session's connected folders and refuse targets outside them.";
  }
  if (toolClass === 'WebFetch' || toolClass === 'WebSearch') {
    return 'Cowork WebFetch arrives under an opaque per-tool mcp__ name. No web-search tool exists on this surface.';
  }
  if (toolClass === 'Agent') {
    return 'Cowork subagent invocations are independently governed calls carrying agent_id and agent_type.';
  }
  if (toolClass === 'mcp') {
    return 'Cowork MCP tool classes are reachable through PreToolUse; argument values are withheld and covered by the execution digest.';
  }
  return 'Tool name absent from the versioned Cowork governed-tool inventory.';
}

interface LocalDenial {
  errorCode: string;
  message: string;
}

export function createCoworkPreToolUseHook(config: SigilHookConfig) {
  const requestTimeoutMs = clampCoworkTimeout(config.requestTimeoutMs);

  return async (
    rawPayload: CoworkPreToolUsePayload | string | Uint8Array,
  ): Promise<CoworkPreToolUseResult> => {
    const startedAt = Date.now();
    const emit = (diagnostic: SigilDiagnostic): void => {
      try {
        config.onDiagnostic?.(diagnostic);
      } catch {
        // Diagnostics never alter enforcement.
      }
    };
    const localDeny = (
      denial: LocalDenial,
      action: string,
      toolName: string | undefined,
      classification: SigilDiagnostic['classification'],
    ): CoworkPreToolUseDenyResult => {
      emit({
        decision: 'DENIED',
        errorCode: denial.errorCode,
        toolName,
        classification,
        latencyMs: Date.now() - startedAt,
        reachability: 'not_attempted',
      });
      return denyResult(
        { decision: 'DENIED', errorCode: denial.errorCode, message: denial.message },
        action,
      );
    };

    const parsed = parseCoworkPayload(rawPayload);
    if ('denial' in parsed) {
      return localDeny(parsed.denial, 'cowork.pre_tool_use', undefined, undefined);
    }
    const payload = parsed.payload;

    if (typeof payload.tool_name !== 'string' || payload.tool_name.trim().length === 0) {
      return localDeny(
        {
          errorCode: SIGIL_INPUT_MALFORMED,
          message: 'Cowork PreToolUse payload is missing tool_name.',
        },
        'cowork.pre_tool_use',
        undefined,
        undefined,
      );
    }
    const toolName = payload.tool_name;
    if (payload.tool_input !== undefined && !isObject(payload.tool_input)) {
      return localDeny(
        {
          errorCode: SIGIL_INPUT_MALFORMED,
          message: 'Cowork PreToolUse payload tool_input must be an object.',
        },
        'cowork.pre_tool_use',
        toolName,
        undefined,
      );
    }
    const rawInput = payload.tool_input ?? {};

    const classified = classifyCoworkTool(toolName, rawInput);

    if (classified.classification === 'excluded') {
      emit({
        toolName,
        classification: 'excluded',
        latencyMs: Date.now() - startedAt,
        reachability: 'not_attempted',
      });
      return undefined;
    }

    if (classified.classification === 'unclassified') {
      // The request is deliberately not suppressed: the call reaches Sign so
      // the first-observation coverage-gap alert has a record to fire on. The
      // outcome is a deny regardless of what Sign answers.
      await sendUnclassifiedObservation(payload, toolName, rawInput, config, requestTimeoutMs);
      return localDeny(
        {
          errorCode: SIGIL_TOOL_UNCLASSIFIED,
          message: `Tool ${toolName} is not in the Cowork governed-tool inventory (version ${COWORK_GOVERNED_TOOLS.inventoryVersion}). Fail-closed controls deny capabilities they have never seen.`,
        },
        toolName.toLowerCase(),
        toolName,
        'unclassified',
      );
    }

    const { toolClass, action } = classified;
    const projection = projectArguments(toolClass, toolName, rawInput);
    if (!projection.ok) {
      return localDeny(
        { errorCode: projection.errorCode, message: projection.message },
        action,
        toolName,
        'governed',
      );
    }
    const projectionDigest = policyProjectionDigest(projection.args);
    const executionDigest = executionBindingDigest(rawInput);
    if (!projectionDigest.ok || !executionDigest.ok) {
      const message = !projectionDigest.ok
        ? projectionDigest.message
        : (executionDigest as { ok: false; message: string }).message;
      return localDeny(
        { errorCode: SIGIL_INPUT_MALFORMED, message },
        action,
        toolName,
        'governed',
      );
    }

    const intent = buildCoworkIntent(
      action,
      projection.args,
      payload,
      toolName,
      coworkCoverage(toolClass),
      projectionDigest.digest,
      executionDigest.digest,
    );

    let result: SigilHookResult;
    try {
      result = await checkIntent(intent, {
        ...config,
        framework: 'cowork',
        taskId: resolveTaskIdFromPayload(payload, config),
        failMode: 'closed',
        requestTimeoutMs,
        strictResponse: true,
        signal: config.signal,
      });
    } catch (error: unknown) {
      result = {
        decision: 'DENIED',
        errorCode: SIGIL_UNREACHABLE,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // Belt: failMode is forced closed, so an APPROVED carrying failOpen can
    // never legitimately occur; treat it as a protocol violation.
    if (result.decision === 'APPROVED' && result.failOpen === true) {
      result = {
        decision: 'DENIED',
        errorCode: SIGIL_RESPONSE_INVALID,
        message: 'Protocol violation: APPROVED with failOpen under forced fail-closed mode.',
      };
    }

    emit({
      decision: result.decision,
      errorCode: result.errorCode,
      holdId: result.holdId,
      policyHash: result.policyHash,
      taskId: result.taskId,
      toolName,
      classification: 'governed',
      latencyMs: Date.now() - startedAt,
      reachability: reachabilityFor(result),
    });

    if (result.decision === 'APPROVED') return undefined;
    return denyResult(result, intent.action);
  };
}

/**
 * Sends the unclassified-tool observation to Sign (empty projection, digest
 * over the raw input) and ignores the answer. Failures are irrelevant: the
 * caller denies with SIGIL_TOOL_UNCLASSIFIED either way.
 */
async function sendUnclassifiedObservation(
  payload: CoworkPreToolUsePayload,
  toolName: string,
  rawInput: Record<string, unknown>,
  config: SigilHookConfig,
  requestTimeoutMs: number,
): Promise<void> {
  const projectionDigest = policyProjectionDigest({});
  const executionDigest = executionBindingDigest(rawInput);
  if (!projectionDigest.ok || !executionDigest.ok) return;
  const intent = buildCoworkIntent(
    toolName.toLowerCase(),
    {},
    payload,
    toolName,
    coworkCoverage('unclassified'),
    projectionDigest.digest,
    executionDigest.digest,
  );
  try {
    await checkIntent(intent, {
      ...config,
      framework: 'cowork',
      taskId: resolveTaskIdFromPayload(payload, config),
      failMode: 'closed',
      requestTimeoutMs,
      strictResponse: true,
      signal: config.signal,
    });
  } catch {
    // Observation only; the deny is already decided.
  }
}

function buildCoworkIntent(
  action: string,
  args: Record<string, unknown>,
  payload: CoworkPreToolUsePayload,
  toolName: string,
  coverage: string,
  projectionDigest: string,
  executionDigest: string,
): SigilIntent {
  const cowork: Record<string, unknown> = { toolName };
  if (typeof payload.tool_use_id === 'string') cowork['toolUseId'] = payload.tool_use_id;
  if (typeof payload.agent_id === 'string') cowork['agentId'] = payload.agent_id;
  if (typeof payload.agent_type === 'string') cowork['agentType'] = payload.agent_type;
  if (typeof payload.permission_mode === 'string') {
    cowork['permissionMode'] = payload.permission_mode;
  }
  if (typeof payload.cwd === 'string') cowork['cwd'] = payload.cwd;
  cowork['coverage'] = coverage;
  cowork['inventoryVersion'] = COWORK_GOVERNED_TOOLS.inventoryVersion;
  cowork['policyProjectionDigest'] = projectionDigest;
  cowork['executionBindingDigest'] = executionDigest;
  // The metadata envelope carries ONLY the cowork key; the raw tool input is
  // never spread into metadata (that was the mechanism by which file contents
  // and agent prompts would have reached Sign).
  const intent = intentFromToolInput(action, args, { cowork });
  intent.arguments = args;
  return intent;
}

type ParsedCoworkPayload =
  | { payload: CoworkPreToolUsePayload }
  | { denial: LocalDenial };

function parseCoworkPayload(
  rawPayload: CoworkPreToolUsePayload | string | Uint8Array,
): ParsedCoworkPayload {
  if (typeof rawPayload === 'string' || rawPayload instanceof Uint8Array) {
    const parsed = readStrictJson(rawPayload, {
      maxBytes: MAX_PAYLOAD_BYTES,
      maxDepth: PAYLOAD_MAX_DEPTH,
    });
    if (!parsed.ok) {
      return {
        denial: {
          errorCode: mapStrictJsonError(parsed.error, 'stdin'),
          message: `Cowork PreToolUse payload rejected: ${parsed.message}`,
        },
      };
    }
    return { payload: parsed.value as CoworkPreToolUsePayload };
  }
  if (!isObject(rawPayload)) {
    return {
      denial: {
        errorCode: SIGIL_INPUT_MALFORMED,
        message: 'Cowork PreToolUse payload must be an object.',
      },
    };
  }
  return { payload: rawPayload };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function denyResult(
  result: SigilHookResult,
  action: string,
): CoworkPreToolUseDenyResult {
  const rejection = buildRejectionContext(result, action);
  let reason = `${rejection.sigil_error_code}: ${rejection.sigil_message} ${rejection.sigil_next_steps}`;
  if (rejection.sigil_hold_id !== undefined) {
    reason += ` (hold_id: ${rejection.sigil_hold_id})`;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
