/* eslint-env node */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');
const manifestPath = resolve(
  repositoryRoot,
  'tools/p12-publication-probe/manifest.json',
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expectedAllowedChangedFiles = [
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
const expectedBootstrapDirectory = 'tools/p12-publication-probe/bootstrap';
const expectedOidcDirectory = 'tools/p12-publication-probe/oidc';
const expectedFixtureHashes = {
  bootstrap: {
    'README.md': '437609b1155e52ab5d1a38cbae63c368525e533daa22fd937dc17b91f44078f9',
    'package.json': 'b5e8de70ee2691ff3033add7a247450836d22b13a36eb64ec04fa93b3106a57a',
    'probe.json': '0b34d966b155ff4f372b41110da8de8c910477aa09d8c19f8495a28c5af951b5',
  },
  oidc: {
    'README.md': 'ad6c4f62018847d5349e0315571f892cfb60f1c21aa01760013f0b66bb7a4417',
    'package.json': '449e0f8553540dd1dddd5fd3e189a87b00c9ba289d459ffec3fbabdd6a5a3cbd',
    'probe.json': '9fd7cd3b74ceab42cd8ecb751c835a5453e889ff16864b00ea69cdf28164bd19',
  },
};

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(relativePath, root = repositoryRoot) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function fileSha256(relativePath, root = repositoryRoot) {
  return createHash('sha256')
    .update(readFileSync(resolve(root, relativePath)))
    .digest('hex');
}

export function assertNoLifecycleScripts(packageJson, label) {
  assert(packageJson.scripts === undefined, `${label} must not define lifecycle scripts`);
}

export function checkFixtureContents(kind, directory, root = repositoryRoot) {
  for (const [file, expectedHash] of Object.entries(expectedFixtureHashes[kind])) {
    assert(
      fileSha256(`${directory}/${file}`, root) === expectedHash,
      `${kind} fixture content drifted: ${file}`,
    );
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function guard(ref, mode) {
  if (ref !== manifest.branchRef) {
    fail(`P-12 publication probe rejects ref ${ref ?? '<missing>'}.`, 64);
  }
  if (!manifest.modes.includes(mode)) {
    fail(`P-12 publication probe rejects mode ${mode ?? '<missing>'}.`, 64);
  }
  console.log(`P-12 guard accepted ${ref} in ${mode} mode.`);
}

function checkFixture(kind, directory, expectedVersion) {
  const packageJson = readJson(`${directory}/package.json`);
  const probe = readJson(`${directory}/probe.json`);
  const expectedRepository = 'git+https://github.com/Sigil-Core/agent-hooks.git';

  assert(packageJson.name === manifest.packageName, `${kind} package name drifted`);
  assert(packageJson.version === expectedVersion, `${kind} version drifted`);
  assert(packageJson.repository?.url === expectedRepository, `${kind} repository drifted`);
  assert(packageJson.publishConfig?.access === 'public', `${kind} access drifted`);
  assert(packageJson.publishConfig?.tag === manifest.distTag, `${kind} tag drifted`);
  assert(packageJson.publishConfig?.provenance === undefined, `${kind} fixture must not force provenance`);
  assertNoLifecycleScripts(packageJson, `${kind} fixture`);
  assert(probe.schemaVersion === manifest.schemaVersion, `${kind} schema drifted`);
  assert(probe.kind === kind, `${kind} probe kind drifted`);
  assert(probe.package === manifest.packageName, `${kind} probe package drifted`);
  assert(probe.version === expectedVersion, `${kind} probe version drifted`);
  assert(probe.branchRef === manifest.branchRef, `${kind} branch drifted`);
  assert(probe.distTag === manifest.distTag, `${kind} probe tag drifted`);
  checkFixtureContents(kind, directory);
}

function checkStatic() {
  assert(manifest.repository === 'Sigil-Core/agent-hooks', 'repository drifted');
  assert(manifest.schemaVersion === 'sigil-agent-hooks-p12-publication-probe/v1', 'schema version drifted');
  assert(manifest.sourceCommit === '9267648c6776d39bc802ca33420a48dd22da39dd', 'source commit drifted');
  assert(manifest.workflow === 'publish.yml', 'workflow drifted');
  assert(manifest.workflowJob === 'stage-publish', 'workflow job drifted');
  assert(manifest.branchRef === 'refs/heads/release/s12-emergency', 'branch drifted');
  assert(manifest.environment === 's12-emergency-publish', 'environment drifted');
  assert(manifest.packageName === '@sigilcore/agent-hooks-publication-probe', 'package drifted');
  assert(manifest.bootstrapVersion === '0.0.0-p12-bootstrap-r2.20260808', 'bootstrap version drifted');
  assert(manifest.oidcVersion === '0.0.0-p12-oidc-r2.20260808', 'OIDC version drifted');
  assert(manifest.distTag === 's12-probe', 'dist-tag drifted');
  assert(manifest.npmVersion === '11.17.0', 'npm version drifted');
  assert(JSON.stringify(manifest.modes) === JSON.stringify(['dry-run', 'stage-publish']), 'mode set drifted');
  assert(
    JSON.stringify(manifest.allowedChangedFiles) === JSON.stringify(expectedAllowedChangedFiles),
    'allowed changed-file set drifted',
  );
  assert(
    JSON.stringify(manifest.expectedPacklist) === JSON.stringify(expectedPacklist),
    'expected packlist drifted',
  );
  assert(manifest.bootstrapDirectory === expectedBootstrapDirectory, 'bootstrap directory drifted');
  assert(manifest.oidcDirectory === expectedOidcDirectory, 'OIDC directory drifted');
  checkFixture('bootstrap', expectedBootstrapDirectory, manifest.bootstrapVersion);
  checkFixture('oidc', expectedOidcDirectory, manifest.oidcVersion);
  console.log('P-12 static manifest and fixture checks passed.');
}

function gitLines(args, cwd = repositoryRoot) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

export function listChangedFiles(gitRepository, sourceCommit) {
  const changed = new Set([
    ...gitLines([
      'diff',
      '--name-only',
      '--no-renames',
      '--diff-filter=ACDMRT',
      sourceCommit,
    ], gitRepository),
    ...gitLines(['ls-files', '--others', '--exclude-standard'], gitRepository),
  ]);
  return [...changed].sort();
}

function checkChangedFiles() {
  const actual = listChangedFiles(repositoryRoot, manifest.sourceCommit);
  const expected = [...expectedAllowedChangedFiles].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `P-12 changed-file set drifted: ${JSON.stringify(actual)}`,
  );
  assert(!actual.includes('src/adapters/cowork.ts'), 'P-12 must not change src/adapters/cowork.ts');
  console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, changedFiles: actual }, null, 2));
}

function checkNpmVersion() {
  const result = spawnSync('npm', ['--version'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`npm --version failed with exit ${result.status}`);
  }
  const actual = result.stdout.trim();
  assert(actual === manifest.npmVersion, `npm version drifted: expected ${manifest.npmVersion}, got ${actual}`);
  console.log(`P-12 npm version ${actual} passed.`);
}

function packlist(directory) {
  const packageJson = readJson(`${directory}/package.json`);
  assertNoLifecycleScripts(packageJson, directory);
  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: resolve(repositoryRoot, directory),
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`npm pack failed for ${directory} with exit ${result.status}`);
  }
  const report = JSON.parse(result.stdout);
  assert(Array.isArray(report) && report.length === 1, `${directory} pack report must contain one package`);
  const files = report[0].files.map(({ path }) => path).sort();
  const expected = [...expectedPacklist].sort();
  assert(JSON.stringify(files) === JSON.stringify(expected), `${directory} packlist drifted: ${JSON.stringify(files)}`);
  return { directory, filename: report[0].filename, files };
}

function checkPacklists() {
  checkNpmVersion();
  const reports = [
    packlist(expectedBootstrapDirectory),
    packlist(expectedOidcDirectory),
  ];
  console.log(JSON.stringify(reports, null, 2));
}

function blockField(lines, indent, field) {
  const prefix = `${' '.repeat(indent)}${field}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

function normalizeRun(stepLines, firstKey, firstValue) {
  const runLine = firstKey === 'run'
    ? 0
    : stepLines.findIndex((line) => line.startsWith('        run:'));
  if (runLine === -1) {
    return null;
  }
  const inline = firstKey === 'run'
    ? firstValue
    : stepLines[runLine].slice('        run:'.length).trim();
  if (inline && !/^[>|][+-]?$/.test(inline)) {
    return inline;
  }
  return stepLines
    .slice(runLine + 1)
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n')
    .trim();
}

function shellCommands(run) {
  if (run === null) {
    return [];
  }
  return run
    .replace(/\\\s*\n/g, ' ')
    .split(/\n|&&|\|\||;/)
    .map((command) => command.trim())
    .filter(Boolean);
}

function publishCommands(run) {
  return shellCommands(run).filter((command) => /^npm\s+publish(?:\s|$)/.test(command));
}

function normalizeWorkflow(workflowPath) {
  const lines = readFileSync(workflowPath, 'utf8').split('\n');
  const jobsStart = lines.findIndex((line) => line === 'jobs:');
  assert(jobsStart !== -1, 'workflow jobs mapping is missing');
  const jobStarts = [];
  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (match) {
      jobStarts.push({ id: match[1], index });
    }
  }

  const jobs = jobStarts.map((job, position) => {
    const end = jobStarts[position + 1]?.index ?? lines.length;
    const jobLines = lines.slice(job.index + 1, end);
    const stepsStart = jobLines.findIndex((line) => line === '    steps:');
    assert(stepsStart !== -1, `workflow job ${job.id} has no steps`);
    const stepStarts = [];
    for (let index = stepsStart + 1; index < jobLines.length; index += 1) {
      if (/^ {6}- [A-Za-z_][A-Za-z0-9_-]*:/.test(jobLines[index])) {
        stepStarts.push(index);
      }
    }
    const steps = stepStarts.map((start, stepPosition) => {
      const stepEnd = stepStarts[stepPosition + 1] ?? jobLines.length;
      const stepLines = jobLines.slice(start, stepEnd);
      const first = stepLines[0].slice(8);
      const separator = first.indexOf(':');
      assert(separator !== -1, `workflow job ${job.id} contains a malformed step`);
      const firstKey = first.slice(0, separator);
      const firstValue = first.slice(separator + 1).trim();
      const name = firstKey === 'name'
        ? firstValue
        : blockField(stepLines, 8, 'name') ?? `${firstKey} step`;
      const run = normalizeRun(stepLines, firstKey, firstValue);
      const normalizedPublishCommands = publishCommands(run);
      return {
        name,
        uses: firstKey === 'uses' ? firstValue : blockField(stepLines, 8, 'uses'),
        if: firstKey === 'if' ? firstValue : blockField(stepLines, 8, 'if'),
        run,
        publishCommands: normalizedPublishCommands,
        publishes: normalizedPublishCommands.length > 0,
      };
    });
    return {
      id: job.id,
      if: blockField(jobLines, 4, 'if'),
      environment: blockField(jobLines, 6, 'name'),
      steps,
    };
  });
  return { workflowPath, jobs };
}

function validateWorkflowPlan(plan) {
  const manualJobs = plan.jobs.filter((job) => job.if === "github.event_name == 'workflow_dispatch'");
  assert(manualJobs.length === 1, `expected one workflow_dispatch job, got ${manualJobs.length}`);
  const manualJob = manualJobs[0];
  assert(manualJob.id === manifest.workflowJob, 'manual publication job drifted');
  assert(manualJob.environment === manifest.environment, 'manual publication environment drifted');
  const releaseJobs = plan.jobs.filter((job) => job.if === "github.event_name == 'release'");
  assert(releaseJobs.length === 1, `expected one release job, got ${releaseJobs.length}`);
  const releaseJob = releaseJobs[0];
  assert(releaseJob.id === 'publish', 'production release job drifted');
  const publications = plan.jobs.flatMap((job) =>
    job.steps.flatMap((step) =>
      step.publishCommands.map((command) => ({ job: job.id, jobIf: job.if, ...step, command })),
    ),
  );
  const manualPublications = publications.filter((step) => step.job === manualJob.id);
  const releasePublications = publications.filter((step) => step.job === releaseJob.id);
  const unexpectedPublications = publications.filter(
    (step) => step.job !== manualJob.id && step.job !== releaseJob.id,
  );
  assert(manualPublications.length === 1, `expected one manual publication step, got ${manualPublications.length}`);
  assert(releasePublications.length === 1, `expected one production release publication step, got ${releasePublications.length}`);
  assert(unexpectedPublications.length === 0, 'publication is reachable outside the approved release and manual jobs');
  const runtimeGuards = manualJob.steps.filter((step) =>
    step.publishCommands.length === 0 && shellCommands(step.run).some((command) =>
      command.startsWith('node scripts/p12-publication-probe/check.mjs guard ') &&
      command.includes('--ref "${GITHUB_REF}"') &&
      command.includes('--mode "${P12_MODE}"'),
    ),
  );
  assert(runtimeGuards.length === 1, `expected one manual runtime guard step, got ${runtimeGuards.length}`);
  const publication = manualPublications[0];
  assert(publication.if === "inputs.mode == 'stage-publish'", 'manual publication mode guard drifted');
  assert(publication.command.includes('npm publish "${tarball_path}"'), 'manual publication must use the recorded tarball path');
  assert(publication.command.includes('--tag "${P12_DIST_TAG}"'), 'manual publication tag drifted');
  assert(publication.command.includes('--provenance'), 'manual publication provenance drifted');
  assert(!publication.command.includes('latest'), 'manual publication routes to latest');
  return {
    ...plan,
    publications,
    releasePublications,
    manualDispatchPublications: manualPublications,
  };
}

function checkWorkflowPlan(workflowArgument) {
  const workflowPath = workflowArgument === undefined
    ? resolve(repositoryRoot, '.github/workflows/publish.yml')
    : resolve(workflowArgument);
  const plan = validateWorkflowPlan(normalizeWorkflow(workflowPath));
  console.log(JSON.stringify(plan, null, 2));
}

function main() {
  const command = process.argv[2] ?? 'all';
  switch (command) {
    case 'guard':
      guard(option('--ref'), option('--mode'));
      break;
    case 'static':
      checkStatic();
      break;
    case 'packlist':
      checkStatic();
      checkPacklists();
      break;
    case 'changed-files':
      checkStatic();
      checkChangedFiles();
      break;
    case 'workflow-plan':
      checkStatic();
      checkWorkflowPlan(option('--workflow'));
      break;
    case 'all':
      guard(manifest.branchRef, 'dry-run');
      guard(manifest.branchRef, 'stage-publish');
      checkStatic();
      checkChangedFiles();
      checkWorkflowPlan();
      checkPacklists();
      break;
    default:
      fail(`Unknown P-12 check command ${command}.`, 64);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
