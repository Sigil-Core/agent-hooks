// tests/strict-json.test.ts
//
// Byte-level fixtures for the strict JSON reader. Assertions are on raw
// bytes, never on pre-parsed objects, because JSON.parse destroys the
// duplicate-key evidence these tests exist to preserve.
import { describe, expect, it } from 'vitest';
import { mapStrictJsonError, readStrictJson } from '../src/strict-json.js';
import {
  SIGIL_INPUT_DUPLICATE_KEY,
  SIGIL_INPUT_ENCODING,
  SIGIL_INPUT_MALFORMED,
  SIGIL_INPUT_TOO_LARGE,
  SIGIL_RESPONSE_INVALID,
} from '../src/types.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readStrictJson', () => {
  it('parses a plain object from raw bytes', () => {
    const result = readStrictJson(bytes('{"tool_name":"Bash","tool_input":{"command":"ls"}}'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value['tool_name']).toBe('Bash');
      expect((result.value['tool_input'] as Record<string, unknown>)['command']).toBe('ls');
    }
  });

  it.each([
    ['top level', '{"command":"safe","command":"unsafe"}'],
    ['inside tool_input', '{"tool_input":{"command":"safe","command":"unsafe"}}'],
    ['before tool_input', '{"a":1,"a":2,"tool_input":{"command":"x"}}'],
    ['after tool_input', '{"tool_input":{"command":"x"},"a":1,"a":2}'],
    ['nested MCP arguments', '{"tool_input":{"arguments":{"path":"a","path":"b"}}}'],
    ['response status, DENIED first', '{"status":"DENIED","status":"APPROVED"}'],
    ['response status, APPROVED first', '{"status":"APPROVED","status":"DENIED"}'],
  ])('rejects duplicate keys: %s', (_label, raw) => {
    const result = readStrictJson(bytes(raw));
    expect(result).toMatchObject({ ok: false, error: 'duplicate_key' });
  });

  it('rejects a non-object root', () => {
    for (const raw of ['[1,2]', '"str"', '42', 'true', 'null']) {
      expect(readStrictJson(bytes(raw))).toMatchObject({ ok: false, error: 'malformed' });
    }
  });

  it('rejects syntax errors and trailing garbage', () => {
    for (const raw of ['{', '{"a":}', '{"a":1}x', '', '{"a":01}', "{'a':1}"]) {
      expect(readStrictJson(bytes(raw))).toMatchObject({ ok: false, error: 'malformed' });
    }
  });

  it('rejects invalid UTF-8 bytes', () => {
    const invalid = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    expect(readStrictJson(invalid)).toMatchObject({ ok: false, error: 'encoding' });
  });

  it('enforces the byte cap in UTF-8 bytes, not characters', () => {
    // 3-byte characters: 40 of them is 120 bytes but only 40 characters.
    const value = '€'.repeat(40);
    const raw = `{"a":"${value}"}`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(100);
    expect(raw.length).toBeLessThan(100);
    expect(readStrictJson(bytes(raw), { maxBytes: 100 })).toMatchObject({
      ok: false,
      error: 'oversize',
    });
    expect(readStrictJson(bytes(raw), { maxBytes: 200 }).ok).toBe(true);
  });

  it('bounds nesting depth', () => {
    const nested = (n: number): string => '{"k":'.repeat(n) + '1' + '}'.repeat(n);
    expect(readStrictJson(bytes(nested(31))).ok).toBe(true);
    expect(readStrictJson(bytes(nested(33)))).toMatchObject({ ok: false, error: 'malformed' });
    expect(readStrictJson(bytes(nested(5)), { maxDepth: 4 })).toMatchObject({
      ok: false,
      error: 'malformed',
    });
  });

  it('rejects unescaped control characters and bad escapes', () => {
    expect(readStrictJson(bytes('{"a":"xy"}'))).toMatchObject({ ok: false, error: 'malformed' });
    expect(readStrictJson(bytes('{"a":"\\q"}'))).toMatchObject({ ok: false, error: 'malformed' });
    expect(readStrictJson(bytes('{"a":"\\u12"}'))).toMatchObject({ ok: false, error: 'malformed' });
  });

  it('accepts escapes, unicode, numbers, and literals like JSON.parse', () => {
    const raw = '{"a":"\\u00e9\\n\\"","b":[1,-2.5,1e3],"c":true,"d":false,"e":null}';
    const result = readStrictJson(bytes(raw));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(JSON.parse(raw));
    }
  });

  it('accepts a decoded string input with the cap applied to its UTF-8 encoding', () => {
    const result = readStrictJson('{"a":1}');
    expect(result.ok).toBe(true);
    expect(readStrictJson('{"a":"€€"}', { maxBytes: 8 })).toMatchObject({
      ok: false,
      error: 'oversize',
    });
  });

  it('does not honor __proto__ as a prototype setter', () => {
    const result = readStrictJson(bytes('{"__proto__":{"polluted":true}}'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    }
  });
});

describe('mapStrictJsonError', () => {
  it('maps each failure class to exactly one public code per context', () => {
    expect(mapStrictJsonError('duplicate_key', 'stdin')).toBe(SIGIL_INPUT_DUPLICATE_KEY);
    expect(mapStrictJsonError('duplicate_key', 'response')).toBe(SIGIL_INPUT_DUPLICATE_KEY);
    expect(mapStrictJsonError('malformed', 'stdin')).toBe(SIGIL_INPUT_MALFORMED);
    expect(mapStrictJsonError('malformed', 'response')).toBe(SIGIL_INPUT_MALFORMED);
    expect(mapStrictJsonError('encoding', 'stdin')).toBe(SIGIL_INPUT_ENCODING);
    expect(mapStrictJsonError('encoding', 'response')).toBe(SIGIL_INPUT_ENCODING);
    expect(mapStrictJsonError('oversize', 'stdin')).toBe(SIGIL_INPUT_TOO_LARGE);
    expect(mapStrictJsonError('oversize', 'response')).toBe(SIGIL_RESPONSE_INVALID);
  });
});
