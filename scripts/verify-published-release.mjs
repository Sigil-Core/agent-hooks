/* eslint-env node */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const expectedPredicateType = 'https://slsa.dev/provenance/v1';
const expectedRegistryUrl = 'https://registry.npmjs.org/';

function isCanonicalSha512Integrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(value ?? '');
  if (match === null) return false;
  const digest = Buffer.from(match[1], 'base64');
  return digest.length === 64 && digest.toString('base64') === match[1];
}

export function verifyPublishedRelease(packageJson, metadata) {
  if (metadata?.name !== packageJson.name || metadata?.version !== packageJson.version) {
    throw new Error(`registry metadata does not match ${packageJson.name}@${packageJson.version}`);
  }
  if (metadata?.repository?.url !== packageJson?.repository?.url) {
    throw new Error('published package repository does not match package.json');
  }
  if (!isCanonicalSha512Integrity(metadata?.dist?.integrity)) {
    throw new Error('published package is missing sha512 integrity');
  }
  const expectedAttestationUrl =
    `${expectedRegistryUrl}-/npm/v1/attestations/${packageJson.name.replace('/', '%2f')}@${packageJson.version}`;
  if (metadata?.dist?.attestations?.url !== expectedAttestationUrl) {
    throw new Error('published package attestation URL does not match the package identity');
  }
  if (metadata?.dist?.attestations?.provenance?.predicateType !== expectedPredicateType) {
    throw new Error('published package is missing SLSA provenance');
  }
  return {
    name: metadata.name,
    version: metadata.version,
    integrity: metadata.dist.integrity,
    provenance: expectedPredicateType,
  };
}

function main() {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const packageSpec = `${packageJson.name}@${packageJson.version}`;
  const metadata = JSON.parse(execFileSync(
    'npm',
    ['view', packageSpec, '--json', `--registry=${expectedRegistryUrl}`],
    { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ));
  const verified = verifyPublishedRelease(packageJson, metadata);
  process.stdout.write(`${JSON.stringify(verified)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
