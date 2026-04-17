import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAuthorizeRequestBody } from '../src/request.js';
import type { SigilHookConfig, SigilIntent } from '../src/types.js';

const FIXTURE_ROOT = resolve(process.cwd(), 'tests/contract-fixtures/v1');

const BASE_CONFIG: SigilHookConfig = {
  apiKey: 'sk_sigil_test_key',
  agentId: 'fixture-agent',
};

function readFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_ROOT, name), 'utf8');
}

function canonicalize(intent: SigilIntent): string {
  return `${JSON.stringify(buildAuthorizeRequestBody(intent, BASE_CONFIG), null, 2)}\n`;
}

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

  it('bash fixture matches TS request body', () => {
    const actual = canonicalize({
      action: 'bash',
      command: 'ls -la',
      txCommit: '1111111111111111111111111111111111111111111111111111111111111111',
    });
    expect(actual).toBe(readFixture('bash.json'));
  });

  it('web_fetch fixture matches TS request body', () => {
    const actual = canonicalize({
      action: 'web_fetch',
      url: 'https://example.com/policy',
      txCommit: '2222222222222222222222222222222222222222222222222222222222222222',
    });
    expect(actual).toBe(readFixture('web_fetch.json'));
  });

  it('wallet.transfer fixture matches TS request body', () => {
    const actual = canonicalize({
      action: 'wallet.transfer',
      to: '0xabc',
      amount: '1000000000000000000',
      chainId: 1,
      txCommit: '3333333333333333333333333333333333333333333333333333333333333333',
    });
    expect(actual).toBe(readFixture('wallet.transfer.json'));
  });
});

