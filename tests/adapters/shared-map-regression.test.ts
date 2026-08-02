// tests/adapters/shared-map-regression.test.ts
//
// Shared-map non-regression suite. The baseline is the committed canonical
// serialization of TOOL_ACTION_MAP as it existed at tag v0.5.3, generated once
// from the tag — never a live import of the map itself, which would be
// tautological. This is what makes 0.7.0 provably a true minor release: no
// existing adapter's action names move on upgrade.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_ACTION_MAP, mapToolAction } from '../../src/adapters/shared.js';
import { createCodexPreToolUseHook } from '../../src/adapters/codex.js';
import type { SigilHookConfig } from '../../src/types.js';

const FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/tool-action-map-0.5.3.json');

interface SharedMapFixture {
  tag: string;
  sharedTsSha256: string;
  toolActionMapCanonical: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as SharedMapFixture;

const canonicalSerialization = (map: Record<string, string>): string => {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    sorted[key] = map[key] as string;
  }
  return JSON.stringify(sorted);
};

describe('shared TOOL_ACTION_MAP non-regression against the v0.5.3 baseline', () => {
  it('the current map canonically serializes to the committed v0.5.3 fixture', () => {
    expect(fixture.tag).toBe('v0.5.3');
    expect(canonicalSerialization(TOOL_ACTION_MAP)).toBe(fixture.toolActionMapCanonical);
  });

  it('src/adapters/shared.ts is byte-identical to its v0.5.3 state', () => {
    const current = createHash('sha256')
      .update(readFileSync(resolve(process.cwd(), 'src/adapters/shared.ts')))
      .digest('hex');
    expect(current).toBe(fixture.sharedTsSha256);
  });

  it('Read, Glob, Grep, and Agent still fall through to their lowercase names', () => {
    expect(mapToolAction('Read')).toBe('read');
    expect(mapToolAction('Glob')).toBe('glob');
    expect(mapToolAction('Grep')).toBe('grep');
    expect(mapToolAction('Agent')).toBe('agent');
  });

  describe('a 0.5.3-era fixture consumer (Codex adapter) after upgrade', () => {
    const CONFIG: SigilHookConfig = {
      apiKey: 'sk_sigil_test_key',
      apiUrl: 'https://sign.test.sigilcore.com',
    };

    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it.each([
      ['Read', 'read'],
      ['Glob', 'glob'],
      ['Grep', 'grep'],
      ['Agent', 'agent'],
    ])('still emits action %s -> %s and stays authorized under a read-allowing policy', async (toolName, expectedAction) => {
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'APPROVED' }), { status: 200 }),
      );
      const hook = createCodexPreToolUseHook(CONFIG);
      const result = await hook({ tool_name: toolName, tool_input: { path: '/x' } });
      expect(result).toBeUndefined();
      const call = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse((call?.[1] as RequestInit).body as string) as {
        intent: { action: string };
      };
      expect(body.intent.action).toBe(expectedAction);
    });
  });
});
