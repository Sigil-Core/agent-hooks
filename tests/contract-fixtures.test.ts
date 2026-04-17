import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
};

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

async function captureWireBody(
  intent: SigilIntent,
  config: SigilHookConfig,
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
        await checkIntent(intent, {
          ...config,
          apiUrl: `http://127.0.0.1:${port}`,
        });
      } catch (error) {
        server.close(() => rejectPromise(error));
      }
    });
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

  it('pins fixtures to a real agent-hooks-rs commit sha', () => {
    const pin = readFileSync(UPSTREAM_PIN_PATH, 'utf8').trim();
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
  });
});
