import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = resolve(root, 'scripts/publish-guard.mjs');
const workflow = readFileSync(resolve(root, '.github/workflows/publish.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const docs = [
  readFileSync(resolve(root, 'docs/publishing.md'), 'utf8'),
  readFileSync(resolve(root, 'docs/architecture.md'), 'utf8'),
  readFileSync(resolve(root, 'runtime.md'), 'utf8'),
].join('\n');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const githubExpression = (body: string) => '$' + '{{ ' + body + ' }}'; // skipcq: JS-0096, JS-0246 - Construct GitHub syntax without a JavaScript interpolation token.
const publishCommand = ( // skipcq: JS-0246 - The GitHub expression is deliberately assembled as data.
  'npm publish "'
  + githubExpression('steps.release.outputs.tarball')
  + '" --access public --provenance --tag latest'
);

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
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `import * as guard from ${JSON.stringify(moduleUrl)};\n${source}`], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('direct OIDC publication guard', () => {
  it('accepts the release-only direct publication contract', () => {
    const result = runGuard();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).publication).toBe(publishCommand);
    expect(packageJson.publishConfig.provenance).toBe(true);
  });

  it('documents durable OIDC publishing and the immutable rollback rule', () => {
    expect(docs).toContain('npm trusted publisher');
    expect(docs).toContain('npm-production');
    expect(docs).toContain('latest');
    expect(docs).toContain('next patch');
    expect(docs).not.toContain('fleet-phase6');
    expect(docs).not.toContain('Production publication is stage-only');
    expect(readme).toContain(`@sigilcore/agent-hooks@${packageJson.version}`);
  });

  it('rejects manual, mixed, or extra triggers', () => {
    const manual = workflow.replace('on:\n  release:', 'on:\n  workflow_dispatch:\n  release:');
    expect(runGuard(manual).stderr).toContain('manual publication trigger');

    const push = workflow.replace('on:\n  release:', 'on:\n  push:\n  release:');
    expect(runGuard(push).stderr).toContain('trigger must be only release');
  });

  it('confines OIDC authority to the protected release job', () => {
    const noEnvironment = workflow.replace('    environment:\n      name: npm-production\n', '');
    expect(runGuard(noEnvironment).stderr).toContain('npm-production environment');

    const noOidc = workflow.replace('      id-token: write\n', '');
    expect(runGuard(noOidc).stderr).toContain('id-token: write');

    const selfHosted = workflow.replace('    runs-on: ubuntu-latest', '    runs-on: self-hosted');
    expect(runGuard(selfHosted).stderr).toContain('GitHub-hosted ubuntu-latest');

    const wrongRegistry = workflow.replace('registry-url: https://registry.npmjs.org/', 'registry-url: https://registry.example.invalid/');
    expect(runGuard(wrongRegistry).stderr).toContain('registry https://registry.npmjs.org/');

    const staleSetupNode = workflow.replace('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444');
    expect(runGuard(staleSetupNode).stderr).toContain('OIDC-safe commit pin');

    const cacheEnabled = workflow.replace('package-manager-cache: false', 'package-manager-cache: true');
    expect(runGuard(cacheEnabled).stderr).toContain('caching must be disabled');

    const secret = workflow.replace(
      '    runs-on: ubuntu-latest',
      '    env:\n      NPM_TOKEN: ' + githubExpression('secrets.NPM_TOKEN') + '\n    runs-on: ubuntu-latest', // skipcq: JS-0246 - The fixture must contain literal GitHub syntax.
    );
    expect(runGuard(secret).stderr).toContain('must not reference NPM_TOKEN');

    const registryOverride = workflow.replace('    runs-on: ubuntu-latest', '    env:\n      NPM_CONFIG_REGISTRY: https://registry.example.invalid/\n    runs-on: ubuntu-latest');
    expect(runGuard(registryOverride).stderr).toContain('NPM_CONFIG_REGISTRY');

    const continueOnError = workflow.replace('    runs-on: ubuntu-latest', '    continue-on-error: true\n    runs-on: ubuntu-latest');
    expect(runGuard(continueOnError).stderr).toContain('must not continue on error');
  });

  it('rejects additional publish-job permissions', () => {
    const extraPermission = workflow.replace(
      '      id-token: write',
      '      id-token: write\n      actions: write',
    );
    expect(runGuard(extraPermission).stderr).toContain(
      'permissions must be exactly contents: read and id-token: write',
    );
  });

  it('binds checkout and build identity to the release tag', () => {
    const wrongRef = workflow.replace('ref: ' + githubExpression('github.event.release.tag_name'), 'ref: main'); // skipcq: JS-0246 - The fixture must contain literal GitHub syntax.
    expect(runGuard(wrongRef).stderr).toContain('release.tag_name');

    const shallow = workflow.replace('fetch-depth: 0', 'fetch-depth: 1');
    expect(runGuard(shallow).stderr).toContain('full history');

    const missingIdentity = workflow.replace(
      'SIGIL_SOURCE_COMMIT: ' + githubExpression('steps.source_commit.outputs.source_commit'), // skipcq: JS-0246 - The fixture must contain literal GitHub syntax.
      'SIGIL_SOURCE_COMMIT: deadbeef',
    );
    expect(runGuard(missingIdentity).stderr).toContain('resolved source commit');
  });

  it('rejects a commented-out source resolver with a substituted commit', () => {
    const bypass = workflow.replace(
      '          commit="$(node scripts/resolve-source-commit.mjs)"',
      '          # node scripts/resolve-source-commit.mjs\n          commit="$(git rev-parse HEAD)"',
    );
    expect(runGuard(bypass).status).not.toBe(0);
    expect(runGuard(bypass).stderr).toContain('reviewed fail-closed resolver block');
  });

  it('rejects missing or reordered verification steps', () => {
    const removed = workflow.replace('      - run: npm test\n', '');
    expect(runGuard(removed).stderr).toContain('missing a required release step');

    const reversed = workflow.replace(
      '      - run: npm ci --registry=https://registry.npmjs.org/\n\n      - name: Verify trusted publication contract\n        run: npm run publish:guard',
      '      - name: Verify trusted publication contract\n        run: npm run publish:guard\n\n      - run: npm ci --registry=https://registry.npmjs.org/',
    );
    expect(runGuard(reversed).stderr).toContain('out of order');
  });

  it('rejects conditional release verification', () => {
    const conditional = workflow.replace(
      '      - name: Verify exact registry release\n        env:',
      '      - name: Verify exact registry release\n        if: false\n        env:',
    );
    expect(runGuard(conditional).stderr).toContain('mandatory release steps must be unconditional');
  });

  it('requires one visible exact direct publication command', () => {
    const duplicate = workflow.replace(
      '      - name: Publish immutable release with provenance',
      `      - name: Duplicate\n        run: ${publishCommand}\n\n      - name: Publish immutable release with provenance`,
    );
    expect(runGuard(duplicate).stderr).toContain('exactly one direct publication command');

    const staged = workflow.replace('npm publish', 'npm stage publish');
    expect(runGuard(staged).stderr).toContain('must not use npm stage publish');

    const noProvenance = workflow.replace('--provenance', '--provenance=false');
    expect(runGuard(noProvenance).stderr).toContain('publication command must be exactly');

    const wrongTag = workflow.replace('--tag latest', '--tag fleet-phase6');
    expect(runGuard(wrongTag).stderr).toContain('publication command must be exactly');

    const operand = workflow.replace(
      'npm publish "' + githubExpression('steps.release.outputs.tarball') + '"', // skipcq: JS-0246 - The fixture must contain literal GitHub syntax.
      'npm publish package.tgz',
    );
    expect(runGuard(operand).stderr).toContain('publication command must be exactly');

    const unconditional = workflow.replace("if: steps.release.outputs.publish_required == 'true'", 'if: always()');
    expect(runGuard(unconditional).stderr).toContain('only when prepare requests it');
  });

  it.each([
    ['backslash-escaped', 'n\\pm publish --access public'],
    ['shell-quoted', '\'"npm" publish --access public\''],
    ['split-quoted', '\'np\'\'\'\'m publish --access public\''],
  ])('detects a %s hidden publication command', (_label, spelling) => {
    const mutated = workflow.replace(
      '      - name: Publish immutable release with provenance',
      `      - name: Hidden publication\n        run: |\n          ${spelling}\n\n      - name: Publish immutable release with provenance`,
    );
    expect(runGuard(mutated).stderr).toContain('exactly one direct publication command');
  });

  it('rejects ambiguous steps and malformed YAML', () => {
    const ambiguous = workflow.replace(
      '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5',
      '      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5\n        run: echo invalid',
    );
    const result = evaluate(`guard.parseWorkflow(${JSON.stringify(ambiguous)});`);
    expect(result.status).toBe(0);
    expect(runGuard(ambiguous).stderr).toContain('exactly one of uses or run');
    expect(runGuard('jobs:\n  publish:\n    bad: [unclosed\n').status).not.toBe(0);
  });
});
