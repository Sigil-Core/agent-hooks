import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
};

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

async function captureWire(
  run: (apiUrl: string) => Promise<unknown>,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let capturedBody = '';
    const server = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        capturedBody += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"APPROVED"}');
        server.close((closeErr) => {
          if (closeErr) {
            rejectPromise(closeErr);
            return;
          }
          resolvePromise(capturedBody);
        });
      });
      req.on('error', (error) => {
        server.close(() => rejectPromise(error));
      });
    });

    server.on('error', rejectPromise);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address() as AddressInfo;
      try {
        await run(`http://127.0.0.1:${port}`);
      } catch (error) {
        server.close(() => rejectPromise(error));
      }
    });
  });
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
    });
    await hook(COWORK_FIXTURE_PAYLOAD);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('contract fixtures', () => {
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

    expect(actual).toBe(readFixture('bash.json'));
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

    expect(actual).toBe(readFixture('web_fetch.json'));
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

    expect(actual).toBe(readFixture('wallet.transfer.json'));
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

    expect(actual).toBe(readFixture('intent_agent_override.json'));
  });

  it('cowork_pretooluse fixture matches the actual HTTP wire body', async () => {
    const actual = await captureCoworkWireBody();
    expect(actual).toBe(readFixture('cowork_pretooluse.json'));
  });

  it('pins fixtures to a real agent-hooks-rs commit sha', () => {
    const pin = readFileSync(UPSTREAM_PIN_PATH, 'utf8').trim();
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
  });
});
