/* eslint-env node */
/** Static, fail-closed guard for the direct npm OIDC release workflow. */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

const EXPECTED_REPOSITORY = 'git+https://github.com/Sigil-Core/agent-hooks.git';
const EXPECTED_REGISTRY = 'https://registry.npmjs.org/';
const EXPECTED_ENVIRONMENT = 'npm-production';
const EXPECTED_JOB_CONDITION = "github.event_name == 'release'";
const githubExpression = (body) => '$' + '{{ ' + body + ' }}'; // skipcq: JS-0096, JS-0246 - Construct GitHub syntax without a JavaScript interpolation token.
const EXPECTED_CHECKOUT_REF = githubExpression('github.event.release.tag_name');
const EXPECTED_CHECKOUT = 'actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd';
const EXPECTED_SETUP_NODE = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const EXPECTED_INSTALL = 'npm install -g npm@11.17.0 --registry=https://registry.npmjs.org/';
const EXPECTED_CI = 'npm ci --registry=https://registry.npmjs.org/';
const EXPECTED_GUARD = 'npm run publish:guard';
const EXPECTED_RESOLVER_RUN = [
  'set -euo pipefail',
  'commit="$(node scripts/resolve-source-commit.mjs)"',
  'if [ -z "${commit}" ]; then', // skipcq: JS-0038 - This must remain literal shell parameter expansion.
  '  echo "resolve-source-commit: produced no commit" >&2',
  '  exit 1',
  'fi',
  'echo "source_commit=${commit}" >> "${GITHUB_OUTPUT}"', // skipcq: JS-0038 - These must remain literal shell parameter expansions.
].join('\n');
const EXPECTED_PREPARE = 'node scripts/prepare-publish.mjs';
const EXPECTED_PUBLISH = (
  'npm publish "' // skipcq: JS-0246 - The GitHub expression is deliberately assembled as data.
  + githubExpression('steps.release.outputs.tarball')
  + '" --access public --provenance --tag latest'
);
const EXPECTED_PUBLISH_CONDITION = "steps.release.outputs.publish_required == 'true'";
const EXPECTED_VERIFY = 'node scripts/verify-published-release.mjs';

export class GuardError extends Error {}

function assert(condition, message) {
  if (!condition) throw new GuardError(message);
}

export function normalizeShellCommand(command) {
  return command.replace(/\\(\w)/g, '$1').replace(/['"]/g, '');
}

export function shellCommands(run) {
  if (typeof run !== 'string') return [];
  return run
    .replace(/\\\s*\n/g, ' ')
    .split(/\r?\n|&&|\|\||;/)
    .map((command) => command.trim())
    .filter(Boolean);
}

export function requestsProvenance(command) {
  if (/(^|\s)--provenance=(false|0)(\s|$)/i.test(command)) return false;
  return /(^|\s)--provenance(=(true|1))?(\s|$)/i.test(command);
}

export function publicationCommands(run) {
  const matches = [];
  for (const raw of shellCommands(run)) {
    const normalized = normalizeShellCommand(raw);
    const match = /\bnpm\s+(stage\s+)?publish(?:\s|$)/i.exec(normalized);
    if (match === null) continue;
    const kind = match[1] === undefined ? 'direct' : 'stage';
    matches.push({
      kind,
      rawShellCommand: raw,
      shellCommand: normalized,
      command: normalized.slice(match.index).trim(),
    });
  }
  return matches;
}

function parseYamlOrThrow(source) {
  try {
    return parseYaml(source);
  } catch (error) {
    throw new GuardError(`workflow is not valid YAML: ${error.message}`);
  }
}

function stepsOf(job, jobId) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  for (const step of steps) {
    const hasUses = typeof step?.uses === 'string';
    const hasRun = typeof step?.run === 'string';
    assert(hasUses !== hasRun, `workflow job ${jobId} has a step that must declare exactly one of uses or run`);
  }
  return steps;
}

function effectivePermissions(workflow, job) {
  const value = job?.permissions ?? workflow?.permissions ?? {};
  return value !== null && typeof value === 'object' ? value : {};
}

function referencesToken(value, token) {
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some((entry) => referencesToken(entry, token));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => key.includes(token) || referencesToken(entry, token));
  }
  return false;
}

function runIndex(steps, exact) {
  return steps.findIndex((step) => step?.run?.trim() === exact);
}

function usesStep(steps, prefix) {
  return steps.find((step) => typeof step?.uses === 'string' && step.uses.startsWith(prefix));
}

export function parseWorkflow(source) {
  const raw = parseYamlOrThrow(source);
  assert(raw !== null && typeof raw === 'object', 'workflow is not a mapping');
  assert(raw.jobs !== null && typeof raw.jobs === 'object', 'workflow jobs mapping is missing');
  return { raw, jobs: Object.entries(raw.jobs).map(([id, job]) => ({ id, raw: job })) };
}

export function validatePublishContract({ workflowSource, packageJson }) {
  assert(packageJson?.repository?.url === EXPECTED_REPOSITORY, `package repository URL must be ${EXPECTED_REPOSITORY}`);
  assert(packageJson?.publishConfig?.provenance === true, 'package publishConfig.provenance must be true');
  assert(
    packageJson?.publishConfig?.registry === undefined
      || packageJson.publishConfig.registry === EXPECTED_REGISTRY,
    `package publishConfig.registry must be ${EXPECTED_REGISTRY} when set`,
  );

  const plan = parseWorkflow(workflowSource);
  assert(!referencesToken(plan.raw, 'NPM_TOKEN'), 'workflow must not reference NPM_TOKEN');
  for (const forbidden of [
    'NODE_AUTH_TOKEN',
    'NPM_CONFIG_ACCESS',
    'NPM_CONFIG_PROVENANCE',
    'NPM_CONFIG_REGISTRY',
    'NPM_CONFIG_TAG',
  ]) {
    assert(!referencesToken(plan.raw, forbidden), `workflow must not reference ${forbidden}`);
  }
  assert(!referencesToken(plan.raw, 'workflow_dispatch'), 'workflow must not expose a manual publication trigger');
  assert(
    plan.raw.on !== null && typeof plan.raw.on === 'object'
      && Object.keys(plan.raw.on).length === 1
      && Array.isArray(plan.raw.on.release?.types)
      && plan.raw.on.release.types.length === 1
      && plan.raw.on.release.types[0] === 'published',
    'workflow trigger must be only release: published',
  );
  assert(plan.jobs.length === 1, 'workflow must define exactly one job');

  const job = plan.jobs[0];
  assert(job.id === 'publish-release', 'workflow job must be publish-release');
  assert(job.raw?.if === EXPECTED_JOB_CONDITION, 'publish job must be release-event only');
  assert(job.raw?.['runs-on'] === 'ubuntu-latest', 'publish job must use GitHub-hosted ubuntu-latest');
  assert(job.raw?.['continue-on-error'] !== true, 'publish job must not continue on error');
  const environment = typeof job.raw?.environment === 'string' ? job.raw.environment : job.raw?.environment?.name;
  assert(environment === EXPECTED_ENVIRONMENT, `publish job must use the ${EXPECTED_ENVIRONMENT} environment`);

  const permissions = effectivePermissions(plan.raw, job.raw);
  assert(
    Object.keys(permissions).length === 2
      && permissions.contents === 'read'
      && permissions['id-token'] === 'write',
    'publish job permissions must be exactly contents: read and id-token: write',
  );

  const steps = stepsOf(job.raw, job.id);
  assert(
    steps.every((step) => step?.['continue-on-error'] !== true),
    'publish steps must not continue on error',
  );
  const checkout = usesStep(steps, 'actions/checkout@');
  assert(checkout !== undefined, 'publish job must check out the release tag');
  assert(checkout?.uses === EXPECTED_CHECKOUT, 'checkout action must use the reviewed commit pin');
  assert(checkout?.with?.ref === EXPECTED_CHECKOUT_REF, 'checkout must bind to github.event.release.tag_name');
  assert(checkout?.with?.['fetch-depth'] === 0, 'checkout must fetch full history');
  assert(checkout?.with?.['fetch-tags'] === true, 'checkout must fetch tags');
  assert(checkout?.with?.['persist-credentials'] === false, 'checkout must not persist GitHub credentials');

  const setupNode = usesStep(steps, 'actions/setup-node@');
  assert(setupNode?.uses === EXPECTED_SETUP_NODE, 'setup-node action must use the reviewed OIDC-safe commit pin');
  assert(setupNode?.with?.['registry-url'] === EXPECTED_REGISTRY, `publish job must use registry ${EXPECTED_REGISTRY}`);
  assert(setupNode?.with?.['package-manager-cache'] === false, 'setup-node package-manager caching must be disabled');

  const installIndex = runIndex(steps, EXPECTED_INSTALL);
  const ciIndex = runIndex(steps, EXPECTED_CI);
  const guardIndex = runIndex(steps, EXPECTED_GUARD);
  const resolverIndex = steps.findIndex((step) => step?.id === 'source_commit');
  const typecheckIndex = runIndex(steps, 'npm run typecheck');
  const lintIndex = runIndex(steps, 'npm run lint');
  const testIndex = runIndex(steps, 'npm test');
  const buildIndex = runIndex(steps, 'npm run build');
  const prepareIndex = runIndex(steps, EXPECTED_PREPARE);
  const verifyIndex = runIndex(steps, EXPECTED_VERIFY);
  assert(
    [installIndex, ciIndex, guardIndex, resolverIndex, typecheckIndex, lintIndex, testIndex, buildIndex, prepareIndex, verifyIndex]
      .every((index) => index >= 0),
    'publish job is missing a required release step',
  );
  assert(
    installIndex < ciIndex && ciIndex < guardIndex && guardIndex < resolverIndex
      && resolverIndex < typecheckIndex && typecheckIndex < lintIndex && lintIndex < testIndex
      && testIndex < buildIndex && buildIndex < prepareIndex && prepareIndex < verifyIndex,
    'publish job release steps are out of order',
  );
  assert(
    [installIndex, ciIndex, guardIndex, resolverIndex, typecheckIndex, lintIndex, testIndex, buildIndex, prepareIndex, verifyIndex]
      .every((index) => steps[index]?.if === undefined),
    'mandatory release steps must be unconditional',
  );

  const resolverStep = steps[resolverIndex];
  assert(
    resolverStep?.run?.trim() === EXPECTED_RESOLVER_RUN,
    'source resolver step must execute the reviewed fail-closed resolver block',
  );
  const buildStep = steps[buildIndex];
  assert(buildStep?.env?.SIGIL_SOURCE_COMMIT === githubExpression('steps.source_commit.outputs.source_commit'), 'build must receive the resolved source commit');

  const prepareStep = steps[prepareIndex];
  assert(prepareStep?.id === 'release', 'prepare step must expose release outputs');
  assert(prepareStep?.env?.RELEASE_MANIFEST_PATH === githubExpression('runner.temp') + '/sigil-agent-hooks-release.json', 'prepare step must use the runner-temporary manifest'); // skipcq: JS-0246 - The exact workflow expression must remain data.

  const publications = steps.flatMap((step, stepIndex) => publicationCommands(step?.run).map((entry) => ({ ...entry, step, stepIndex })));
  assert(publications.every((entry) => entry.kind === 'direct'), 'workflow must not use npm stage publish');
  assert(publications.length === 1, 'workflow must expose exactly one direct publication command');
  const publication = publications[0];
  assert(publication.rawShellCommand === EXPECTED_PUBLISH, `publication command must be exactly ${EXPECTED_PUBLISH}`);
  assert(publication.step?.if === EXPECTED_PUBLISH_CONDITION, 'publication must run only when prepare requests it');
  assert(publication.stepIndex > prepareIndex && publication.stepIndex < verifyIndex, 'publication must run between prepare and verification');
  assert(requestsProvenance(publication.command), 'publication must request provenance');
  assert(/(^|\s)--access\s+public(\s|$)/.test(publication.command), 'publication must set public access');
  assert(/(^|\s)--tag\s+latest(\s|$)/.test(publication.command), 'publication must use the latest tag');

  const verifyStep = steps[verifyIndex];
  assert(verifyStep?.env?.RELEASE_MANIFEST_PATH === githubExpression('steps.release.outputs.manifest'), 'verification must consume the exact prepared manifest');

  return { job: job.id, publication: publication.rawShellCommand, verification: EXPECTED_VERIFY };
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
  const workflowPath = resolve(option('--workflow') ?? resolve(repositoryRoot, '.github/workflows/publish.yml'));
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
