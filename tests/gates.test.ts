import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const childProcessOptions = {
  encoding: 'utf8' as const,
  timeout: 120_000,
  killSignal: 'SIGKILL' as const,
};

describe('decision gate negative controls', () => {
  const gateScript = resolve(process.cwd(), 'scripts/decision-literal-gate.mjs');

  it('fails on a planted runtime literal', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(process.cwd(), 'scripts/decision-literal-gate.mjs'),
        '--root',
        resolve(process.cwd(), 'tests/gate-fixtures'),
        '--blocking',
      ],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('planted-violation.ts:1');
  });

  it('detects exact decision template literals without flagging template prose', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-hooks-literal-template-'));
    try {
      writeFileSync(
        join(root, 'decision.ts'),
        'export const decision = `ALLOWED`;\n',
        'utf8',
      );
      writeFileSync(
        join(root, 'message.ts'),
        'export const message = `received ALLOWED from the policy service`;\n',
        'utf8',
      );
      writeFileSync(
        join(root, 'gate.json'),
        JSON.stringify({ runtimePaths: ['decision.ts', 'message.ts'], allowedFiles: [] }),
        'utf8',
      );
      const result = spawnSync(
        process.execPath,
        [gateScript, '--root', root, '--config', 'gate.json', '--blocking'],
        childProcessOptions,
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('decision.ts:1');
      expect(result.stderr).not.toContain('message.ts:1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed with a distinct configuration exit for a missing flag value', () => {
    const result = spawnSync(
      process.execPath,
      [gateScript, '--root', '--blocking'],
      childProcessOptions,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('configuration error: --root requires a value.');
  });

  it.each([
    ['malformed JSON', '{'],
    ['missing arrays', JSON.stringify({ version: 1 })],
    ['nonexistent runtime path', JSON.stringify({ runtimePaths: ['missing'], allowedFiles: [] })],
  ])('fails closed with a distinct configuration exit for %s', (_label, config) => {
    const root = mkdtempSync(join(tmpdir(), 'agent-hooks-literal-gate-'));
    try {
      writeFileSync(join(root, 'gate.json'), config, 'utf8');
      const result = spawnSync(
        process.execPath,
        [gateScript, '--root', root, '--config', 'gate.json', '--blocking'],
        childProcessOptions,
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('decision-literal-gate: configuration error:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a forbidden execution-path import', () => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/eslint'),
      [resolve(process.cwd(), 'tests/lint-fixtures/forbidden-import.ts')],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('normalizeDecisionLiteral');
  });

  it('fails when raw signature verification escapes the verifier boundary', () => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/eslint'),
      [resolve(process.cwd(), 'tests/crypto-lint-fixtures/forbidden-crypto-import.ts')],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Raw signature verification is confined to src/decision.ts');
    expect(result.stdout).toContain('Namespace crypto imports can bypass the verifier-boundary import list');
  });

  it.each([
    ['forbidden-global-subtle.ts', 'Web Crypto signature verification'],
    ['forbidden-computed-crypto.ts', 'Computed dynamic imports'],
  ])('fails the crypto boundary fixture %s', (fixture, finding) => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/eslint'),
      [resolve(process.cwd(), 'tests/crypto-lint-fixtures', fixture)],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(finding);
    if (fixture === 'forbidden-computed-crypto.ts') {
      expect(result.stdout).toContain('Computed require calls');
    }
  });

  it.each([
    ['forbidden-import-type-cast.ts', 'import types'],
    ['forbidden-qualified-casts.ts', 'namespace-import'],
    ['forbidden-transport-capability-import.ts', 'cannot import raw decision'],
    ['forbidden-decision-dynamic-import.ts', 'dynamically import'],
  ])('fails the capability-cast fixture %s', (fixture, finding) => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/eslint'),
      [resolve(process.cwd(), 'tests/lint-fixtures', fixture)],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(finding);
  });

  it.each(['crypto-lint-fixtures', 'lint-fixtures'])(
    'blocks every planted dynamic JOSE and Web Crypto bypass in %s',
    (fixtureDirectory) => {
      const fixtures = [
        ['forbidden-dynamic-jose.ts', 'Dynamic JOSE imports', 6],
        ['forbidden-aliased-computed-subtle.ts', 'Web Crypto signature verification', 4],
      ] as const;

      for (const [fixture, finding, expectedFindings] of fixtures) {
        const result = spawnSync(
          resolve(process.cwd(), 'node_modules/.bin/eslint'),
          [resolve(process.cwd(), 'tests', fixtureDirectory, fixture)],
          childProcessOptions,
        );
        expect(result.status).toBe(1);
        expect(result.stdout.split(finding).length - 1).toBe(expectedFindings);
      }
    },
  );

  it('makes the real adapter seam suite fail under a raw-literal mutant', () => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/vitest'),
      [
        'run',
        '--config',
        resolve(process.cwd(), 'tests/mutant-fixtures/vitest.config.ts'),
      ],
      childProcessOptions,
    );
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'keeps the real wrapped action at zero executions',
    );
  });

  it('keeps opaque-capability construction as a compile-fail contract', () => {
    const result = spawnSync(
      resolve(process.cwd(), 'node_modules/.bin/tsc'),
      [
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--skipLibCheck',
        resolve(process.cwd(), 'tests/capability.compile.ts'),
      ],
      childProcessOptions,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
