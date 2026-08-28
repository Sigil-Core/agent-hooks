/* eslint-env node */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const packageIdentity = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const sourceCommit = process.env.SIGIL_SOURCE_COMMIT;
const expected = [
  `name=${packageIdentity.name}`,
  `version=${packageIdentity.version}`,
  ...(sourceCommit ? [`commit=${sourceCommit}`] : []),
].join('; ');

// A consumer's process environment must not be able to replace the identity
// embedded by the release build.
process.env.SIGIL_PACKAGE_NAME = 'attacker-package';
process.env.SIGIL_PACKAGE_VERSION = '9.9.9';
process.env.SIGIL_SOURCE_COMMIT = 'f'.repeat(40);

const esm = await import(new URL(`../dist/index.js?identity-check=${Date.now()}`, import.meta.url));
const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');

for (const [format, module] of [['esm', esm], ['cjs', cjs]]) {
  const actual = module.resolveClientIdentifier?.()?.headerValue;
  if (actual !== expected) {
    throw new Error(`${format} build identity mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

for (const artifact of ['../dist/index.js', '../dist/index.cjs']) {
  const source = readFileSync(new URL(artifact, import.meta.url), 'utf8');
  const consumerVersionMarker = `AGENT_HOOKS_VERSION = ${JSON.stringify(packageIdentity.version)}`;
  if (!source.includes(consumerVersionMarker)) {
    throw new Error(`${artifact} did not embed package.json's consumer telemetry version`);
  }
  if (source.includes('process.env[key]') || source.includes('SIGIL_PACKAGE_NAME') || source.includes('SIGIL_PACKAGE_VERSION')) {
    throw new Error(`${artifact} retained runtime-selectable package identity access`);
  }
}

console.log('Verified embedded ESM and CJS client identities.');
