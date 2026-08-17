import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = resolve(root, 'scripts/publish-guard.mjs');
const workflowPath = resolve(root, '.github/workflows/publish.yml');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const workflow = readFileSync(workflowPath, 'utf8');
const publishingDocs = readFileSync(resolve(root, 'docs/publishing.md'), 'utf8');

function runGuard(source = workflow) {
  const directory = mkdtempSync(join(tmpdir(), 'publish-guard-'));
  const candidate = join(directory, 'publish.yml');
  writeFileSync(candidate, source);
  return spawnSync(process.execPath, [guardPath, '--workflow', candidate], {
    cwd: root,
    encoding: 'utf8',
  });
}

function evaluate(source: string) {
  const moduleUrl = pathToFileURL(guardPath).href;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import * as guard from ${JSON.stringify(moduleUrl)};\n${source}`],
    { cwd: root, encoding: 'utf8' },
  );
}

describe('npm publication guard', () => {
  it('accepts the production trusted-publishing contract', () => {
    const result = runGuard();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm publish --access public --provenance');
    expect(packageJson.repository.url).toBe('git+https://github.com/Sigil-Core/agent-hooks.git');
    expect(packageJson.publishConfig.provenance).toBe(true);
  });

  it('documents the publication contract', () => {
    expect(workflow).toContain('name: npm-production');
    expect(workflow).toContain("if: github.event_name == 'release'");
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(publishingDocs).toContain('external configuration');
    expect(publishingDocs).toContain('temporary publisher record');
  });

  it('accepts one manual P-12 stage publish and rejects direct publish', () => {
    const tarballReference = ['$', '{TARBALL}'].join('');
    const manualJob = `
  stage-publish:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Stage probe
        if: inputs.mode == 'stage-publish'
        run: npm stage publish "${tarballReference}" --tag s12-probe --provenance
`;
    const staged = workflow + manualJob;
    expect(runGuard(staged).status).toBe(0);

    const direct = staged.replace('npm stage publish', 'npm publish');
    const result = runGuard(direct);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workflow_dispatch publication must use npm stage publish');
  });

  it('rejects duplicate and hidden publication commands', () => {
    const duplicate = workflow.replace(
      '      - name: Publish to npm',
      '      - name: Duplicate publication\n        run: npm publish --access public --provenance\n\n      - name: Publish to npm',
    );
    expect(runGuard(duplicate).stderr).toContain('exactly one publication command');

    const hidden = workflow.replace(
      '      - name: Publish to npm',
      '      - name: Hidden duplicate publication\n' +
        '        run: if false; then npm publish --access public --provenance; fi\n\n' +
        '      - name: Publish to npm',
    );
    expect(runGuard(hidden).stderr).toContain('exactly one publication command');
  });

  it('rejects a staged command that targets latest', () => {
    const staged = `${workflow}
  stage-publish:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - run: npm stage publish artifact.tgz --tag latest --provenance
`;
    const result = runGuard(staged);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not target latest');
  });

  it('exports a parser that rejects ambiguous workflow steps', () => {
    const result = evaluate(`
      guard.parseWorkflow(${JSON.stringify(workflow.replace(
        '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5',
        '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5\n        run: echo invalid',
      ))});
    `);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('exactly one of uses or run');
  });
});

describe('publication guard hardening', () => {
  it('rejects a lookalike registry URL', () => {
    // Before the escape fix the metacharacter class terminated early and
    // escaped nothing, so the dots in registry.npmjs.org stayed live and this
    // source satisfied the registry assertion.
    const mutated = workflow.replace(
      'https://registry.npmjs.org/',
      'https://registryXnpmjsYorg/',
    );
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('registry');
  });

  it('detects a shell-escaped publication verb', () => {
    const mutated = workflow.replace(
      'npm publish --access public --provenance',
      'n\\pm publish --access public',
    );
    const result = runGuard(mutated);
    // The escaped spelling must still be seen as a publication command, so the
    // missing --provenance is caught rather than the command going unnoticed.
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('provenance');
  });

  it('rejects a job mixing workflow_dispatch with release', () => {
    const mixedJob = [
      '',
      '  mixed-publish:',
      "    if: github.event_name == 'workflow_dispatch' || github.event_name == 'release'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm stage publish --provenance --tag next',
      '',
    ].join('\n');
    const result = runGuard(`${workflow}${mixedJob}`);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('workflow_dispatch');
  });
});
