// tests/adapters/cowork.test.ts
//
// Phase C unit matrix for the Cowork adapter (implementation plan section 7).
// Response-validation cases are driven through the real checkIntent transport
// with byte-level fixtures (global fetch stubbed at the network boundary), so
// the tests prove the shipped path rather than a parallel validator.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  COWORK_GOVERNED_TOOLS,
  COWORK_TOOL_MANIFEST,
  canonicalize,
  clampCoworkTimeout,
  classifyCoworkTool,
  createCoworkPreToolUseHook,
  executionBindingDigest,
  policyProjectionDigest,
  projectArguments,
  type CoworkPreToolUsePayload,
  type CoworkPreToolUseResult,
} from '../../src/adapters/cowork.js';
import { createCoworkPreToolUseHook as exportedCoworkHook } from '../../src/index.js';
import {
  SIGIL_INPUT_DUPLICATE_KEY,
  SIGIL_INPUT_ENCODING,
  SIGIL_INPUT_MALFORMED,
  SIGIL_INPUT_OVERSIZE,
  SIGIL_INPUT_TOO_LARGE,
  SIGIL_RATE_LIMITED,
  SIGIL_RESPONSE_INVALID,
  SIGIL_TOOL_UNCLASSIFIED,
  SIGIL_UNREACHABLE,
} from '../../src/types.js';
import type { SigilDiagnostic, SigilHookConfig } from '../../src/types.js';

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  apiUrl: 'https://sign.test.sigilcore.com',
};

const PENDING_NEXT =
  'This action has been paused for human review. Do not retry. ' +
  'Notify the operator via Sigil Command.';

const defaultNext = (action: string): string =>
  `The action "${action}" was blocked. ` +
  'Do not attempt to reframe or retry this action. ' +
  'Report the violation to the operator.';

const denyObject = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
});

const approvedResponse = () =>
  new Response(JSON.stringify({ status: 'APPROVED' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

interface CapturedBody {
  framework: string;
  intent: {
    action: string;
    arguments?: Record<string, unknown>;
    command?: string;
    url?: string;
    method?: string;
    task_id?: string;
    metadata: Record<string, unknown>;
  };
}

function requestBodyAt(index: number): CapturedBody {
  const call = vi.mocked(fetch).mock.calls[index];
  if (!call) throw new Error(`Missing fetch call at index ${index}`);
  return JSON.parse((call[1] as RequestInit).body as string) as CapturedBody;
}

function coworkMetadata(body: CapturedBody): Record<string, unknown> {
  return body.intent.metadata['cowork'] as Record<string, unknown>;
}

const errorCodeOf = (result: CoworkPreToolUseResult): string | undefined =>
  result?.hookSpecificOutput.permissionDecisionReason.split(':')[0];

describe('createCoworkPreToolUseHook', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('decisions', () => {
    it('returns undefined for a schema-valid APPROVED', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        session_id: 'session-1',
      });
      expect(result).toBeUndefined();
    });

    it('returns exactly the deny object for DENIED', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'DENIED',
            error_code: 'SIGIL_BASH_BLOCKED',
            message: 'blocked',
          }),
          { status: 200 },
        ),
      );
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      expect(result).toEqual(
        denyObject(`SIGIL_BASH_BLOCKED: blocked ${defaultNext('bash')}`),
      );
    });

    it('returns the deny shape for PENDING with the hold id in the reason', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'PENDING',
            hold_id: 'hold_123',
            message: 'approval required',
          }),
          { status: 200 },
        ),
      );
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      });
      expect(result).toEqual(
        denyObject(
          `SIGIL_CONSENSUS_HOLD_REQUIRED: approval required ${PENDING_NEXT} (hold_id: hold_123)`,
        ),
      );
      expect(result?.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result?.hookSpecificOutput.permissionDecisionReason).toContain('hold_123');
    });

    it('never yields ask or defer: literal type, runtime, and source scan', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'PENDING', hold_id: 'hold_9' }), { status: 200 }),
      );
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'x' } });
      expect(result?.hookSpecificOutput.permissionDecision).toBe('deny');
      expectTypeOf(
        result!.hookSpecificOutput.permissionDecision,
      ).toEqualTypeOf<'deny'>();

      const source = readFileSync(
        resolve(process.cwd(), 'src/adapters/cowork.ts'),
        'utf8',
      );
      const decisionLiterals = [
        ...source.matchAll(/permissionDecision(?:['"]?\s*[:=]\s*)['"]([^'"]+)['"]/g),
      ].map((match) => match[1]);
      expect(decisionLiterals.length).toBeGreaterThan(0);
      for (const literal of decisionLiterals) {
        expect(literal).toBe('deny');
      }
      expect(source).not.toMatch(/permissionDecision['"]?\s*[:=]\s*['"](ask|defer)['"]/);
    });

    it('forces fail-closed even when configured fail-open', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
      const hook = createCoworkPreToolUseHook({ ...BASE_CONFIG, failMode: 'open' });
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'x' } });
      expect(errorCodeOf(result)).toBe(SIGIL_UNREACHABLE);
    });

    it('forces framework: cowork over a caller-supplied framework', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook({ ...BASE_CONFIG, framework: 'codex' });
      await hook({ tool_name: 'Bash', tool_input: { command: 'x' } });
      expect(requestBodyAt(0).framework).toBe('cowork');
    });

    it('forces strictResponse even when configured off', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }));
      const hook = createCoworkPreToolUseHook({ ...BASE_CONFIG, strictResponse: false });
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'x' } });
      expect(errorCodeOf(result)).toBe(SIGIL_RESPONSE_INVALID);
    });

    it('binds task_id to the Cowork session id', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        tool_name: 'Bash',
        tool_input: { command: 'x' },
        session_id: 'session-42',
      });
      expect(requestBodyAt(0).intent.task_id).toBe('session-42');
    });
  });

  describe('timeout clamp', () => {
    it.each([
      [Infinity],
      [Number.NaN],
      [0],
      [-1],
      [60000],
      ['2500'],
      [250.5],
      [1000.5],
      [2499.5],
    ])('substitutes 2500 for invalid value %s with one diagnostic', (value) => {
      const warn = vi.mocked(console.warn);
      warn.mockClear();
      expect(clampCoworkTimeout(value)).toBe(2500);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('sigil_cowork_timeout_substituted');
    });

    it.each([[250], [1000], [2500]])('accepts %d verbatim with no diagnostic', (value) => {
      const warn = vi.mocked(console.warn);
      warn.mockClear();
      expect(clampCoworkTimeout(value)).toBe(value);
      expect(warn).not.toHaveBeenCalled();
    });

    it('defaults an absent value to 2500 silently', () => {
      const warn = vi.mocked(console.warn);
      warn.mockClear();
      expect(clampCoworkTimeout(undefined)).toBe(2500);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('strict JSON on the request side', () => {
    it.each([
      ['inside tool_input', '{"tool_name":"Bash","tool_input":{"command":"safe","command":"unsafe"}}'],
      ['before tool_input', '{"session_id":"a","session_id":"b","tool_name":"Bash","tool_input":{"command":"x"}}'],
      ['after tool_input', '{"tool_name":"Bash","tool_input":{"command":"x"},"cwd":"/a","cwd":"/b"}'],
      ['nested MCP arguments', '{"tool_name":"mcp__srv__tool","tool_input":{"arguments":{"p":"a","p":"b"}}}'],
    ])('denies duplicate keys on raw bytes (%s) without calling Sign', async (_label, raw) => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook(new TextEncoder().encode(raw));
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_DUPLICATE_KEY);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('denies invalid UTF-8 payload bytes with SIGIL_INPUT_ENCODING', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook(new Uint8Array([0x7b, 0xff, 0x7d]));
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_ENCODING);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('denies an over-cap payload with SIGIL_INPUT_TOO_LARGE', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const huge = `{"tool_name":"Bash","tool_input":{"command":"${'a'.repeat(1024 * 1024 + 16)}"}}`;
      const result = await hook(huge);
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_TOO_LARGE);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('denies malformed JSON and non-object payloads with SIGIL_INPUT_MALFORMED', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      expect(errorCodeOf(await hook('{"tool_name":"Bash","tool_input":'))).toBe(
        SIGIL_INPUT_MALFORMED,
      );
      expect(errorCodeOf(await hook('[1,2,3]'))).toBe(SIGIL_INPUT_MALFORMED);
      expect(
        errorCodeOf(await hook({ tool_input: { command: 'x' } } as unknown as CoworkPreToolUsePayload)),
      ).toBe(SIGIL_INPUT_MALFORMED);
      expect(
        errorCodeOf(
          await hook({ tool_name: 'Bash', tool_input: 'x' } as unknown as CoworkPreToolUsePayload),
        ),
      ).toBe(SIGIL_INPUT_MALFORMED);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('abort propagation', () => {
    it('forwards the signal into fetch and denies when aborted mid-flight', async () => {
      let capturedSignal: AbortSignal | undefined;
      vi.mocked(fetch).mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolvePromise, rejectPromise) => {
            capturedSignal = (init as RequestInit).signal as AbortSignal;
            capturedSignal.addEventListener('abort', () =>
              rejectPromise(new DOMException('The operation was aborted', 'AbortError')),
            );
          }),
      );
      const controller = new AbortController();
      const hook = createCoworkPreToolUseHook({ ...BASE_CONFIG, signal: controller.signal });
      const pending = hook({ tool_name: 'Bash', tool_input: { command: 'x' } });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
      controller.abort();
      const result = await pending;
      expect(capturedSignal?.aborted).toBe(true);
      expect(errorCodeOf(result)).toBe(SIGIL_UNREACHABLE);
    });
  });

  describe('tool classification', () => {
    it('excluded tools return undefined with zero fetch calls', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      expect(await hook({ tool_name: 'AskUserQuestion', tool_input: {} })).toBeUndefined();
      expect(await hook({ tool_name: 'ExitPlanMode', tool_input: {} })).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('unclassified tools deny SIGIL_TOOL_UNCLASSIFIED naming the tool, without suppressing the request', async () => {
      vi.mocked(fetch).mockResolvedValue(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({ tool_name: 'CustomTool', tool_input: { x: 1 } });
      expect(errorCodeOf(result)).toBe(SIGIL_TOOL_UNCLASSIFIED);
      expect(result?.hookSpecificOutput.permissionDecisionReason).toContain('CustomTool');
      // The observation request reaches Sign so the coverage-gap alert can fire,
      // and a Sign approval of it changes nothing.
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('unclassified tools deny even when the observation request fails', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('down'));
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({ tool_name: 'NotBashTool', tool_input: {} });
      expect(errorCodeOf(result)).toBe(SIGIL_TOOL_UNCLASSIFIED);
    });

    it('classifies opaque per-tool names by tool_input shape (Phase A capture)', () => {
      expect(classifyCoworkTool('mcp__c44359886c49', { command: 'ls' })).toEqual({
        classification: 'governed',
        toolClass: 'Bash',
        action: 'bash',
      });
      expect(classifyCoworkTool('mcp__4ded42abd557', { url: 'https://example.com' })).toEqual({
        classification: 'governed',
        toolClass: 'WebFetch',
        action: 'web_fetch',
      });
      expect(classifyCoworkTool('mcp__17e0eb723ca9', { path: '/tmp/a' })).toEqual({
        classification: 'governed',
        toolClass: 'mcp',
        action: 'mcp__17e0eb723ca9',
      });
    });

    it('rejects adversarial names that are not exact inventory or anchored mcp matches', () => {
      const adversarial = [
        'bash',
        'BASH',
        'Bashful',
        'xBash',
        'Ba.h',
        'Bash\n',
        'Ваsh',
        'mcp__a',
        '',
        'a'.repeat(4096),
        'mcp__C44359886C49',
        'mcp__c44359886c4',
        // Prototype-chain names must not classify as governed with a bare
        // bracket lookup; they fall to unclassified (MAJOR 1 regression).
        '__proto__',
        'constructor',
        'toString',
        'hasOwnProperty',
        'valueOf',
      ];
      for (const name of adversarial) {
        expect(classifyCoworkTool(name, {}).classification).toBe('unclassified');
      }
      // mcp__a__b__c matches the anchored two-segment pattern (underscores are
      // legal inside a segment) and is governed MCP passthrough, matching the
      // recorded Codex behavior for literal mcp names.
      expect(classifyCoworkTool('mcp__a__b__c', {})).toEqual({
        classification: 'governed',
        toolClass: 'mcp',
        action: 'mcp__a__b__c',
      });
    });

    it('opaque names shape-classify to Bash/WebFetch only when the key set is a subset (MAJOR 2)', () => {
      // Exact real shapes classify as the built-in class.
      expect(classifyCoworkTool('mcp__c44359886c49', { command: 'ls' }).classification).toBe(
        'governed',
      );
      expect(classifyCoworkTool('mcp__c44359886c49', { command: 'ls' })).toMatchObject({
        toolClass: 'Bash',
      });
      expect(classifyCoworkTool('mcp__4ded42abd557', { url: 'https://x', method: 'GET' })).toMatchObject({
        toolClass: 'WebFetch',
      });
      // A smuggled extra key falls through to generic MCP passthrough, NOT Bash,
      // so a prompt-injected agent cannot reroute an opaque MCP tool into the
      // bash policy class and drop the real `path`.
      expect(classifyCoworkTool('mcp__c44359886c49', { command: 'x', path: '/etc/passwd' })).toEqual({
        classification: 'governed',
        toolClass: 'mcp',
        action: 'mcp__c44359886c49',
      });
      expect(classifyCoworkTool('mcp__4ded42abd557', { url: 'https://x', extra: 1 })).toEqual({
        classification: 'governed',
        toolClass: 'mcp',
        action: 'mcp__4ded42abd557',
      });
    });

    it('a mixed opaque {command, path} payload projects as generic MCP, transmitting all key names', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        tool_name: 'mcp__c44359886c49',
        tool_input: { command: 'x', path: '/etc/passwd' },
      });
      const body = requestBodyAt(0);
      expect(body.intent.action).toBe('mcp__c44359886c49');
      expect(body.intent.arguments).toEqual({
        server: 'mcp__c44359886c49',
        tool: 'mcp__c44359886c49',
        argument_keys: ['command', 'path'],
      });
    });

    it('a prototype-chain tool name denies with SIGIL_TOOL_UNCLASSIFIED, never throwing (MAJOR 1)', async () => {
      vi.mocked(fetch).mockResolvedValue(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const result = await hook({ tool_name: name, tool_input: {} });
        expect(errorCodeOf(result)).toBe(SIGIL_TOOL_UNCLASSIFIED);
      }
    });

    it('effective classified set deep-equals COWORK_GOVERNED_TOOLS at the current inventoryVersion', () => {
      expect(COWORK_GOVERNED_TOOLS.inventoryVersion).toBe(1);
      const effective: Record<string, string> = {};
      for (const name of Object.keys(COWORK_GOVERNED_TOOLS.tools)) {
        effective[name] = classifyCoworkTool(name, {}).classification;
      }
      const declared = Object.fromEntries(
        Object.entries(COWORK_GOVERNED_TOOLS.tools).map(([name, entry]) => [
          name,
          entry.classification,
        ]),
      );
      expect(effective).toEqual(declared);
    });
  });

  describe('action mapping', () => {
    it.each([
      ['Bash', { command: 'ls' }, 'bash'],
      ['Edit', { file_path: '/a' }, 'file_write'],
      ['Write', { file_path: '/a' }, 'file_write'],
      ['Read', { file_path: '/a' }, 'file_read'],
      ['Glob', { pattern: '*.ts' }, 'file_read'],
      ['Grep', { pattern: 'x' }, 'file_read'],
      ['Agent', { subagent_type: 'general' }, 'agent_spawn'],
      ['WebFetch', { url: 'https://example.com' }, 'web_fetch'],
      ['WebSearch', { query: 'q' }, 'web_fetch'],
      ['mcp__filesystem__read_file', { path: '/a' }, 'mcp__filesystem__read_file'],
      ['mcp__c44359886c49', { command: 'ls -la' }, 'bash'],
      ['mcp__4ded42abd557', { url: 'https://example.com' }, 'web_fetch'],
      ['mcp__17e0eb723ca9', { path: '/tmp/a' }, 'mcp__17e0eb723ca9'],
    ])('%s maps to %s on the wire', async (toolName, toolInput, _expected) => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({ tool_name: toolName as string, tool_input: toolInput as Record<string, unknown> });
      expect(requestBodyAt(0).intent.action).toBe(_expected);
    });

    it('promotes WebFetch to http when an explicit method is present', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        tool_name: 'WebFetch',
        tool_input: { url: 'https://example.com', method: 'POST' },
      });
      const body = requestBodyAt(0);
      expect(body.intent.action).toBe('http');
      expect(body.intent.method).toBe('POST');
    });
  });

  describe('argument projection', () => {
    const projectionCases: Array<{
      toolName: string;
      toolInput: Record<string, unknown>;
      keys: string[];
      canary?: string;
    }> = [
      { toolName: 'Bash', toolInput: { command: 'ls -la' }, keys: ['command'] },
      {
        toolName: 'Write',
        toolInput: { file_path: '/a.txt', content: 'SIGIL_LEAK_CANARY_WRITE' },
        keys: ['file_path'],
        canary: 'SIGIL_LEAK_CANARY_WRITE',
      },
      {
        toolName: 'Edit',
        toolInput: {
          file_path: '/a.txt',
          old_string: 'SIGIL_LEAK_CANARY_OLD',
          new_string: 'SIGIL_LEAK_CANARY_NEW',
          replace_all: true,
        },
        keys: ['file_path'],
        canary: 'SIGIL_LEAK_CANARY_OLD',
      },
      {
        toolName: 'Read',
        toolInput: { file_path: '/a.txt', offset: 1, limit: 10 },
        keys: ['file_path'],
      },
      {
        toolName: 'Glob',
        toolInput: { pattern: '**/*.ts', path: '/repo' },
        keys: ['pattern', 'path'],
      },
      {
        toolName: 'Grep',
        toolInput: { pattern: 'x', path: '/repo', glob: '*.ts', output_mode: 'content', '-A': 3 },
        keys: ['pattern', 'path', 'glob'],
      },
      {
        toolName: 'WebFetch',
        toolInput: { url: 'https://example.com/x', prompt: 'SIGIL_LEAK_CANARY_PROMPT' },
        keys: ['url'],
        canary: 'SIGIL_LEAK_CANARY_PROMPT',
      },
      { toolName: 'WebSearch', toolInput: { query: 'governance' }, keys: ['query'] },
      {
        toolName: 'Agent',
        toolInput: {
          subagent_type: 'general',
          description: 'Run checks',
          prompt: 'SIGIL_LEAK_CANARY_AGENT',
        },
        keys: ['subagent_type', 'description'],
        canary: 'SIGIL_LEAK_CANARY_AGENT',
      },
      {
        toolName: 'mcp__filesystem__read_file',
        toolInput: { path: '/etc/passwd', mode: 'SIGIL_LEAK_CANARY_MCP' },
        keys: ['server', 'tool', 'argument_keys'],
        canary: 'SIGIL_LEAK_CANARY_MCP',
      },
    ];

    it.each(projectionCases)(
      '$toolName sends exactly its declared field set and never a withheld value',
      async ({ toolName, toolInput, keys, canary }) => {
        vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
        const hook = createCoworkPreToolUseHook(BASE_CONFIG);
        await hook({ tool_name: toolName, tool_input: toolInput });
        const call = vi.mocked(fetch).mock.calls[0];
        const rawBody = (call?.[1] as RequestInit).body as string;
        const body = JSON.parse(rawBody) as CapturedBody;
        expect(Object.keys(body.intent.arguments ?? {})).toEqual(keys);
        if (canary !== undefined) {
          expect(rawBody).not.toContain(canary);
        }
      },
    );

    it('sends MCP argument key names, sorted, and never argument values', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        tool_name: 'mcp__filesystem__read_file',
        tool_input: { zeta: 'secret-value-1', alpha: 'secret-value-2' },
      });
      const body = requestBodyAt(0);
      expect(body.intent.arguments).toEqual({
        server: 'mcp__filesystem',
        tool: 'read_file',
        argument_keys: ['alpha', 'zeta'],
      });
    });

    it('strips userinfo from web fetch URLs without other normalization', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        tool_name: 'WebFetch',
        tool_input: { url: 'https://user:pass@example.com/x?q=1' },
      });
      const call = vi.mocked(fetch).mock.calls[0];
      const rawBody = (call?.[1] as RequestInit).body as string;
      const body = JSON.parse(rawBody) as CapturedBody;
      expect((body.intent.arguments as Record<string, unknown>)['url']).toBe(
        'https://example.com/x?q=1',
      );
      expect(rawBody).not.toContain('user:pass');
    });

    it('metadata carries only the cowork envelope with the declared key set', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        session_id: 'session-1',
        transcript_path: '/fixture/transcript.jsonl',
        cwd: '/repo',
        prompt_id: 'prompt-1',
        permission_mode: 'default',
        effort: { level: 'medium' },
        hook_event_name: 'PreToolUse',
        tool_name: 'Glob',
        tool_input: { pattern: '*.ts', path: '/repo' },
        tool_use_id: 'toolu_1',
        agent_id: 'agent-7',
        agent_type: 'explore',
      });
      const body = requestBodyAt(0);
      expect(Object.keys(body.intent.metadata)).toEqual(['cowork']);
      expect(Object.keys(coworkMetadata(body))).toEqual([
        'toolName',
        'toolUseId',
        'agentId',
        'agentType',
        'permissionMode',
        'cwd',
        'coverage',
        'inventoryVersion',
        'policyProjectionDigest',
        'executionBindingDigest',
      ]);
      expect(coworkMetadata(body)['inventoryVersion']).toBe(
        COWORK_GOVERNED_TOOLS.inventoryVersion,
      );
    });

    it('omits agentId and agentType on a parent (non-subagent) call', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({
        session_id: 'session-1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu_2',
        permission_mode: 'default',
        cwd: '/repo',
      });
      const keys = Object.keys(coworkMetadata(requestBodyAt(0)));
      expect(keys).not.toContain('agentId');
      expect(keys).not.toContain('agentType');
    });
  });

  // MAJOR 3: confinement stated as "the sensitive value appears in exactly its
  // declared positions and nowhere else". The top-level intent.command /
  // intent.url duplicates are DELIBERATE — Sign's Lex evaluates intent.command
  // today — so this documents them as declared positions rather than removing
  // them and breaking live policy evaluation.
  describe('sensitive-value confinement to declared positions', () => {
    it('a bash token appears in intent.arguments.command and intent.command, and nowhere else', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const diagnostics: SigilDiagnostic[] = [];
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: (d) => diagnostics.push(d),
      });
      const token = 'TOKEN_sk_live_confine_bash';
      await hook({
        tool_name: 'Bash',
        tool_input: { command: `curl -H 'Authorization: ${token}' https://x` },
        session_id: 's1',
      });
      const call = vi.mocked(fetch).mock.calls[0];
      const rawBody = (call?.[1] as RequestInit).body as string;
      const body = JSON.parse(rawBody) as CapturedBody & {
        intent: { command?: string };
      };
      // Two declared positions carry the value.
      expect((body.intent.arguments as Record<string, unknown>)['command']).toContain(token);
      expect(body.intent.command).toContain(token);
      // Absent everywhere else: metadata, the deny reason (none here; approval),
      // and the diagnostic payload.
      expect(JSON.stringify(body.intent.metadata)).not.toContain(token);
      expect(JSON.stringify(diagnostics)).not.toContain(token);
    });

    it('a web_fetch url appears in intent.arguments.url and intent.url, and nowhere else', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const diagnostics: SigilDiagnostic[] = [];
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: (d) => diagnostics.push(d),
      });
      const marker = 'confine-marker-9f3';
      await hook({
        tool_name: 'WebFetch',
        tool_input: { url: `https://example.com/${marker}` },
      });
      const call = vi.mocked(fetch).mock.calls[0];
      const rawBody = (call?.[1] as RequestInit).body as string;
      const body = JSON.parse(rawBody) as CapturedBody & { intent: { url?: string } };
      expect((body.intent.arguments as Record<string, unknown>)['url']).toContain(marker);
      expect(body.intent.url).toContain(marker);
      expect(JSON.stringify(body.intent.metadata)).not.toContain(marker);
      expect(JSON.stringify(diagnostics)).not.toContain(marker);
    });

    it('a denied bash token appears in neither the deny reason nor the diagnostic', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 'DENIED', error_code: 'SIGIL_BASH_BLOCKED', message: 'no' }),
          { status: 200 },
        ),
      );
      const diagnostics: SigilDiagnostic[] = [];
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: (d) => diagnostics.push(d),
      });
      const token = 'TOKEN_denied_confine';
      const result = await hook({
        tool_name: 'Bash',
        tool_input: { command: `echo ${token}` },
      });
      expect(result?.hookSpecificOutput.permissionDecisionReason).not.toContain(token);
      expect(JSON.stringify(diagnostics)).not.toContain(token);
    });
  });

  describe('oversize denies, never truncates', () => {
    it('denies a 4097-byte command with no request sent', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        tool_name: 'Bash',
        tool_input: { command: 'a'.repeat(4097) },
      });
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_OVERSIZE);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('denies a 1025-byte file_path with no request sent', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        tool_name: 'Write',
        tool_input: { file_path: `/${'b'.repeat(1024)}` },
      });
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_OVERSIZE);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('caps are UTF-8 bytes: 4096 UTF-16 code units of combining sequences deny', async () => {
      // 2048 x 'e'+combining-acute = 4096 UTF-16 code units but 6144 UTF-8
      // bytes, so a code-unit implementation passes what this must reject.
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const command = 'e\u0301'.repeat(2048);
      expect(command.length).toBe(4096);
      const result = await hook({ tool_name: 'Bash', tool_input: { command } });
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_OVERSIZE);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('accepts a command at exactly 4096 UTF-8 bytes', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const command = `${'€'.repeat(1365)}a`; // 1365*3 + 1 = 4096 bytes
      expect(Buffer.byteLength(command, 'utf8')).toBe(4096);
      const result = await hook({ tool_name: 'Bash', tool_input: { command } });
      expect(result).toBeUndefined();
    });
  });

  describe('digests', () => {
    async function digestsFor(
      toolName: string,
      toolInput: Record<string, unknown>,
    ): Promise<{ projection: string; execution: string }> {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({ tool_name: toolName, tool_input: toolInput });
      const metadata = coworkMetadata(
        requestBodyAt(vi.mocked(fetch).mock.calls.length - 1),
      );
      return {
        projection: metadata['policyProjectionDigest'] as string,
        execution: metadata['executionBindingDigest'] as string,
      };
    }

    it.each([
      ['Write', { file_path: '/a' }, { file_path: '/a', content: 'X' }, { file_path: '/a', content: 'Y' }],
      ['Edit', { file_path: '/a' }, { file_path: '/a', old_string: 'X' }, { file_path: '/a', old_string: 'Y' }],
      ['Agent', { subagent_type: 's' }, { subagent_type: 's', prompt: 'X' }, { subagent_type: 's', prompt: 'Y' }],
      [
        'mcp__srv__tool',
        {},
        { arg: 'X' },
        { arg: 'Y' },
      ],
    ])(
      '%s: executionBindingDigest moves with withheld fields while policyProjectionDigest holds',
      async (toolName, _base, variantA, variantB) => {
        const a = await digestsFor(toolName as string, variantA as Record<string, unknown>);
        const b = await digestsFor(toolName as string, variantB as Record<string, unknown>);
        expect(a.projection).toBe(b.projection);
        expect(a.execution).not.toBe(b.execution);
        expect(a.projection).toMatch(/^[0-9a-f]{64}$/);
        expect(a.execution).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    it('denies with SIGIL_INPUT_MALFORMED when the raw input cannot canonicalize', async () => {
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({
        tool_name: 'Read',
        tool_input: { file_path: '/a', limit: 1.5 },
      });
      expect(errorCodeOf(result)).toBe(SIGIL_INPUT_MALFORMED);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('response validation through the shipped transport', () => {
    interface ResponseCase {
      name: string;
      makeResponse: () => Response;
      expectedCode?: string;
    }

    const cases: ResponseCase[] = [
      {
        name: 'schema-valid APPROVED',
        makeResponse: () => new Response('{"status":"APPROVED"}', { status: 200 }),
      },
      {
        name: 'malformed JSON',
        makeResponse: () => new Response('not json', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'missing status',
        makeResponse: () => new Response('{"ok":true}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'unknown status',
        makeResponse: () => new Response('{"status":"MAYBE"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'wrong field type on APPROVED',
        makeResponse: () =>
          new Response('{"status":"APPROVED","policy_hash":42}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'duplicate status keys, DENIED first',
        makeResponse: () =>
          new Response('{"status":"DENIED","status":"APPROVED"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'duplicate status keys, APPROVED first',
        makeResponse: () =>
          new Response('{"status":"APPROVED","status":"DENIED"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'truncated body',
        makeResponse: () => new Response('{"status":"APPRO', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'body over the 64 KiB cap',
        makeResponse: () =>
          new Response(`{"status":"APPROVED","pad":"${'x'.repeat(66000)}"}`, { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'HTML interstitial with status 200',
        makeResponse: () =>
          new Response('<html><body>Please sign in</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '204 no content',
        makeResponse: () => new Response(null, { status: 204 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '206 partial content',
        makeResponse: () => new Response('{"status":"APPROVED"}', { status: 206 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '301 redirect',
        makeResponse: () => new Response('', { status: 301 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '400 bad request',
        makeResponse: () => new Response('{"error":"bad"}', { status: 400 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '408 request timeout',
        makeResponse: () => new Response('', { status: 408 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '409 conflict',
        makeResponse: () => new Response('', { status: 409 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: '429 rate limited',
        makeResponse: () => new Response('', { status: 429 }),
        expectedCode: SIGIL_RATE_LIMITED,
      },
      {
        name: 'APPROVED with failOpen',
        makeResponse: () =>
          new Response('{"status":"APPROVED","failOpen":true}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'APPROVED with an unknown field',
        makeResponse: () =>
          new Response('{"status":"APPROVED","extra":"x"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'APPROVED with hold_id',
        makeResponse: () =>
          new Response('{"status":"APPROVED","hold_id":"h1"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'APPROVED with error_code',
        makeResponse: () =>
          new Response('{"status":"APPROVED","error_code":"X"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'array body',
        makeResponse: () => new Response('["APPROVED"]', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'scalar body',
        makeResponse: () => new Response('"APPROVED"', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'PENDING without hold_id',
        makeResponse: () => new Response('{"status":"PENDING"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'PENDING with empty hold_id',
        makeResponse: () =>
          new Response('{"status":"PENDING","hold_id":""}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
      {
        name: 'DENIED without error_code',
        makeResponse: () => new Response('{"status":"DENIED"}', { status: 200 }),
        expectedCode: SIGIL_RESPONSE_INVALID,
      },
    ];

    it.each(cases)('$name', async ({ makeResponse, expectedCode }) => {
      vi.mocked(fetch).mockResolvedValueOnce(makeResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      if (expectedCode === undefined) {
        expect(result).toBeUndefined();
      } else {
        expect(errorCodeOf(result)).toBe(expectedCode);
      }
    });

    it('meta-assertion: exactly one response case returns undefined', async () => {
      let undefinedCount = 0;
      for (const responseCase of cases) {
        vi.mocked(fetch).mockResolvedValueOnce(responseCase.makeResponse());
        const hook = createCoworkPreToolUseHook(BASE_CONFIG);
        const result = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
        if (result === undefined) undefinedCount += 1;
      }
      expect(undefinedCount).toBe(1);
    });

    it('maps 401 to SIGIL_AUTH_FAILURE and 500 to SIGIL_UNREACHABLE under forced fail-closed', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 401 }));
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      expect(
        errorCodeOf(await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } })),
      ).toBe('SIGIL_AUTH_FAILURE');

      vi.mocked(fetch).mockResolvedValueOnce(new Response('boom', { status: 500 }));
      expect(
        errorCodeOf(await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } })),
      ).toBe(SIGIL_UNREACHABLE);
    });

    it("sets redirect: 'error' on the strict fetch so a real 3xx fails closed (MINOR 6)", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
      expect(init.redirect).toBe('error');
    });

    it('a rejected fetch from redirect:error denies as SIGIL_UNREACHABLE, not a silent follow', async () => {
      // Emulate what redirect:'error' produces against a real 3xx: fetch rejects.
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('unexpected redirect'));
      const hook = createCoworkPreToolUseHook(BASE_CONFIG);
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(errorCodeOf(result)).toBe(SIGIL_UNREACHABLE);
    });
  });

  describe('diagnostics', () => {
    it('emits structured fields for a governed approval, distinguishable from an excluded skip', async () => {
      const diagnostics: SigilDiagnostic[] = [];
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' });
      await hook({ tool_name: 'AskUserQuestion', tool_input: {} });

      expect(diagnostics).toHaveLength(2);
      const approved = diagnostics[0] as SigilDiagnostic;
      expect(approved.decision).toBe('APPROVED');
      expect(approved.classification).toBe('governed');
      expect(approved.toolName).toBe('Bash');
      expect(typeof approved.latencyMs).toBe('number');
      expect(approved.reachability).toBe('ok');

      const excluded = diagnostics[1] as SigilDiagnostic;
      expect(excluded.decision).toBeUndefined();
      expect(excluded.classification).toBe('excluded');
      expect(excluded.reachability).toBe('not_attempted');
    });

    it('emits denial diagnostics with the error code and hold id', async () => {
      const diagnostics: SigilDiagnostic[] = [];
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'PENDING', hold_id: 'hold_5' }), { status: 200 }),
      );
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(diagnostics[0]?.decision).toBe('PENDING');
      expect(diagnostics[0]?.holdId).toBe('hold_5');
    });

    it('a throwing onDiagnostic never alters the decision', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(approvedResponse());
      const hook = createCoworkPreToolUseHook({
        ...BASE_CONFIG,
        onDiagnostic: () => {
          throw new Error('diagnostic sink failed');
        },
      });
      const result = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
      expect(result).toBeUndefined();
    });
  });

  describe('canonicalization', () => {
    const CANON_DIR = resolve(process.cwd(), 'tests/fixtures/canon');

    it('matches every known-answer fixture byte for byte', () => {
      const files = readdirSync(CANON_DIR).filter((name) => name.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(10);
      for (const file of files) {
        const fixture = JSON.parse(readFileSync(resolve(CANON_DIR, file), 'utf8')) as {
          name: string;
          input: unknown;
          canonicalHex?: string;
          sha256?: string;
          expectError?: boolean;
        };
        const result = canonicalize(fixture.input);
        if (fixture.expectError === true) {
          expect(result.ok, fixture.name).toBe(false);
          continue;
        }
        expect(result.ok, fixture.name).toBe(true);
        if (result.ok) {
          expect(Buffer.from(result.bytes).toString('hex'), fixture.name).toBe(
            fixture.canonicalHex,
          );
          expect(
            createHash('sha256').update(result.bytes).digest('hex'),
            fixture.name,
          ).toBe(fixture.sha256);
        }
      }
    });

    const digestOf = (value: Record<string, unknown>): string => {
      const result = policyProjectionDigest(value);
      if (!result.ok) throw new Error(result.message);
      return result.digest;
    };

    it('is stable under key reordering and NFC equivalence', () => {
      expect(digestOf({ a: 1, b: 'x' })).toBe(digestOf({ b: 'x', a: 1 }));
      expect(digestOf({ 'caf\u00e9': '\u00e9' })).toBe(digestOf({ 'cafe\u0301': 'e\u0301' }));
    });

    it('distinguishes types, null versus absent, and array order', () => {
      expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: '1' }));
      expect(digestOf({ a: true })).not.toBe(digestOf({ a: 'true' }));
      expect(digestOf({ a: null })).not.toBe(digestOf({}));
      expect(digestOf({ a: [1, 2] })).not.toBe(digestOf({ a: [2, 1] }));
    });

    it('rejects NFC key collisions as duplicates', () => {
      const collided = Object.fromEntries([
        ['caf\u00e9', 1],
        ['cafe\u0301', 2],
      ]);
      expect(Object.keys(collided)).toHaveLength(2);
      expect(canonicalize(collided).ok).toBe(false);
    });

    it('rejects every prohibited numeric form and unsupported type', () => {
      expect(canonicalize({ a: 1.5 }).ok).toBe(false);
      expect(canonicalize({ a: -0 }).ok).toBe(false);
      expect(canonicalize({ a: Infinity }).ok).toBe(false);
      expect(canonicalize({ a: Number.NaN }).ok).toBe(false);
      expect(canonicalize({ a: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
      expect(canonicalize({ a: undefined }).ok).toBe(false);
      expect(canonicalize({ a: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
      expect(canonicalize({ a: 0 }).ok).toBe(true);
    });

    it('rejects lone surrogates so they cannot collide under UTF-8 (MINOR 5)', () => {
      // '\ud800' and '\ud801' would both map to U+FFFD without this rejection.
      expect(canonicalize({ a: '\ud800' }).ok).toBe(false);
      expect(canonicalize({ a: '\udc00' }).ok).toBe(false);
      expect(canonicalize({ ['\ud800']: 'x' }).ok).toBe(false);
      // A well-formed surrogate pair (an astral character) still serializes.
      expect(canonicalize({ a: '🚀' }).ok).toBe(true);
    });

    it('bounds nesting depth at 32', () => {
      let accepted: unknown = 'leaf';
      for (let i = 0; i < 31; i += 1) accepted = { k: accepted };
      expect(canonicalize(accepted).ok).toBe(true);
      let rejected: unknown = 'leaf';
      for (let i = 0; i < 32; i += 1) rejected = { k: rejected };
      expect(canonicalize(rejected).ok).toBe(false);
    });

    it('an identically-projecting pair separates only on the execution digest', () => {
      const projectionA = projectArguments('Write', 'Write', {
        file_path: '/etc/app.conf',
        content: 'harmless',
      });
      const projectionB = projectArguments('Write', 'Write', {
        file_path: '/etc/app.conf',
        content: 'hostile',
      });
      if (!projectionA.ok || !projectionB.ok) throw new Error('projection failed');
      expect(projectionA.args).toEqual(projectionB.args);
      const executionA = executionBindingDigest({ file_path: '/etc/app.conf', content: 'harmless' });
      const executionB = executionBindingDigest({ file_path: '/etc/app.conf', content: 'hostile' });
      if (!executionA.ok || !executionB.ok) throw new Error('digest failed');
      expect(executionA.digest).not.toBe(executionB.digest);
    });
  });

  describe('manifest and exports', () => {
    it('COWORK_TOOL_MANIFEST is frozen data carrying inventory, action map, and version', () => {
      expect(Object.isFrozen(COWORK_TOOL_MANIFEST)).toBe(true);
      expect(Object.isFrozen(COWORK_TOOL_MANIFEST.inventory)).toBe(true);
      expect(Object.isFrozen(COWORK_TOOL_MANIFEST.actionMap)).toBe(true);
      expect(COWORK_TOOL_MANIFEST.inventoryVersion).toBe(
        COWORK_GOVERNED_TOOLS.inventoryVersion,
      );
      expect(COWORK_TOOL_MANIFEST.actionMap['Read']).toBe('file_read');
      expect(COWORK_TOOL_MANIFEST.actionMap['Agent']).toBe('agent_spawn');
      expect(COWORK_TOOL_MANIFEST.inventory['AskUserQuestion']?.classification).toBe(
        'excluded',
      );
    });

    it('the action map agrees with every governed inventory entry (MINOR 8)', () => {
      for (const [name, entry] of Object.entries(COWORK_TOOL_MANIFEST.inventory)) {
        if (entry.classification === 'governed') {
          expect(
            COWORK_TOOL_MANIFEST.actionMap[name],
            `action map must define ${name}`,
          ).toBe(entry.action);
        } else {
          // Excluded tools carry no action and must not appear in the map.
          expect(Object.hasOwn(COWORK_TOOL_MANIFEST.actionMap, name)).toBe(false);
        }
      }
      // No stray action-map keys beyond the governed inventory.
      for (const name of Object.keys(COWORK_TOOL_MANIFEST.actionMap)) {
        expect(COWORK_TOOL_MANIFEST.inventory[name]?.classification).toBe('governed');
      }
    });

    it('is re-exported from the package index', () => {
      expect(exportedCoworkHook).toBe(createCoworkPreToolUseHook);
    });
  });

  describe('README governed-tool table drift (MINOR 7)', () => {
    it('the README table block is rendered exactly from COWORK_TOOL_MANIFEST', () => {
      const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
      const start = '<!-- COWORK_TOOL_TABLE:START -->';
      const end = '<!-- COWORK_TOOL_TABLE:END -->';
      const startIdx = readme.indexOf(start);
      const endIdx = readme.indexOf(end);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      const block = readme.slice(startIdx + start.length, endIdx).trim();

      const rows = ['| Cowork tool | Classification | Sigil action |', '|---|---|---|'];
      for (const [name, entry] of Object.entries(COWORK_TOOL_MANIFEST.inventory)) {
        const action = entry.classification === 'governed' ? `\`${entry.action}\`` : '—';
        rows.push(`| \`${name}\` | ${entry.classification} | ${action} |`);
      }
      expect(block).toBe(rows.join('\n'));
    });
  });
});
