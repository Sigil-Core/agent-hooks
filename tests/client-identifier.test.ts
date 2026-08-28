// tests/client-identifier.test.ts
//
// Table-driven proof that `X-Sigil-Client` is built by one validating
// constructor. A value either passes the fixed grammar here or the build fails;
// nothing downstream can emit a malformed header by forgetting to check.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clientIdentityDefines,
  readPackageIdentity,
} from '../scripts/build-identity.mjs';
import {
  SIGIL_CLIENT_HEADER_GRAMMAR,
  SIGIL_CLIENT_HEADER_MAX_BYTES,
  SigilClientIdentifier,
  SigilClientIdentifierError,
  resolveClientIdentifier,
} from '../src/client-identifier.js';
import type { SigilClientIdentity } from '../src/client-identifier.js';

const packageJsonUrl = new URL('../package.json', import.meta.url);

const COMMIT = 'a'.repeat(40);

const IDENTITY_KEYS = [
  'SIGIL_PACKAGE_NAME',
  'SIGIL_PACKAGE_VERSION',
  'SIGIL_SOURCE_COMMIT',
] as const;

type IdentityKey = (typeof IDENTITY_KEYS)[number];

const asIdentity = (value: unknown): SigilClientIdentity => value as SigilClientIdentity;

const identityEnvironmentBefore = new Map<IdentityKey, string | undefined>();

beforeEach(() => {
  for (const key of IDENTITY_KEYS) {
    identityEnvironmentBefore.set(key, process.env[key]);
  }
});

/** Applies an identity environment and restores whatever preceded it. */
const withIdentity = async (
  values: Partial<Record<IdentityKey, string | undefined>>,
  run: () => Promise<void> | void,
): Promise<void> => {
  const previous = IDENTITY_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of IDENTITY_KEYS) {
      const value = values[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
};

describe('X-Sigil-Client grammar', () => {
  it('matches the documented fixed grammar', () => {
    expect(SIGIL_CLIENT_HEADER_GRAMMAR).toBe(
      'name=<package>; version=<semver>; commit=<40-hex>',
    );
    expect(SIGIL_CLIENT_HEADER_MAX_BYTES).toBe(256);
  });

  it.each([
    ['a bare name and version', { name: 'agent-hooks', version: '1.0.0' },
      'name=agent-hooks; version=1.0.0'],
    ['a scoped package name', { name: '@sigilcore/agent-hooks', version: '0.10.0' },
      'name=@sigilcore/agent-hooks; version=0.10.0'],
    ['a full identity with a commit', { name: 'agent-hooks', version: '1.2.3', commit: COMMIT },
      `name=agent-hooks; version=1.2.3; commit=${COMMIT}`],
    ['a prerelease and build metadata', {
      name: '@a/b',
      version: '1.0.0-rc.1+build.2',
      commit: '0'.repeat(40),
    }, 'name=@a/b; version=1.0.0-rc.1+build.2; commit=0000000000000000000000000000000000000000'],
  ])('emits %s with keys in order and exact separators', (_label, identity, expected) => {
    expect(new SigilClientIdentifier(asIdentity(identity)).headerValue).toBe(expected);
  });

  it('omits commit entirely when unavailable and never emits a placeholder', () => {
    const identifier = new SigilClientIdentifier({ name: 'agent-hooks', version: '1.0.0' });
    expect(identifier.commit).toBeUndefined();
    expect(identifier.headerValue).toBe('name=agent-hooks; version=1.0.0');
    expect(identifier.headerValue.includes('commit')).toBe(false);
    expect(identifier.headerValue.includes('unavailable')).toBe(false);
    expect(identifier.headerValue.endsWith(';')).toBe(false);
    expect(identifier.headerValue.endsWith('; ')).toBe(false);
  });

  it('carries the commit it validated', () => {
    const identifier = new SigilClientIdentifier({
      name: 'agent-hooks',
      version: '1.0.0',
      commit: COMMIT,
    });
    expect(identifier.commit).toBe(COMMIT);
    expect(identifier.headerValue.endsWith(`commit=${COMMIT}`)).toBe(true);
  });

  it('is frozen, so a validated value cannot be rewritten in place', () => {
    const identifier = new SigilClientIdentifier({ name: 'agent-hooks', version: '1.0.0' });
    expect(Object.isFrozen(identifier)).toBe(true);
    expect(() => {
      (identifier as unknown as { headerValue: string }).headerValue =
        'name=other; version=1.0.0';
    }).toThrow();
  });

  it.each([
    ['an empty name', { name: '', version: '1.0.0' }],
    ['a name with a separator', { name: 'agent;hooks', version: '1.0.0' }],
    ['a name with an equals sign', { name: 'agent=hooks', version: '1.0.0' }],
    ['a name with a comma', { name: 'agent,hooks', version: '1.0.0' }],
    ['a name with a space', { name: 'agent hooks', version: '1.0.0' }],
    ['a name with a newline', { name: 'agent\nhooks', version: '1.0.0' }],
    ['a quoted name', { name: '"agent"', version: '1.0.0' }],
    ['a non-string name', { name: 7, version: '1.0.0' }],
    ['a missing name', { version: '1.0.0' }],
    ['an empty version', { name: 'agent-hooks', version: '' }],
    ['a major-only version', { name: 'agent-hooks', version: '1' }],
    ['a two-part version', { name: 'agent-hooks', version: '1.2' }],
    ['a four-part version', { name: 'agent-hooks', version: '1.2.3.4' }],
    ['a v-prefixed version', { name: 'agent-hooks', version: 'v1.2.3' }],
    ['a leading-zero version', { name: 'agent-hooks', version: '01.2.3' }],
    ['a version with a separator', { name: 'agent-hooks', version: '1.2.3;x' }],
    ['a version with a space', { name: 'agent-hooks', version: '1.2.3 rc1' }],
    ['an unterminated prerelease', { name: 'agent-hooks', version: '1.2.3-' }],
    ['an unterminated build', { name: 'agent-hooks', version: '1.2.3+' }],
    ['a missing version', { name: 'agent-hooks' }],
    ['an uppercase commit', { name: 'agent-hooks', version: '1.0.0', commit: 'A'.repeat(40) }],
    ['a short commit', { name: 'agent-hooks', version: '1.0.0', commit: 'a'.repeat(39) }],
    ['a long commit', { name: 'agent-hooks', version: '1.0.0', commit: 'a'.repeat(41) }],
    ['a 0x-prefixed commit', { name: 'agent-hooks', version: '1.0.0', commit: `0x${'a'.repeat(38)}` }],
    ['a non-hex commit', { name: 'agent-hooks', version: '1.0.0', commit: `${'a'.repeat(39)}g` }],
    ['an empty commit', { name: 'agent-hooks', version: '1.0.0', commit: '' }],
    ['a null commit', { name: 'agent-hooks', version: '1.0.0', commit: null }],
  ])('throws before emission on %s', (_label, identity) => {
    expect(() => new SigilClientIdentifier(asIdentity(identity)))
      .toThrow(SigilClientIdentifierError);
  });

  it('accepts a value at exactly the byte cap and rejects one byte more', () => {
    // `name=` + name + `; version=` + `1.0.0` is 20 bytes plus the name length.
    const atCap = 'a'.repeat(SIGIL_CLIENT_HEADER_MAX_BYTES - 20);
    const identifier = new SigilClientIdentifier({ name: atCap, version: '1.0.0' });
    expect(identifier.headerValue).toHaveLength(SIGIL_CLIENT_HEADER_MAX_BYTES);

    expect(() => new SigilClientIdentifier({
      name: 'a'.repeat(SIGIL_CLIENT_HEADER_MAX_BYTES - 19),
      version: '1.0.0',
    })).toThrow(SigilClientIdentifierError);
  });

  it('counts a long commit against the same cap', () => {
    // `name=` (5) + name + `; version=` (10) + version (5) + `; commit=` (9) +
    // commit (40) is 69 bytes plus the name length.
    const name = 'a'.repeat(SIGIL_CLIENT_HEADER_MAX_BYTES - 69);
    const identity = { name, version: '1.0.0', commit: COMMIT };
    expect(new SigilClientIdentifier(identity).headerValue).toHaveLength(256);
    expect(() => new SigilClientIdentifier({
      name: `${name}a`,
      version: '1.0.0',
      commit: COMMIT,
    })).toThrow(SigilClientIdentifierError);
  });
});

describe('resolveClientIdentifier', () => {
  const PACKAGE_IDENTITY = {
    SIGIL_PACKAGE_NAME: '@sigilcore/agent-hooks',
    SIGIL_PACKAGE_VERSION: '0.10.0',
  };

  it('emits nothing when the build carries no package identity', async () => {
    await withIdentity({}, () => {
      expect(resolveClientIdentifier()).toBeUndefined();
    });
  });

  it('emits nothing when only a name is available', async () => {
    await withIdentity({ SIGIL_PACKAGE_NAME: PACKAGE_IDENTITY.SIGIL_PACKAGE_NAME }, () => {
      expect(resolveClientIdentifier()).toBeUndefined();
    });
  });

  it('resolves a full identity including the workflow commit', async () => {
    await withIdentity({ ...PACKAGE_IDENTITY, SIGIL_SOURCE_COMMIT: COMMIT }, () => {
      const identifier = resolveClientIdentifier();
      expect(identifier?.headerValue).toBe(
        `name=@sigilcore/agent-hooks; version=0.10.0; commit=${COMMIT}`,
      );
    });
  });

  it('treats an injected empty commit as unavailable, not as a placeholder', async () => {
    await withIdentity({ ...PACKAGE_IDENTITY, SIGIL_SOURCE_COMMIT: '' }, () => {
      const identifier = resolveClientIdentifier();
      expect(identifier?.commit).toBeUndefined();
      expect(identifier?.headerValue.includes('commit')).toBe(false);
    });
  });

  it('throws on a malformed injected commit rather than dropping it silently', async () => {
    await withIdentity({ ...PACKAGE_IDENTITY, SIGIL_SOURCE_COMMIT: 'not-a-commit' }, () => {
      expect(() => resolveClientIdentifier()).toThrow(SigilClientIdentifierError);
    });
  });

  it('leaves the host environment untouched afterwards', async () => {
    const before = IDENTITY_KEYS.map((key) => process.env[key]);
    await withIdentity({ ...PACKAGE_IDENTITY, SIGIL_SOURCE_COMMIT: COMMIT }, () => undefined);
    expect(IDENTITY_KEYS.map((key) => process.env[key])).toEqual(before);
  });
});

describe('the build injects the identity from package.json', () => {
  const identity = readPackageIdentity(packageJsonUrl);

  it('maps the package identity onto the build-time defines', () => {
    expect(clientIdentityDefines({ ...identity, sourceCommit: 'b'.repeat(40) })).toEqual({
      'process.env.SIGIL_PACKAGE_NAME': JSON.stringify(identity.name),
      'process.env.SIGIL_PACKAGE_VERSION': JSON.stringify(identity.version),
      'process.env.SIGIL_SOURCE_COMMIT': JSON.stringify('b'.repeat(40)),
    });
  });

  it('injects an empty commit when the workflow produced none', () => {
    expect(clientIdentityDefines(identity)['process.env.SIGIL_SOURCE_COMMIT']).toBe('""');
  });

  it('injects the same name and version the package declares', () => {
    // Guards the only hand-written fallback: the source (unbundled) execution
    // path reads these keys from the environment, so a drift between the
    // published literal and package.json would be invisible to every other test.
    expect(identity.name).toBe('@sigilcore/agent-hooks');
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

afterEach(() => {
  // Every case that sets an identity environment goes through withIdentity, so
  // a leaked value here would mean a test wrote to process.env directly.
  for (const key of IDENTITY_KEYS) {
    expect(process.env[key]).toBe(identityEnvironmentBefore.get(key));
  }
});
