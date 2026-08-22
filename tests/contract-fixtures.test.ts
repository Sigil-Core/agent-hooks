import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoworkPreToolUseHook } from '../src/adapters/cowork.js';
import { checkIntent } from '../src/interceptor.js';
import type { SigilHookConfig, SigilIntent } from '../src/types.js';

const FIXTURE_ROOT = resolve(process.cwd(), 'tests/contract-fixtures/v1');
const UPSTREAM_PIN_PATH = resolve(
  process.cwd(),
  'tests/UPSTREAM_AGENT_HOOKS_RS_COMMIT',
);

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  agentId: 'fixture-agent',
  taskId: 'fixture-task-1',
  decisionVerificationMode: 'warn',
};

const FIXTURE_REQUEST_NONCE = '00000000-0000-4000-8000-000000000000';

function normalizeRequestNonce(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const requestNonce = parsed['request_nonce'];
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(requestNonce).toMatch(uuidV4);

  const requestNonceLine = /^(\s*"request_nonce":\s*")([0-9a-f-]+)("\s*,?\s*)$/m;
  const rawMatch = requestNonceLine.exec(body);
  expect(rawMatch?.[2]).toBe(requestNonce);
  return body.replace(
    requestNonceLine,
    (_line, prefix: string, _nonce: string, suffix: string) =>
      `${prefix}${FIXTURE_REQUEST_NONCE}${suffix}`,
  );
}

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

async function captureWire(
  run: (apiUrl: string) => Promise<unknown>,
): Promise<string> {
  let capturedBody = '';
  let capturedTarget = '';
  let capturedMethod = '';
  vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
    capturedTarget = String(input);
    capturedMethod = init?.method ?? '';
    capturedBody = String(init?.body ?? '');
    return Promise.resolve(
      new Response('{"status":"APPROVED"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }));
  await run('https://sign.test.sigilcore.com');
  expect(capturedTarget).toBe('https://sign.test.sigilcore.com/v1/authorize');
  expect(capturedMethod).toBe('POST');
  return capturedBody;
}

async function captureWireBody(
  intent: SigilIntent,
  config: SigilHookConfig,
): Promise<string> {
  return await captureWire(async (apiUrl) => {
    await checkIntent(intent, { ...config, apiUrl });
  });
}

/**
 * Canary payload for the Cowork contract fixture. The FIELD SET exactly
 * matches the real captured Bash-class record from the Phase A payload
 * capture of 2026-08-02 (session_id, transcript_path, cwd, prompt_id,
 * permission_mode, effort.level, hook_event_name, tool_name, tool_input
 * .command, tool_use_id; the tool arrives under an opaque per-tool mcp__
 * digest name). Values are deterministic canaries, never real host paths or
 * session ids, per the fixture conventions.
 */
const COWORK_FIXTURE_PAYLOAD = {
  session_id: 'fixture-session-1',
  transcript_path: '/fixture/transcripts/session-1.jsonl',
  cwd: '/fixture/workspace',
  prompt_id: 'fixture-prompt-1',
  permission_mode: 'default',
  effort: { level: 'medium' },
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__aaaaaaaaaaaa',
  tool_input: { command: 'CANARY_COMMAND_01' },
  tool_use_id: 'toolu_fixture_1',
};

async function captureCoworkWireBody(): Promise<string> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2023-11-14T22:13:20Z'));
  return await captureWire(async (apiUrl) => {
    const hook = createCoworkPreToolUseHook({
      apiKey: 'sk_sigil_test_key',
      agentId: 'fixture-agent',
      apiUrl,
      decisionVerificationMode: 'warn',
    });
    await hook(COWORK_FIXTURE_PAYLOAD);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('contract fixtures', () => {
  it('normalizes only the nonce bytes in the captured wire body', () => {
    const captured = [
      '{',
      '  "unchanged": { "spacing": true },',
      '  "request_nonce": "12345678-1234-4abc-8def-123456789abc",',
      '  "tail": "preserved"',
      '}',
      '',
    ].join('\n');

    expect(normalizeRequestNonce(captured)).toBe(
      captured.replace('12345678-1234-4abc-8def-123456789abc', FIXTURE_REQUEST_NONCE),
    );
  });

  it.each([
    ['missing', '{\n  "unchanged": true\n}\n'],
    ['malformed', '{\n  "request_nonce": "not-a-uuid"\n}\n'],
  ])('rejects a %s request_nonce in a captured wire body', (_case, captured) => {
    expect(() => normalizeRequestNonce(captured)).toThrow();
  });

  it('fixture hashes match SHA256SUMS', () => {
    const lines = readFixture('SHA256SUMS')
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const line of lines) {
      const [expected, fileName] = line.split(/\s{2,}/);
      const actual = createHash('sha256')
        .update(readFixture(fileName))
        .digest('hex');
      expect(actual).toBe(expected);
    }
  });

  it('bash fixture matches the actual HTTP wire body', async () => {
    const actual = await captureWireBody(
      {
        action: 'bash',
        command: 'ls -la',
        txCommit: '1111111111111111111111111111111111111111111111111111111111111111',
      },
      BASE_CONFIG,
    );

    expect(normalizeRequestNonce(actual)).toBe(readFixture('bash.json'));
  });

  it('web_fetch fixture matches the actual HTTP wire body', async () => {
    const actual = await captureWireBody(
      {
        action: 'web_fetch',
        url: 'https://example.com/policy',
        txCommit: '2222222222222222222222222222222222222222222222222222222222222222',
      },
      BASE_CONFIG,
    );

    expect(normalizeRequestNonce(actual)).toBe(readFixture('web_fetch.json'));
  });

  it('wallet.transfer fixture matches the actual HTTP wire body', async () => {
    const actual = await captureWireBody(
      {
        action: 'wallet.transfer',
        to: '0xabc',
        amount: '1000000000000000000',
        chainId: 1,
        txCommit: '3333333333333333333333333333333333333333333333333333333333333333',
      },
      BASE_CONFIG,
    );

    expect(normalizeRequestNonce(actual)).toBe(readFixture('wallet.transfer.json'));
  });

  it('intent agentId and generated txCommit match the pinned wire fixture', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-11-14T22:13:20Z'));

    const actual = await captureWireBody(
      {
        action: 'bash',
        agentId: 'intent-agent',
        command: 'echo hi',
      },
      {
        ...BASE_CONFIG,
        agentId: 'config-agent',
      },
    );

    expect(normalizeRequestNonce(actual)).toBe(readFixture('intent_agent_override.json'));
  });

  it('cowork_pretooluse fixture matches the actual HTTP wire body', async () => {
    const actual = await captureCoworkWireBody();
    expect(normalizeRequestNonce(actual)).toBe(readFixture('cowork_pretooluse.json'));
  });

  it('pins fixtures to a real agent-hooks-rs commit sha', () => {
    const pin = readFileSync(UPSTREAM_PIN_PATH, 'utf8').trim();
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
  });
});
