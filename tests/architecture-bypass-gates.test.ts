import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const childProcessOptions = {
  encoding: 'utf8' as const,
  timeout: 120_000,
  killSignal: 'SIGKILL' as const,
};

interface LintMessage {
  ruleId: string | null;
  message: string;
}

function lintFixture(path: string): LintMessage[] {
  const result = spawnSync(
    resolve(process.cwd(), 'node_modules/.bin/eslint'),
    [resolve(process.cwd(), path), '--format', 'json'],
    childProcessOptions,
  );
  expect(result.status).toBe(1);
  const report = JSON.parse(result.stdout) as Array<{ messages: LintMessage[] }>;
  return report.flatMap((file) => file.messages);
}

describe('architecture bypass gate controls', () => {
  it.each(['crypto-lint-fixtures', 'lint-fixtures'])(
    'blocks every planted alternate runtime loader in %s',
    (fixtureDirectory) => {
      const findings = lintFixture(
        `tests/${fixtureDirectory}/forbidden-loader-aliases.ts`,
      ).filter((message) =>
        message.ruleId === 'no-restricted-imports' ||
        message.ruleId === 'no-restricted-syntax');
      // Default import, import-equals, createRequire, aliased require, bound
      // require, and dot/computed member-require routes fail independently.
      expect(findings).toHaveLength(7);
    },
  );

  it.each(['crypto-lint-fixtures', 'lint-fixtures'])(
    'blocks a dynamically computed subtle member in %s',
    (fixtureDirectory) => {
      const findings = lintFixture(
        `tests/${fixtureDirectory}/forbidden-dynamic-computed-subtle.ts`,
      ).filter((message) =>
        message.ruleId === 'no-restricted-syntax' &&
        message.message.includes('computed subtle member'));
      expect(findings).toHaveLength(1);
    },
  );

  it('blocks a decision import from a nested adapter fixture', () => {
    const findings = lintFixture(
      'tests/lint-fixtures/nested/forbidden-nested-decision-import.ts',
    ).filter((message) =>
      message.ruleId === 'no-restricted-imports' &&
      message.message.includes('cannot import raw decision'));
    expect(findings).toHaveLength(1);
  });
});
