/* eslint-env node */
/**
 * The build identity injected into the published artifact for `X-Sigil-Client`.
 *
 * Shared by `tsup.config.ts`, which performs the real build, and by the test
 * suite, which proves the injected values still come from package.json rather
 * than from a hand-copied literal. Keeping one implementation means the build
 * and its drift proof cannot disagree.
 *
 * The values are injected as esbuild `define` literals on `process.env` keys so
 * that `src/client-identifier.ts` can use exact static property accesses in an
 * unbundled execution (where they are simply absent) while the published
 * artifact carries constants and never reads the host environment at all.
 */

import { readFileSync } from 'node:fs';

/**
 * Reads the package name and version the header must report.
 *
 * @param {string | URL} packageJsonPath
 * @returns {{name: string, version: string}}
 */
export function readPackageIdentity(packageJsonPath) {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const name = parsed?.name;
  const version = parsed?.version;
  if (
    typeof name !== 'string' || name.length === 0 ||
    typeof version !== 'string' || version.length === 0
  ) {
    throw new Error('package.json must declare a non-empty name and version.');
  }
  return { name, version };
}

/**
 * The `define` map for the client identity.
 *
 * An absent `sourceCommit` is injected as an empty string, which the client
 * identifier reads as "unavailable" and omits from the header. It is never
 * injected as a placeholder value.
 *
 * @param {{name: string, version: string, sourceCommit?: string}} identity
 * @returns {Record<string, string>}
 */
export function clientIdentityDefines({ name, version, sourceCommit }) {
  return {
    'process.env.SIGIL_PACKAGE_NAME': JSON.stringify(name),
    'process.env.SIGIL_PACKAGE_VERSION': JSON.stringify(version),
    'process.env.SIGIL_SOURCE_COMMIT': JSON.stringify(sourceCommit ?? ''),
  };
}
