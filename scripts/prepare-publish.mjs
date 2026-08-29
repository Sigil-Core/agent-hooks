/* eslint-env node */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
  RegistryRequestError,
  ReleaseVerificationError,
  VERIFY_DEADLINE_MS,
  readPackageDocument,
  verifyPublishedRelease,
  verifyRegistryWithRetry,
} from './verify-published-release.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

export class PreparePublishError extends Error {}

async function readPackageDocumentWithRetry(
  packageJson,
  {
    fetchImpl = fetch,
    now = () => performance.now(),
    sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    deadlineMs = VERIFY_DEADLINE_MS,
    deadlineAt = now() + deadlineMs,
    retryDelayMs = RETRY_DELAY_MS,
  } = {},
) {
  let lastError = new RegistryRequestError('no successful response', { transient: true });
  while (now() < deadlineAt) {
    const remaining = deadlineAt - now();
    try {
      const document = await readPackageDocument(packageJson, {
        fetchImpl,
        timeoutMs: Math.min(requestTimeoutMs, remaining),
      });
      const versions = document?.versions;
      if (
        document?.name !== packageJson.name
        || versions === null
        || typeof versions !== 'object'
        || Array.isArray(versions)
      ) {
        throw new RegistryRequestError('npm package document is malformed');
      }
      return document;
    } catch (error) {
      if (!(error instanceof RegistryRequestError) || !error.transient) throw error;
      lastError = error;
      const afterAttempt = deadlineAt - now();
      if (afterAttempt <= 0) break;
      await sleep(Math.min(retryDelayMs, afterAttempt));
    }
  }
  throw new PreparePublishError(
    `publication preparation exceeded ${deadlineMs} ms: ${lastError.message}`,
  );
}

export function buildArtifactManifest(packageJson, tarballPath) {
  const bytes = readFileSync(tarballPath);
  return {
    name: packageJson.name,
    version: packageJson.version,
    tarball: resolve(tarballPath),
    size: statSync(tarballPath).size,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export function packArtifact(
  packageJson,
  {
    pack = (args) => execFileSync('npm', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
    outputRoot,
  },
) {
  const directory = mkdtempSync(join(outputRoot, 'agent-hooks-pack-'));
  const report = (() => {
    try {
      return JSON.parse(pack(['pack', '--json', '--pack-destination', directory]));
    } catch {
      throw new PreparePublishError('npm pack did not return valid JSON');
    }
  })();
  if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== 'string') {
    throw new PreparePublishError('npm pack did not return exactly one artifact');
  }
  const tarball = resolve(directory, report[0].filename);
  if (!isAbsolute(tarball) || dirname(tarball) !== directory) {
    throw new PreparePublishError('npm pack returned an unsafe artifact path');
  }
  return buildArtifactManifest(packageJson, tarball);
}

export async function determinePublication(packageJson, artifact, options = {}) {
  const now = options.now ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? VERIFY_DEADLINE_MS;
  const deadlineAt = now() + deadlineMs;
  const packageDocument = await readPackageDocumentWithRetry(packageJson, {
    ...options,
    now,
    deadlineMs,
    deadlineAt,
  });
  const metadata = packageDocument?.versions?.[packageJson.version];
  if (metadata === undefined) {
    return { publishRequired: true, reason: 'version is absent from npm' };
  }
  try {
    verifyPublishedRelease(
      packageJson,
      metadata,
      artifact,
      packageDocument?.['dist-tags']?.latest,
    );
  } catch (error) {
    if (!(error instanceof ReleaseVerificationError) || !error.retryable) throw error;
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      throw new PreparePublishError(`publication preparation exceeded ${deadlineMs} ms`);
    }
    try {
      await verifyRegistryWithRetry(packageJson, artifact, {
        ...options,
        now,
        deadlineMs: remaining,
      });
    } catch (verificationError) {
      if (now() >= deadlineAt) {
        throw new PreparePublishError(
          `publication preparation exceeded ${deadlineMs} ms: ${verificationError.message}`,
        );
      }
      throw verificationError;
    }
  }
  return { publishRequired: false, reason: 'exact release already exists' };
}

function githubOutputValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export function writeGithubOutputs(outputPath, values) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new PreparePublishError('GITHUB_OUTPUT is required');
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${githubOutputValue(value)}`);
  writeFileSync(outputPath, `${lines.join('\n')}\n`, { flag: 'a' });
}

async function main() {
  if (typeof env.RELEASE_MANIFEST_PATH !== 'string' || env.RELEASE_MANIFEST_PATH.length === 0) {
    throw new PreparePublishError('RELEASE_MANIFEST_PATH is required');
  }
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const artifact = packArtifact(packageJson, { outputRoot: dirname(env.RELEASE_MANIFEST_PATH) });
  writeFileSync(env.RELEASE_MANIFEST_PATH, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  chmodSync(env.RELEASE_MANIFEST_PATH, 0o600);
  const decision = await determinePublication(packageJson, artifact);
  writeGithubOutputs(env.GITHUB_OUTPUT, {
    publish_required: decision.publishRequired,
    tarball: artifact.tarball,
    manifest: resolve(env.RELEASE_MANIFEST_PATH),
  });
  process.stdout.write(`${JSON.stringify({ ...decision, name: artifact.name, version: artifact.version })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`prepare-publish: ${error.message}\n`);
    process.exitCode = 1;
  });
}
