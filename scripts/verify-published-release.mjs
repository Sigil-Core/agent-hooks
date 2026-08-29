/* eslint-env node */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
export const REGISTRY_URL = 'https://registry.npmjs.org/';
export const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
export const REQUEST_TIMEOUT_MS = 15_000;
export const VERIFY_DEADLINE_MS = 180_000;
export const RETRY_DELAY_MS = 2_000;

export class RegistryRequestError extends Error {
  constructor(message, { status, transient = false } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export class ReleaseVerificationError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function isCanonicalSha512Integrity(value) {
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(value ?? '');
  if (match === null) return false;
  const digest = Buffer.from(match[1], 'base64');
  return digest.length === 64 && digest.toString('base64') === match[1];
}

function isTransientStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

function packagePath(name) {
  return name.replace('/', '%2f');
}

export function validateArtifactManifest(packageJson, artifact) {
  if (artifact?.name !== packageJson?.name || artifact?.version !== packageJson?.version) {
    throw new ReleaseVerificationError('artifact manifest does not match package.json');
  }
  if (!/^[0-9a-f]{40}$/.test(artifact?.shasum ?? '')) {
    throw new ReleaseVerificationError('artifact manifest has an invalid sha1 shasum');
  }
  if (!isCanonicalSha512Integrity(artifact?.integrity)) {
    throw new ReleaseVerificationError('artifact manifest has an invalid sha512 integrity');
  }
  if (typeof artifact?.tarball !== 'string' || artifact.tarball.length === 0) {
    throw new ReleaseVerificationError('artifact manifest has no tarball path');
  }
  return artifact;
}

export function verifyPublishedRelease(packageJson, metadata, artifact, latestVersion) {
  validateArtifactManifest(packageJson, artifact);
  if (metadata?.name !== packageJson.name || metadata?.version !== packageJson.version) {
    throw new ReleaseVerificationError(`registry metadata does not match ${packageJson.name}@${packageJson.version}`);
  }
  if (metadata?.repository?.url !== packageJson?.repository?.url) {
    throw new ReleaseVerificationError('published package repository does not match package.json');
  }
  if (metadata?.dist?.shasum !== artifact.shasum) {
    throw new ReleaseVerificationError('published package sha1 does not match the prepared tarball');
  }
  if (metadata?.dist?.integrity !== artifact.integrity) {
    throw new ReleaseVerificationError('published package sha512 does not match the prepared tarball');
  }
  const expectedAttestationUrl =
    `${REGISTRY_URL}-/npm/v1/attestations/${packagePath(packageJson.name)}@${packageJson.version}`;
  if (metadata?.dist?.attestations?.url !== expectedAttestationUrl) {
    throw new ReleaseVerificationError('published package attestation is not yet available', { retryable: true });
  }
  if (metadata?.dist?.attestations?.provenance?.predicateType !== PREDICATE_TYPE) {
    throw new ReleaseVerificationError('published package SLSA provenance is not yet available', { retryable: true });
  }
  if (latestVersion !== packageJson.version) {
    throw new ReleaseVerificationError('latest dist-tag does not yet resolve to the release version', { retryable: true });
  }
  return {
    name: metadata.name,
    version: metadata.version,
    shasum: metadata.dist.shasum,
    integrity: metadata.dist.integrity,
    provenance: PREDICATE_TYPE,
    latest: latestVersion,
  };
}

async function responseJson(response, description) {
  if (!response.ok) {
    throw new RegistryRequestError(`${description} returned HTTP ${response.status}`, {
      status: response.status,
      transient: isTransientStatus(response.status),
    });
  }
  try {
    return await response.json();
  } catch {
    throw new RegistryRequestError(`${description} returned invalid JSON`, { transient: true });
  }
}

export async function fetchJson(url, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    return await responseJson(response, url);
  } catch (error) {
    if (error instanceof RegistryRequestError) throw error;
    const timedOut = error?.name === 'AbortError';
    throw new RegistryRequestError(
      timedOut ? `registry request exceeded ${timeoutMs} ms` : 'registry request failed',
      { transient: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function readRegistryState(packageJson, options = {}) {
  const encoded = packagePath(packageJson.name);
  const metadata = await fetchJson(
    `${REGISTRY_URL}${encoded}/${packageJson.version}`,
    options,
  );
  const packageDocument = await readPackageDocument(packageJson, options);
  return { metadata, latestVersion: packageDocument?.['dist-tags']?.latest };
}

export function readPackageDocument(packageJson, options = {}) {
  return fetchJson(`${REGISTRY_URL}${packagePath(packageJson.name)}`, options);
}

export async function verifyRegistryWithRetry(
  packageJson,
  artifact,
  {
    fetchImpl = fetch,
    now = () => performance.now(),
    sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    deadlineMs = VERIFY_DEADLINE_MS,
    retryDelayMs = RETRY_DELAY_MS,
  } = {},
) {
  const startedAt = now();
  let lastError = new ReleaseVerificationError('no successful response');
  while (now() - startedAt < deadlineMs) {
    const remaining = deadlineMs - (now() - startedAt);
    try {
      const state = await readRegistryState(packageJson, {
        fetchImpl,
        timeoutMs: Math.min(requestTimeoutMs, remaining),
      });
      return verifyPublishedRelease(packageJson, state.metadata, artifact, state.latestVersion);
    } catch (error) {
      const retryable = error instanceof RegistryRequestError
        ? error.transient
        : error instanceof ReleaseVerificationError && error.retryable;
      if (!retryable) throw error;
      lastError = error;
      const afterAttempt = deadlineMs - (now() - startedAt);
      if (afterAttempt <= 0) break;
      await sleep(Math.min(retryDelayMs, afterAttempt));
    }
  }
  throw new ReleaseVerificationError(
    `registry verification exceeded ${deadlineMs} ms: ${lastError.message}`,
  );
}

async function main() {
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  if (typeof env.RELEASE_MANIFEST_PATH !== 'string' || env.RELEASE_MANIFEST_PATH.length === 0) {
    throw new ReleaseVerificationError('RELEASE_MANIFEST_PATH is required');
  }
  const artifact = JSON.parse(readFileSync(env.RELEASE_MANIFEST_PATH, 'utf8'));
  const verified = await verifyRegistryWithRetry(packageJson, artifact);
  process.stdout.write(`${JSON.stringify(verified)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`verify-published-release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
