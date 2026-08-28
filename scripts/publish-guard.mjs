/* eslint-env node */
/**
 * Static publication guard for @sigilcore/agent-hooks.
 *
 * Rewritten 2026-08-17 to parse the workflow with a real YAML parser and
 * assert against the resulting object model.
 *
 * The previous implementation matched regular expressions against the raw
 * workflow text. Three consecutive gating reviews found fifteen defects and
 * every high-severity one was the same mistake in a new place:
 *
 *   - the registry-URL escape terminated its character class early, escaped
 *     nothing, and let `https://registryXnpmjsYorg/` satisfy the assertion;
 *   - `includes('--provenance')` was satisfied by `--provenance=false`;
 *   - `/id-token:\s*write/` matched anywhere in the file, so a grant to any
 *     other job satisfied the publish job's requirement;
 *   - `job.if?.includes('workflow_dispatch')` classified a job whose
 *     condition also permitted `release` as manual;
 *   - the hand-rolled step reader could not handle block scalars with
 *     variable indentation, inline mappings, or anchors.
 *
 * Patching instances produced new instances, because text matching cannot see
 * structure. Parsing removes that entire class: block scalars, inline
 * mappings, quoting styles, key order, and anchors all normalise to the same
 * object, and every assertion below reads a resolved value rather than a
 * substring.
 *
 * What this guard does NOT promise, stated once and mirrored in
 * docs/architecture.md: it is a static control against drift and accident, not
 * against an authenticated attacker who can already edit the workflow. It
 * normalises backslash escapes and quote characters in shell commands, but it
 * does not resolve variable expansion, command substitution, `eval`, or
 * encoded payloads, and it is not a shell interpreter. The control against
 * that threat is review of the workflow diff, which is why
 * `.github/workflows/**` is a security-seam path.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

const expectedRepositoryUrl = 'git+https://github.com/Sigil-Core/agent-hooks.git';
const expectedRegistryUrl = 'https://registry.npmjs.org/';
const expectedReleaseInstallCommand =
  'npm install -g npm@11.17.0 --registry=https://registry.npmjs.org/';
const expectedReleaseCiCommand = 'npm ci --registry=https://registry.npmjs.org/';
const expectedEnvironment = 'npm-production';
const expectedStagedTag = 'fleet-phase6';
const expectedStagedCommand =
  `npm stage publish --access public --provenance --tag ${expectedStagedTag}`;
const expectedReleaseVerificationCommand = 'node scripts/verify-published-release.mjs';
const releaseCondition = "github.event_name == 'release'";
const dispatchCondition = "github.event_name == 'workflow_dispatch'";

export class GuardError extends Error {}

function assert(condition, message) {
  if (!condition) {
    throw new GuardError(message);
  }
}

/**
 * Normalise a shell command before matching publication verbs.
 *
 * Removes backslash escapes before word characters and strips quote
 * characters, so `n\pm publish`, `"npm" publish`, and `np''m publish` are all
 * seen as the command the shell would actually run. Bounded on purpose; see
 * the file header.
 */
export function normalizeShellCommand(command) {
  return command.replace(/\\(\w)/g, '$1').replace(/['"]/g, '');
}

/** Split a `run:` body into individual shell commands. */
export function shellCommands(run) {
  if (typeof run !== 'string') {
    return [];
  }
  return run
    .replace(/\\\s*\n/g, ' ')
    .split(/\r?\n|&&|\|\||;/)
    // Keep comments and quoting in the candidate. The publication boundary
    // requires one literal command, so discarding either before the exact
    // comparison could hide an operand or registry override.
    .map((command) => command.trim())
    .filter(Boolean);
}

/** True only when provenance is actually requested; `--provenance=false` is not. */
export function requestsProvenance(command) {
  if (/(^|\s)--provenance=(false|0)(\s|$)/i.test(command)) {
    return false;
  }
  return /(^|\s)--provenance(=(true|1))?(\s|$)/i.test(command);
}

/** Publication commands found in one `run:` body, normalised. */
export function publicationCommands(run) {
  const commands = [];
  for (const raw of shellCommands(run)) {
    const command = normalizeShellCommand(raw);
    const match = /\bnpm\s+(stage\s+)?publish(?:\s|$)/i.exec(command);
    if (!match) {
      continue;
    }
    const staged = match[1] !== undefined;
    const start = command.toLowerCase().indexOf(staged ? 'npm stage publish' : 'npm publish');
    commands.push({
      // The normalised form is what every downstream flag assertion reads, so
      // an escaped spelling cannot hide a missing --provenance either.
      command: command.slice(start).trim(),
      rawShellCommand: raw.trim(),
      shellCommand: command.trim(),
      kind: staged ? 'stage' : 'direct',
    });
  }
  return commands;
}

/**
 * Effective permissions for a job: its own block when present, else the
 * workflow-level block. Handles both mapping and inline forms because the
 * parser has already normalised them.
 */
export function effectivePermissions(workflow, job) {
  const permissions = job?.permissions ?? workflow?.permissions ?? {};
  return typeof permissions === 'object' && permissions !== null ? permissions : {};
}

/**
 * Steps of a job, rejecting an ambiguous step.
 *
 * A step declaring both `uses` and `run` is ambiguous: GitHub rejects it, and
 * a guard that silently tolerates it would let a publication command sit in a
 * step it never inspects. The pre-parser guard asserted this and the first
 * draft of the rewrite dropped it; the existing test caught the regression.
 */
function stepsOf(job, jobId) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const step of steps) {
    const hasUses = typeof step?.uses === 'string';
    const hasRun = typeof step?.run === 'string';
    assert(
      hasUses !== hasRun,
      `workflow job ${jobId} has a step that must declare exactly one of uses or run`,
    );
  }
  return steps;
}

/** Every publication command in a job, across all of its steps. */
function publicationsOf(job, jobId) {
  return stepsOf(job, jobId).flatMap((step) => {
    const stepCommandCount = shellCommands(step?.run).length;
    return publicationCommands(step?.run).map((publication) => ({
      ...publication,
      stepCommandCount,
    }));
  });
}

/** The `with.registry-url` of the setup-node step, resolved not matched. */
function registryUrlOf(job, jobId) {
  for (const step of stepsOf(job, jobId)) {
    const uses = typeof step?.uses === 'string' ? step.uses : '';
    if (!uses.startsWith('actions/setup-node')) {
      continue;
    }
    const value = step?.with?.['registry-url'];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** True when any parsed value in the tree mentions the given token name. */
function referencesToken(value, token) {
  if (typeof value === 'string') {
    return value.includes(token);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => referencesToken(entry, token));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => key.includes(token) || referencesToken(entry, token),
    );
  }
  return false;
}

function parseYamlOrThrow(source) {
  try {
    return parseYaml(source);
  } catch (error) {
    throw new GuardError(`workflow is not valid YAML: ${error.message}`);
  }
}

export function parseWorkflow(source) {
  const document = parseYamlOrThrow(source);
  assert(document !== null && typeof document === 'object', 'workflow is not a mapping');
  const jobs = document.jobs;
  assert(jobs !== null && typeof jobs === 'object', 'workflow jobs mapping is missing');
  const entries = Object.entries(jobs);
  assert(entries.length > 0, 'workflow has no jobs');
  return {
    raw: document,
    permissions: document.permissions,
    jobs: entries.map(([id, job]) => ({
      id,
      if: typeof job?.if === 'string' ? job.if.trim() : undefined,
      environment:
        typeof job?.environment === 'string' ? job.environment : job?.environment?.name,
      runner: job?.['runs-on'],
      permissions: job?.permissions,
      registryUrl: registryUrlOf(job, id),
      publications: publicationsOf(job, id),
      raw: job,
    })),
  };
}

export function validatePublishContract({ workflowSource, packageJson }) {
  assert(
    packageJson?.repository?.url === expectedRepositoryUrl,
    `package repository URL must be ${expectedRepositoryUrl}`,
  );
  assert(
    packageJson?.publishConfig?.provenance === true,
    'package publishConfig.provenance must be true',
  );

  const plan = parseWorkflow(workflowSource);

  assert(!referencesToken(plan.raw, 'NPM_TOKEN'), 'workflow must not reference NPM_TOKEN');

  // Select the production job from the plan rather than assuming an id.
  const release =
    plan.jobs.find((job) => job.if === releaseCondition) ??
    plan.jobs.find((job) => job.id === 'verify-release');
  assert(release !== undefined, 'workflow must define a release verification job');
  assert(release.if === releaseCondition, 'release verification job must be release-event only');
  assert(release.runner === 'ubuntu-latest', 'release verification job must use GitHub-hosted ubuntu-latest');
  assert(
    release.environment === undefined,
    'release verification job must not use the publishing environment',
  );

  const releasePermissions = effectivePermissions(plan.raw, release.raw);
  assert(
    releasePermissions['id-token'] !== 'write',
    'release verification job must not receive id-token: write',
  );
  assert(releasePermissions.contents === 'read', 'release verification job must be granted contents: read');
  assert(
    release.registryUrl === undefined,
    'release verification job must not configure a publishing registry',
  );

  const releaseSteps = stepsOf(release.raw, release.id);
  const npmInstallIndex = releaseSteps.findIndex(
    (step) => step.run?.trim() === expectedReleaseInstallCommand,
  );
  const installIndex = releaseSteps.findIndex(
    (step) => step.run?.trim() === expectedReleaseCiCommand,
  );
  const guardIndex = releaseSteps.findIndex(
    (step) => step.run?.trim() === 'npm run publish:guard',
  );
  assert(
    npmInstallIndex !== -1 && installIndex !== -1
      && guardIndex !== -1 && npmInstallIndex < installIndex && installIndex < guardIndex,
    'release verification job must pin npm install and npm ci to the public registry before npm run publish:guard',
  );
  assert(
    release.publications.length === 0,
    'release verification job must not publish a package',
  );
  assert(
    releaseSteps.filter((step) => step.run?.trim() === expectedReleaseVerificationCommand).length === 1,
    `release verification job must run exactly ${expectedReleaseVerificationCommand}`,
  );

  // A job is manual only when its condition permits workflow_dispatch and
  // nothing else. A mixed condition is rejected rather than sorted into a
  // bucket, because it would be judged under staged rules while still firing
  // on a release.
  const dispatchJobs = plan.jobs.filter((job) => job.if?.includes('workflow_dispatch'));
  for (const job of dispatchJobs) {
    assert(
      job.if === dispatchCondition,
      `job ${job.id} mixes workflow_dispatch with another event; split it into separate jobs`,
    );
  }

  assert(
    dispatchJobs.length === 1,
    'workflow must define exactly one workflow_dispatch staged publication job',
  );
  const stagedJob = dispatchJobs[0];
  assert(
    stagedJob.runner === 'ubuntu-latest',
    'workflow_dispatch publication must use GitHub-hosted ubuntu-latest',
  );
  assert(
    stagedJob.environment === expectedEnvironment,
    `workflow_dispatch publication must use the ${expectedEnvironment} environment`,
  );
  assert(
    stagedJob.registryUrl === expectedRegistryUrl,
    `workflow_dispatch publication must use registry ${expectedRegistryUrl}`,
  );
  const stagedPermissions = effectivePermissions(plan.raw, stagedJob.raw);
  assert(
    stagedPermissions['id-token'] === 'write',
    'workflow_dispatch publication must be granted id-token: write',
  );
  assert(
    stagedPermissions.contents === 'read',
    'workflow_dispatch publication must be granted contents: read',
  );
  const stagedSteps = stepsOf(stagedJob.raw, stagedJob.id);
  const stagedInstallIndex = stagedSteps.findIndex(
    (step) => step.run?.trim() === expectedReleaseCiCommand,
  );
  const stagedGuardIndex = stagedSteps.findIndex(
    (step) => step.run?.trim() === 'npm run publish:guard',
  );
  assert(
    stagedInstallIndex !== -1 && stagedGuardIndex !== -1 && stagedInstallIndex < stagedGuardIndex,
    'workflow_dispatch publication must run registry-pinned npm ci before npm run publish:guard',
  );

  const manualPublications = stagedJob.publications;
  assert(
    manualPublications.every((publication) => publication.kind === 'stage'),
    'workflow_dispatch publication must use npm stage publish',
  );
  assert(
    manualPublications.length === 1,
    'workflow_dispatch must expose exactly one staged publication command',
  );
  const staged = manualPublications[0];
  assert(
    /(^|\s)--access\s+public(\s|$)/.test(staged.command),
    'staged publication must set public access',
  );
  assert(requestsProvenance(staged.command), 'staged publication must request provenance');
  const stagedTags = [
    ...staged.command.matchAll(/(?:^|\s)--tag(?:=|\s+)([^\s]+)/g),
  ].map((match) => match[1]);
  assert(
    stagedTags.length === 1 && stagedTags[0] === expectedStagedTag,
    `staged publication must use exactly --tag ${expectedStagedTag}`,
  );
  assert(
    staged.stepCommandCount === 1
      && staged.rawShellCommand === expectedStagedCommand
      && staged.shellCommand === expectedStagedCommand,
    `staged publication command must be exactly ${expectedStagedCommand}`,
  );

  // No job outside the production and dispatch sets may publish at all.
  const accounted = new Set([release.id, ...dispatchJobs.map((job) => job.id)]);
  for (const job of plan.jobs) {
    if (accounted.has(job.id)) {
      continue;
    }
    assert(
      job.publications.length === 0,
      `job ${job.id} must not contain a publication command`,
    );
  }

  return {
    releaseJob: release.id,
    releaseVerification: expectedReleaseVerificationCommand,
    stagedPublications: manualPublications.map((publication) => publication.command),
  };
}

export function validatePublishContractFromFiles({ workflowPath, packagePath }) {
  return validatePublishContract({
    workflowSource: readFileSync(workflowPath, 'utf8'),
    packageJson: JSON.parse(readFileSync(packagePath, 'utf8')),
  });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const workflowPath = resolve(
    option('--workflow') ?? resolve(repositoryRoot, '.github/workflows/publish.yml'),
  );
  const packagePath = resolve(option('--package') ?? resolve(repositoryRoot, 'package.json'));
  try {
    const report = validatePublishContractFromFiles({ workflowPath, packagePath });
    process.stdout.write(`${JSON.stringify({ workflow: workflowPath, package: packagePath, ...report }, null, 2)}\n`);
  } catch (error) {
    if (error instanceof GuardError) {
      process.stderr.write(`publication guard: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
