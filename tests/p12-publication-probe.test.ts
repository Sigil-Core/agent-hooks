import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = resolve(root, 'scripts/p12-publication-probe/check.mjs');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'tools/p12-publication-probe/manifest.json'), 'utf8'),
);
const workflow = readFileSync(resolve(root, '.github/workflows/publish.yml'), 'utf8');
const allowedChangedFiles = [
  '.github/workflows/ci.yml',
  '.github/workflows/publish.yml',
  'scripts/p12-publication-probe/check.mjs',
  'tests/p12-publication-probe.test.ts',
  'tools/p12-publication-probe/bootstrap/README.md',
  'tools/p12-publication-probe/bootstrap/package.json',
  'tools/p12-publication-probe/bootstrap/probe.json',
  'tools/p12-publication-probe/manifest.json',
  'tools/p12-publication-probe/oidc/README.md',
  'tools/p12-publication-probe/oidc/package.json',
  'tools/p12-publication-probe/oidc/probe.json',
];
const expectedPacklist = ['README.md', 'package.json', 'probe.json'];

function runGuard(ref: string, mode: string) {
  return spawnSync(
    process.execPath,
    [checkScript, 'guard', '--ref', ref, '--mode', mode],
    { cwd: root, encoding: 'utf8' },
  );
}

function runGit(directory: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createGitFixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'p12-git-'));
  runGit(directory, ['init', '--quiet']);
  for (const [path, contents] of Object.entries(files)) {
    writeFileSync(join(directory, path), contents);
  }
  runGit(directory, ['add', '.']);
  runGit(directory, [
    '-c', 'user.name=P-12 Test',
    '-c', 'user.email=p12@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  return { directory, sourceCommit: runGit(directory, ['rev-parse', 'HEAD']) };
}

function listFixtureChanges(directory: string, sourceCommit: string) {
  const moduleUrl = pathToFileURL(checkScript).href;
  const source = [
    `import { listChangedFiles } from ${JSON.stringify(moduleUrl)};`,
    `console.log(JSON.stringify(listChangedFiles(${JSON.stringify(directory)}, ${JSON.stringify(sourceCommit)})));`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: directory,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function runCheckerEvaluation(source: string, cwd = root) {
  const moduleUrl = pathToFileURL(checkScript).href;
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `import * as checker from ${JSON.stringify(moduleUrl)};\n${source}`],
    { cwd, encoding: 'utf8' },
  );
}

describe('P-12 publication probe', () => {
  it('binds every immutable publication input', () => {
    expect(manifest).toMatchObject({
      repository: 'Sigil-Core/agent-hooks',
      sourceCommit: '9267648c6776d39bc802ca33420a48dd22da39dd',
      workflow: 'publish.yml',
      workflowJob: 'stage-publish',
      branchRef: 'refs/heads/release/s12-emergency',
      environment: 's12-emergency-publish',
      packageName: '@sigilcore/agent-hooks-publication-probe',
      bootstrapVersion: '0.0.0-p12-bootstrap-r2.20260808',
      oidcVersion: '0.0.0-p12-oidc-r2.20260808',
      distTag: 's12-probe',
      npmVersion: '11.17.0',
      modes: ['dry-run', 'stage-publish'],
      expectedPacklist,
      allowedChangedFiles,
      bootstrapDirectory: 'tools/p12-publication-probe/bootstrap',
      oidcDirectory: 'tools/p12-publication-probe/oidc',
    });
    expect(manifest.allowedChangedFiles).toEqual(allowedChangedFiles);
    for (const directory of [manifest.bootstrapDirectory, manifest.oidcDirectory]) {
      const packageJson = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
      expect(packageJson).not.toHaveProperty('scripts');
    }
  });

  it('accepts only the retained release ref and two declared modes', () => {
    expect(runGuard(manifest.branchRef, 'dry-run').status).toBe(0);
    expect(runGuard(manifest.branchRef, 'stage-publish').status).toBe(0);

    for (const rejectedRef of [
      'refs/heads/main',
      'refs/heads/release/s12-emergency-extra',
      'refs/tags/s12-emergency',
      '',
    ]) {
      const result = runGuard(rejectedRef, 'dry-run');
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('rejects ref');
    }

    for (const rejectedMode of ['publish', 'real', 'latest', '']) {
      const result = runGuard(manifest.branchRef, rejectedMode);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain('rejects mode');
    }
  });

  it('normalizes the complete manual-dispatch plan and permits one exact tarball staged submission', () => {
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(plan.publications).toHaveLength(2);
    expect(plan.releasePublications).toHaveLength(1);
    expect(plan.releasePublications[0]).toMatchObject({
      job: 'publish',
      jobIf: "github.event_name == 'release'",
      publishes: true,
    });
    expect(plan.manualDispatchPublications).toHaveLength(1);
    expect(plan.manualDispatchPublications[0]).toMatchObject({
      job: 'stage-publish',
      jobIf: "github.event_name == 'workflow_dispatch'",
      if: "inputs.mode == 'stage-publish'",
      publishes: true,
    });
    expect(plan.manualDispatchPublications[0].command).toContain('npm stage publish "${tarball_path}"');
    expect(plan.manualDispatchPublications[0].command).toContain('--tag "${P12_DIST_TAG}"');
    expect(plan.manualDispatchPublications[0].command).toContain('--provenance');
    expect(plan.manualDispatchPublications[0].command).not.toContain('latest');
    const manualJob = plan.jobs.find((job: { id: string }) => job.id === 'stage-publish');
    const checkout = manualJob.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@'));
    expect(checkout.fetchDepth).toBe('0');
    expect(workflow).toContain("if: inputs.mode == 'dry-run'");
    expect(workflow).toContain('Dry run complete. No npm publication command was executed.');
    expect(workflow).not.toContain('NPM_TOKEN');
  });

  it('rejects a second publication step reachable from manual dispatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '      - name: Stage exact OIDC probe under the non-production tag',
      '      - name: Forbidden second manual publication\n' +
        '        run: npm publish --access public\n\n' +
        '      - name: Stage exact OIDC probe under the non-production tag',
    );
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected one manual publication step, got 2');
  });

  it('rejects a run-first publication step reachable from manual dispatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-run-first-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '      - name: Stage exact OIDC probe under the non-production tag',
      '      - run: npm publish --access public\n\n' +
        '      - name: Stage exact OIDC probe under the non-production tag',
    );
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected one manual publication step, got 2');
  });

  it('rejects multiple publication commands hidden in one manual step', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-double-publish-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '            --provenance',
      '            --provenance\n          npm publish --access public',
    );
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected one manual publication step, got 2');
  });

  it('keeps a commented block scalar body visible to publication validation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-commented-block-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '      - name: Stage exact OIDC probe under the non-production tag\n' +
        "        if: inputs.mode == 'stage-publish'\n" +
        '        shell: bash\n' +
        '        run: |',
      '      - name: Stage exact OIDC probe under the non-production tag\n' +
        "        if: inputs.mode == 'stage-publish'\n" +
        '        shell: bash\n' +
        '        run: | # reviewed block',
    );
    expect(mutated).not.toBe(workflow);
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(plan.manualDispatchPublications).toHaveLength(1);
    expect(plan.manualDispatchPublications[0].command).toContain('npm stage publish');
  });

  it('rejects immediate publication when staged text appears only in a shell comment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-stage-comment-bypass-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '          npm stage publish "${tarball_path}" \\\n',
      '          npm publish "${tarball_path}" --provenance # npm stage publish "${tarball_path}" \\\n',
    );
    expect(mutated).not.toBe(workflow);
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('manual publication must stage the recorded tarball path');
  });

  it('rejects a workflow step that declares neither uses nor run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-unsupported-step-'));
    const path = join(directory, 'publish.yml');
    const mutated = workflow.replace(
      '      - name: Stage exact OIDC probe under the non-production tag',
      '      - name: Metadata-only unsupported step\n' +
        "        if: inputs.mode == 'stage-publish'\n\n" +
        '      - name: Stage exact OIDC probe under the non-production tag',
    );
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must declare exactly one of uses or run');
  });

  it('rejects a workflow step that declares both uses and run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-ambiguous-step-'));
    const path = join(directory, 'publish.yml');
    const checkout =
      '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5';
    const mutated = workflow.replace(checkout, `${checkout}\n        run: echo invalid`);
    expect(mutated).not.toBe(workflow);
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must declare exactly one of uses or run');
  });

  it('rejects a manual plan with its runtime ref and mode guard removed', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-workflow-no-runtime-guard-'));
    const path = join(directory, 'publish.yml');
    const guardCommand =
      '          node scripts/p12-publication-probe/check.mjs guard \\\n' +
      '            --ref "${GITHUB_REF}" \\\n' +
      '            --mode "${P12_MODE}"\n';
    const mutated = workflow.replace(guardCommand, '');
    expect(mutated).not.toBe(workflow);
    writeFileSync(path, mutated);
    const result = spawnSync(process.execPath, [checkScript, 'workflow-plan', '--workflow', path], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected one manual runtime guard step, got 0');
  });

  it('emits only the reviewed packlist for both immutable probe versions', () => {
    const result = spawnSync(process.execPath, [checkScript, 'packlist'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const reports = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
    expect(reports).toEqual([
      {
        directory: 'tools/p12-publication-probe/bootstrap',
        filename: 'sigilcore-agent-hooks-publication-probe-0.0.0-p12-bootstrap-r2.20260808.tgz',
        files: expectedPacklist,
      },
      {
        directory: 'tools/p12-publication-probe/oidc',
        filename: 'sigilcore-agent-hooks-publication-probe-0.0.0-p12-oidc-r2.20260808.tgz',
        files: expectedPacklist,
      },
    ]);
  });

  it('rejects packlist generation when the invoked npm is not 11.17.0', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-npm-'));
    const fakeNpm = join(directory, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\necho 0.0.0\n');
    chmodSync(fakeNpm, 0o755);
    const result = spawnSync(process.execPath, [checkScript, 'packlist'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm version drifted: expected 11.17.0, got 0.0.0');
  });

  it('rejects fixture lifecycle scripts before npm pack can execute them', () => {
    const result = runCheckerEvaluation(
      'checker.assertNoLifecycleScripts({ scripts: { prepack: "exit 99" } }, "fixture");',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture must not define lifecycle scripts');
  });

  it('rejects fixture content that differs from its audited hash', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p12-hash-'));
    const fixtureDirectory = join(directory, 'fixture');
    mkdirSync(fixtureDirectory);
    for (const file of expectedPacklist) {
      const source = resolve(root, 'tools/p12-publication-probe/bootstrap', file);
      writeFileSync(join(fixtureDirectory, file), readFileSync(source));
    }
    writeFileSync(join(fixtureDirectory, 'README.md'), 'tampered\n');
    const result = runCheckerEvaluation(
      `checker.checkFixtureContents('bootstrap', 'fixture', ${JSON.stringify(directory)});`,
      directory,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bootstrap fixture content drifted: README.md');
  });

  it('allows only the reviewed P-12 workflow, fixture, manifest, checker and test files', () => {
    const result = spawnSync(process.execPath, [checkScript, 'changed-files'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
    expect(report).toEqual({
      sourceCommit: '9267648c6776d39bc802ca33420a48dd22da39dd',
      changedFiles: allowedChangedFiles,
    });
  });

  it('reports a deleted tracked path', () => {
    const fixture = createGitFixture({ 'deleted.txt': 'delete me\n', 'keep.txt': 'keep me\n' });
    rmSync(join(fixture.directory, 'deleted.txt'));
    expect(listFixtureChanges(fixture.directory, fixture.sourceCommit)).toEqual(['deleted.txt']);
  });

  it('reports both source and destination paths for a rename', () => {
    const fixture = createGitFixture({ 'renamed-from.txt': 'rename me\n', 'keep.txt': 'keep me\n' });
    renameSync(
      join(fixture.directory, 'renamed-from.txt'),
      join(fixture.directory, 'renamed-to.txt'),
    );
    expect(listFixtureChanges(fixture.directory, fixture.sourceCommit)).toEqual([
      'renamed-from.txt',
      'renamed-to.txt',
    ]);
  });
});
