import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../dist/index.cjs', import.meta.url), 'utf8');
if (/require\(["']@sigilcore\/warrant-core["']\)/u.test(source)) {
  throw new Error('CJS bundle statically requires import-only Warrant Core.');
}
if (!/import\(["']@sigilcore\/warrant-core["']\)/u.test(source)) {
  throw new Error('CJS bundle does not preserve native Warrant Core import().');
}

const hooks = require('../dist/index.cjs');
if (typeof hooks.verifyResponsePolicyAuthorization !== 'function') {
  throw new Error('CJS verifier export is missing.');
}

const adapter = {
  sha256: async () => new Uint8Array(32),
  verifyEd25519: async () => false,
};
const authorization = {
  compactJws: 'a.b.c',
  compiledPolicyDigest: '0'.repeat(64),
  envelopeDigest: '0'.repeat(64),
};
const context = {
  publicKey: new Uint8Array(32),
  issuer: 'https://sign.invalid',
  keyId: 'invalid',
  tenantId: 'invalid',
  taskId: 'invalid',
  policyHash: '0'.repeat(64),
  revocationEpoch: 0,
  deterministicRulesetDigest: '0'.repeat(64),
  classCatalogDigest: '0'.repeat(64),
  now: 0,
};

try {
  await hooks.verifyResponsePolicyAuthorization(adapter, authorization, context);
  throw new Error('Malformed verification fixture unexpectedly passed.');
} catch (error) {
  if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  if (!String(error?.message).includes('protected header')) throw error;
}

process.stdout.write('CJS_WARRANT_CORE_DYNAMIC_IMPORT_OK\n');
