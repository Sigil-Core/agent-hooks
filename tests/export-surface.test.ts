// tests/export-surface.test.ts
//
// Export-surface pins: readStrictJson and COWORK_TOOL_MANIFEST are supported
// package-root exports (the bundled plugin wrapper imports the reader, the
// documentation generator reads the manifest). These imports are made the way
// a consumer would — from the package index — and fail if either export
// disappears or changes shape.
import { describe, expect, it } from 'vitest';
// skipcq: JS-C1003 — the namespace import is deliberate: this test enumerates the
// package root export surface, which is exactly what a whole-namespace import verifies.
import * as pkg from '../src/index.js';

describe('package export surface', () => {
  it('exports readStrictJson as a function that parses raw bytes', () => {
    expect(typeof pkg.readStrictJson).toBe('function');
    const result = pkg.readStrictJson(new TextEncoder().encode('{"a":1}'));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
    const duplicate = pkg.readStrictJson('{"a":1,"a":2}');
    expect(duplicate).toMatchObject({ ok: false, error: 'duplicate_key' });
  });

  it('exports mapStrictJsonError with the published context split', () => {
    expect(pkg.mapStrictJsonError('oversize', 'stdin')).toBe(pkg.SIGIL_INPUT_TOO_LARGE);
    expect(pkg.mapStrictJsonError('oversize', 'response')).toBe(pkg.SIGIL_RESPONSE_INVALID);
  });

  it('exports COWORK_TOOL_MANIFEST as frozen data with the declared shape', () => {
    const manifest = pkg.COWORK_TOOL_MANIFEST;
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(typeof manifest.inventoryVersion).toBe('number');
    expect(manifest.inventoryVersion).toBeGreaterThanOrEqual(1);
    expect(Object.keys(manifest).sort()).toEqual([
      'actionMap',
      'inventory',
      'inventoryVersion',
    ]);
    for (const [name, entry] of Object.entries(manifest.inventory)) {
      expect(typeof name).toBe('string');
      expect(['governed', 'excluded']).toContain(entry.classification);
      expect(typeof entry.reason).toBe('string');
      if (entry.classification === 'governed') {
        expect(typeof entry.action).toBe('string');
      }
    }
    for (const [tool, action] of Object.entries(manifest.actionMap)) {
      expect(typeof tool).toBe('string');
      expect(typeof action).toBe('string');
    }
  });

  it('exports the Cowork adapter surface and error-code constants', () => {
    expect(typeof pkg.createCoworkPreToolUseHook).toBe('function');
    expect(typeof pkg.classifyCoworkTool).toBe('function');
    expect(typeof pkg.projectArguments).toBe('function');
    expect(typeof pkg.canonicalize).toBe('function');
    expect(typeof pkg.policyProjectionDigest).toBe('function');
    expect(typeof pkg.executionBindingDigest).toBe('function');
    expect(typeof pkg.clampCoworkTimeout).toBe('function');
    expect(pkg.SIGIL_CANON_VERSION).toBe('sigil-canon/1');
    for (const constant of [
      pkg.SIGIL_TOOL_UNCLASSIFIED,
      pkg.SIGIL_RESPONSE_INVALID,
      pkg.SIGIL_RATE_LIMITED,
      pkg.SIGIL_INPUT_OVERSIZE,
      pkg.SIGIL_INPUT_DUPLICATE_KEY,
      pkg.SIGIL_CONFIG_MISSING,
      pkg.SIGIL_HOOK_INTERNAL,
      pkg.SIGIL_HOOK_TIMEOUT,
      pkg.SIGIL_INPUT_MALFORMED,
      pkg.SIGIL_INPUT_TOO_LARGE,
      pkg.SIGIL_INPUT_ENCODING,
      pkg.SIGIL_INPUT_TIMEOUT,
      pkg.SIGIL_INPUT_ERROR,
    ]) {
      expect(typeof constant).toBe('string');
      expect(constant.startsWith('SIGIL_')).toBe(true);
    }
  });
});
