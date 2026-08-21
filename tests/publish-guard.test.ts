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

  it('rejects guard-before-install even when another job has the correct order', () => {
    const reversed = workflow.replace(
      [
        '      - run: npm ci',
        '',
        '      - name: Verify trusted publication contract',
        '        run: npm run publish:guard',
      ].join('\n'),
      [
        '      - name: Verify trusted publication contract',
        '        run: npm run publish:guard',
        '',
        '      - run: npm ci',
      ].join('\n'),
    );
    expect(reversed).not.toBe(workflow);
    const decoyJob = [
      '',
      '  decoy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm ci',
      '      - run: npm run publish:guard',
      '',
    ].join('\n');
    const result = runGuard(`${reversed}${decoyJob}`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('publish job must run npm ci before npm run publish:guard');
  });

  it('documents the publication contract', () => {
    expect(workflow).toContain('name: npm-production');
    expect(workflow).toContain("if: github.event_name == 'release'");
    expect(workflow).not.toContain('NPM_TOKEN');
    // Assert the two contract facts the docs must carry, not brittle prose.
    expect(publishingDocs).toContain('npm trusted publisher');
    expect(publishingDocs).toContain('npm-production');
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
    const mutated = workflow.replace(
      'https://registry.npmjs.org/',
      'https://registryXnpmjsYorg/',
    );
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('registry');
  });

  it.each([
    ['backslash-escaped', 'n\\pm publish --access public'],
    // Expressed as a YAML single-quoted scalar: shell quoting and YAML
    // quoting are different layers, and an unquoted `"npm" publish` is not
    // valid YAML at all.
    ['shell-quoted', '\'"npm" publish --access public\''],
    ['split-quoted', '\'np\'\'\'\'m publish --access public\''],
  ])('detects a %s publication verb', (_label, spelling) => {
    const mutated = workflow.replace('npm publish --access public --provenance', spelling);
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('provenance');
  });

  it('rejects provenance explicitly disabled', () => {
    const mutated = workflow.replace(
      'npm publish --access public --provenance',
      'npm publish --access public --provenance=false',
    );
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('provenance');
  });

  it('rejects a job mixing workflow_dispatch with release', () => {
    const mixed = [
      '',
      '  mixed-publish:',
      "    if: github.event_name == 'workflow_dispatch' || github.event_name == 'release'",
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm stage publish --provenance --tag next',
      '',
    ].join('\n');
    const result = runGuard(`${workflow}${mixed}`);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('workflow_dispatch');
  });

  it('rejects id-token granted to another job but not to publish', () => {
    const mutated = workflow
      .replace(/^permissions:\n(?: {2}.*\n)+/m, '')
      .replace(/^ {2}publish:\n/m, '  publish:\n    permissions:\n      contents: read\n');
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('id-token');
  });

  it('rejects a publication hidden in an unrelated job', () => {
    const extra = [
      '',
      '  sneaky:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm publish --access public --provenance',
      '',
    ].join('\n');
    const result = runGuard(`${workflow}${extra}`);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('sneaky');
  });
});

describe('publication guard parses structure, not text', () => {
  it('reads a block scalar run body with deeper indentation', () => {
    // The hand-rolled reader could not follow a block scalar, so a publish
    // command written this way was invisible to the guard entirely.
    const mutated = workflow.replace(
      '        run: npm publish --access public --provenance',
      ['        run: |', '          npm publish --access public'].join('\n'),
    );
    const result = runGuard(mutated);
    expect(result.status, result.stdout).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain('provenance');
  });

  it('reads inline-mapping permissions', () => {
    const mutated = workflow.replace(
      /^permissions:\n(?: {2}.*\n)+/m,
      'permissions: { contents: read, id-token: write }\n',
    );
    const result = runGuard(mutated);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
  });

  it('accepts a quoted registry URL, which regex matching was sensitive to', () => {
    const mutated = workflow.replace(
      'registry-url: https://registry.npmjs.org/',
      "registry-url: 'https://registry.npmjs.org/'",
    );
    const result = runGuard(mutated);
    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
  });

  it('reports invalid YAML rather than silently passing', () => {
    const result = runGuard('jobs:\n  publish:\n   bad: [unclosed\n');
    expect(result.status).not.toBe(0);
  });
});
