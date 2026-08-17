/* eslint-env node */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, '..');
export const expectedRepositoryUrl = 'git+https://github.com/Sigil-Core/agent-hooks.git';
export const expectedRegistryUrl = 'https://registry.npmjs.org/';

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function unquote(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const quote = value[0];
  return ((quote === "'" || quote === '"') && value.at(-1) === quote)
    ? value.slice(1, -1)
    : value;
}

function yamlValue(value) {
  return unquote(value?.replace(/\s+#.*$/, '').trim());
}

function stripShellComment(line) {
  return line.replace(/\s+#.*$/, '').trim();
}

export function shellCommands(run) {
  if (run === null || run === undefined) {
    return [];
  }
  return run
    .replace(/\\\s*\n/g, ' ')
    .split(/\r?\n|&&|\|\||;/)
    .map(stripShellComment)
    .filter(Boolean);
}

/**
 * Escape every regex metacharacter.
 *
 * The previous inline class was `[.*+?^${}()|[\\]\\]`, where `]` was left
 * unescaped, so the character class terminated early and the expression
 * escaped nothing at all. `https://registry.npmjs.org/` came back byte for
 * byte unchanged and its dots stayed live, which meant a lookalike such as
 * `https://registryXnpmjsYorg/` satisfied the registry assertion. Verified in
 * both directions before this fix landed.
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalise a shell command before matching publication verbs.
 *
 * A literal search for `npm publish` is defeated by spellings the shell
 * treats as identical: `n\pm publish`, `"npm" publish`, `np''m publish`. This
 * removes backslash escapes before word characters and strips unquoted quote
 * characters so those forms are caught.
 *
 * This is deliberately narrow. It does not interpret variable expansion,
 * command substitution, `eval`, base64 payloads, or `$IFS` tricks, and it is
 * not a shell parser. The guard is a static control against drift and
 * accident, not against an authenticated attacker who can already edit the
 * workflow. `docs/architecture.md` and `docs/publishing.md` state the same
 * bounded claim; keep all three in agreement.
 */
export function normalizeShellCommand(command) {
  return command.replace(/\\(\w)/g, '$1').replace(/['"]/g, '');
}

export function publicationCommands(run) {
  const commands = [];
  for (const command of shellCommands(run)) {
    const normalized = normalizeShellCommand(command);
    const match = /\bnpm\s+(stage\s+)?publish(?:\s|$).*$/i.exec(normalized);
    if (!match) {
      continue;
    }
    const staged = match[1] !== undefined;
    const start = normalized.toLowerCase().indexOf(staged ? 'npm stage publish' : 'npm publish');
    commands.push({
      // Report the normalised form: every downstream assertion inspects this
      // string for required flags, and an escaped spelling must not hide a
      // missing --provenance either.
      command: normalized.slice(start).trim(),
      kind: staged ? 'stage' : 'direct',
    });
  }
  return commands;
}

function field(lines, indent, name) {
  const prefix = `${' '.repeat(indent)}${name}:`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

function runBody(stepLines) {
  const runFirst = /^ {6}- run:\s*(.*)$/.exec(stepLines[0]);
  if (runFirst) {
    const inline = runFirst[1].trim();
    if (inline !== '' && !/^[>|][+-]?(?:\s+#.*)?$/.test(inline)) {
      return inline;
    }
    return stepLines
      .slice(1)
      .filter((line) => line.startsWith('          '))
      .map((line) => line.slice(10))
      .join('\n')
      .trim();
  }
  const runIndex = stepLines.findIndex((line) => /^ {8}run:\s*/.test(line));
  if (runIndex === -1) {
    return null;
  }
  const inline = stepLines[runIndex].slice('        run:'.length).trim();
  if (inline !== '' && !/^[>|][+-]?(?:\s+#.*)?$/.test(inline)) {
    return inline;
  }
  return stepLines
    .slice(runIndex + 1)
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n')
    .trim();
}

function parseStep(stepLines, jobId) {
  const first = stepLines[0].slice(8);
  const separator = first.indexOf(':');
  assert(separator !== -1, `workflow job ${jobId} contains a malformed step`);
  const firstKey = first.slice(0, separator);
  const firstValue = first.slice(separator + 1).trim();
  const run = runBody(stepLines);
  const uses = firstKey === 'uses' ? firstValue : field(stepLines, 8, 'uses');
  const ifCondition = firstKey === 'if' ? firstValue : field(stepLines, 8, 'if');
  assert(
    (run === null) !== (uses === null),
    `workflow job ${jobId} step ${firstKey} must declare exactly one of uses or run`,
  );
  return {
    name: firstKey === 'name' ? firstValue : field(stepLines, 8, 'name') ?? `${firstKey} step`,
    if: ifCondition,
    run,
    uses,
    persistCredentials: field(stepLines, 10, 'persist-credentials'),
    publications: publicationCommands(run),
  };
}

export function parseWorkflow(source) {
  const lines = source.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  assert(jobsIndex !== -1, 'workflow jobs mapping is missing');
  const starts = [];
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[index]);
    if (match) {
      starts.push({ id: match[1], index });
    }
  }
  assert(starts.length > 0, 'workflow has no jobs');

  return {
    jobs: starts.map((job, position) => {
      const end = starts[position + 1]?.index ?? lines.length;
      const jobLines = lines.slice(job.index + 1, end);
      const stepsIndex = jobLines.findIndex((line) => line === '    steps:');
      assert(stepsIndex !== -1, `workflow job ${job.id} has no steps`);
      const stepStarts = [];
      for (let index = stepsIndex + 1; index < jobLines.length; index += 1) {
        if (/^ {6}- /.test(jobLines[index])) {
          stepStarts.push(index);
        }
      }
      const steps = stepStarts.map((start, stepPosition) => {
        const stepEnd = stepStarts[stepPosition + 1] ?? jobLines.length;
        return parseStep(jobLines.slice(start, stepEnd), job.id);
      });
      const environmentValue = field(jobLines, 4, 'environment');
      const environment = environmentValue === ''
        ? unquote(field(jobLines, 6, 'name'))
        : unquote(environmentValue);
      return {
        id: job.id,
        if: unquote(field(jobLines, 4, 'if')),
        environment,
        runner: unquote(field(jobLines, 4, 'runs-on')),
        steps,
        publications: steps.flatMap((step) => step.publications.map((publication) => ({
          ...publication,
          job: job.id,
          step: step.name,
          if: step.if,
        }))),
      };
    }),
  };
}

function assertPackageContract(packagePath) {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert(
    packageJson.repository?.url === expectedRepositoryUrl,
    `package repository URL must be ${expectedRepositoryUrl}`,
  );
  assert(packageJson.publishConfig?.provenance === true, 'package publishConfig.provenance must be true');
  return packageJson;
}

export function validatePublishContract({ workflowSource, packageJson }) {
  assert(
    packageJson?.repository?.url === expectedRepositoryUrl,
    `package repository URL must be ${expectedRepositoryUrl}`,
  );
  assert(packageJson?.publishConfig?.provenance === true, 'package publishConfig.provenance must be true');
  assert(!/NPM_TOKEN/.test(workflowSource), 'workflow must not reference NPM_TOKEN');
  assert(/id-token:\s*write/.test(workflowSource), 'workflow must grant id-token: write');
  assert(/contents:\s*read/.test(workflowSource), 'workflow must grant contents: read');
  assert(
    new RegExp(`registry-url:\\s*${escapeRegExp(expectedRegistryUrl)}`).test(workflowSource),
    `workflow must use registry ${expectedRegistryUrl}`,
  );

  const plan = parseWorkflow(workflowSource);
  const production = plan.jobs.find((job) => job.id === 'publish' || job.id === 'production');
  assert(production !== undefined, 'workflow must define a publish job');
  assert(production.if === "github.event_name == 'release'", 'publish job must be release-event only');
  assert(production.runner === 'ubuntu-latest', 'publish job must use GitHub-hosted ubuntu-latest');
  assert(production.environment === 'npm-production', 'publish job must use the npm-production environment');
  assert(
    production.steps.some((step) => step.uses?.startsWith('actions/checkout@') &&
    yamlValue(step.persistCredentials) === 'false'),
    'publish job checkout must disable persisted credentials',
  );

  const productionPublications = production.publications;
  assert(
    productionPublications.length === 1,
    `publish job must contain exactly one publication command, got ${productionPublications.length}`,
  );
  const productionPublication = productionPublications[0];
  assert(productionPublication.kind === 'direct', 'production publish must use npm publish');
  assert(productionPublication.command.includes('--access public'), 'production publish must set public access');
  assert(productionPublication.command.includes('--provenance'), 'production publish must request provenance');

  // A job is manual only when its condition permits workflow_dispatch and
  // nothing else. Substring matching accepted a mixed condition such as
  // `github.event_name == 'workflow_dispatch' || github.event_name ==
  // 'release'`, which would be judged under the staged-publication rules while
  // still firing on a release. Mixed conditions are rejected outright rather
  // than sorted into one bucket.
  const dispatchJobs = plan.jobs.filter((job) => job.if?.includes('workflow_dispatch'));
  for (const job of dispatchJobs) {
    assert(
      job.if === "github.event_name == 'workflow_dispatch'",
      `job ${job.id} mixes workflow_dispatch with another event; split it into separate jobs`,
    );
  }
  const manualJobs = dispatchJobs;
  const manualPublications = manualJobs.flatMap((job) => job.publications);
  assert(
    manualPublications.every((publication) => publication.kind === 'stage'),
    'workflow_dispatch publication must use npm stage publish',
  );
  assert(manualPublications.length <= 1, 'workflow_dispatch must expose at most one staged publication command');
  if (manualPublications.length === 1) {
    const stagedPublication = manualPublications[0];
    assert(stagedPublication.command.includes('--provenance'), 'staged publication must request provenance');
    assert(/--tag\s+(['"]?)[^\s'"]+\1/.test(stagedPublication.command), 'staged publication must set a dist-tag');
    assert(!/(^|\s)--tag\s+(['"]?)latest\2(?:\s|$)/.test(stagedPublication.command), 'staged publication must not target latest');
  }

  const allowedJobs = new Set([production.id, ...manualJobs.map((job) => job.id)]);
  const allPublications = plan.jobs.flatMap((job) => job.publications);
  assert(
    allPublications.every((publication) => allowedJobs.has(publication.job)),
    'publication command is reachable from an unapproved workflow job',
  );
  return { ...plan, production, manualJobs, manualPublications };
}

export function validatePublishContractFromFiles({ workflowPath, packagePath }) {
  const workflowSource = readFileSync(workflowPath, 'utf8');
  const packageJson = assertPackageContract(packagePath);
  return validatePublishContract({ workflowSource, packageJson });
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const workflowPath = resolve(option('--workflow') ?? resolve(repositoryRoot, '.github/workflows/publish.yml'));
  const packagePath = resolve(option('--package') ?? resolve(repositoryRoot, 'package.json'));
  const plan = validatePublishContractFromFiles({ workflowPath, packagePath });
  console.log(JSON.stringify({
    workflow: workflowPath,
    package: packagePath,
    productionJob: plan.production.id,
    productionPublication: plan.production.publications[0].command,
    stagedPublications: plan.manualPublications.map((publication) => publication.command),
  }, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
