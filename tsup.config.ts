import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';
import {
  clientIdentityDefines,
  readPackageIdentity,
} from './scripts/build-identity.mjs';

const packageIdentity = readPackageIdentity(
  fileURLToPath(new URL('./package.json', import.meta.url)),
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // Build-time constants for the `X-Sigil-Client` header. `SIGIL_SOURCE_COMMIT`
  // is exported by the publish workflow after
  // `scripts/resolve-source-commit.mjs` has peeled the release tag and proven
  // the commit is an ancestor of `origin/main`, so the header names the exact
  // source commit npm published. Anything else (a local build, a fork) leaves it
  // unset, and the client identifier omits `commit` rather than guessing. Name
  // and version always come from package.json, so a release bump cannot drift
  // from the header. They are injected as literals: the published artifact never
  // reads the host process environment, and nothing at runtime discovers a
  // commit from git.
  define: clientIdentityDefines({
    ...packageIdentity,
    sourceCommit: process.env.SIGIL_SOURCE_COMMIT,
  }),
  outExtension({ format }) {
    return { js: format === 'esm' ? '.js' : '.cjs' };
  },
});
