// src/strict-json.ts
//
// Duplicate-aware strict JSON reader operating on RAW BYTES, never on
// already-parsed objects. `JSON.parse` discards duplicate-key evidence before
// returning, so `{"command":"safe","command":"unsafe"}` is indistinguishable
// afterwards and both the execution digest and the response validator would
// bind to the parser-selected value rather than to what was actually sent.
//
// Used by the Cowork hook wrapper on raw stdin and by the interceptor's
// strictResponse path on the raw Sign response body. Exported from the package
// root as a supported export (the bundled wrapper imports it).
//
// Failure classes map to exactly one public error code each (see
// mapStrictJsonError): duplicate key -> SIGIL_INPUT_DUPLICATE_KEY; depth past
// the bound, a non-object root, and a syntax error -> SIGIL_INPUT_MALFORMED;
// invalid UTF-8 -> SIGIL_INPUT_ENCODING; over the byte cap ->
// SIGIL_INPUT_TOO_LARGE on stdin and SIGIL_RESPONSE_INVALID on a response.

import {
  SIGIL_INPUT_DUPLICATE_KEY,
  SIGIL_INPUT_ENCODING,
  SIGIL_INPUT_MALFORMED,
  SIGIL_INPUT_TOO_LARGE,
  SIGIL_RESPONSE_INVALID,
} from './types.js';

export type StrictJsonErrorClass =
  | 'duplicate_key'
  | 'malformed'
  | 'encoding'
  | 'oversize';

export interface StrictJsonOk {
  ok: true;
  value: Record<string, unknown>;
}

export interface StrictJsonFailure {
  ok: false;
  error: StrictJsonErrorClass;
  message: string;
}

export type StrictJsonResult = StrictJsonOk | StrictJsonFailure;

export interface StrictJsonOptions {
  /** Maximum accepted input size in UTF-8 bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Maximum nesting depth (root object is depth 1). Default 32. */
  maxDepth?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;

/**
 * Maps a strict-reader failure class to its single public error code. The one
 * context-dependent class is `oversize`, which is SIGIL_INPUT_TOO_LARGE on the
 * request (stdin) side and SIGIL_RESPONSE_INVALID on the response side.
 */
export function mapStrictJsonError(
  error: StrictJsonErrorClass,
  context: 'stdin' | 'response',
): string {
  if (error === 'duplicate_key') return SIGIL_INPUT_DUPLICATE_KEY;
  if (error === 'encoding') return SIGIL_INPUT_ENCODING;
  if (error === 'oversize') {
    return context === 'stdin' ? SIGIL_INPUT_TOO_LARGE : SIGIL_RESPONSE_INVALID;
  }
  return SIGIL_INPUT_MALFORMED;
}

const fail = (
  error: StrictJsonErrorClass,
  message: string,
): StrictJsonFailure => ({ ok: false, error, message });

/**
 * Strictly parses JSON from raw bytes: rejects duplicate keys at every nesting
 * level, enforces the byte cap, decodes UTF-8 strictly (invalid sequences are
 * an error, never a replacement character), bounds nesting depth, and requires
 * an object root. A string input is accepted for callers that already hold
 * decoded text; the byte cap is still enforced over its UTF-8 encoding.
 */
export function readStrictJson(
  input: Uint8Array | string,
  options?: StrictJsonOptions,
): StrictJsonResult {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;

  let text: string;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > maxBytes) {
      return fail('oversize', `Input exceeds the ${maxBytes}-byte cap.`);
    }
    text = input;
  } else {
    if (input.byteLength > maxBytes) {
      return fail('oversize', `Input exceeds the ${maxBytes}-byte cap.`);
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return fail('encoding', 'Input is not valid UTF-8.');
    }
  }

  const parser = new StrictParser(text, maxDepth);
  try {
    const value = parser.parse();
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return fail('malformed', 'Root value must be a JSON object.');
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error: unknown) {
    if (error instanceof StrictParseError) {
      return fail(error.errorClass, error.message);
    }
    return fail('malformed', 'Invalid JSON.');
  }
}

class StrictParseError extends Error {
  readonly errorClass: StrictJsonErrorClass;

  constructor(errorClass: StrictJsonErrorClass, message: string) {
    super(message);
    this.errorClass = errorClass;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

class StrictParser {
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.pos !== this.text.length) {
      throw this.syntax('Unexpected trailing characters.');
    }
    return value;
  }

  private syntax(message: string): StrictParseError {
    return new StrictParseError(
      'malformed',
      `${message} (position ${this.pos})`,
    );
  }

  private skipWhitespace(): void {
    while (
      this.pos < this.text.length &&
      WHITESPACE.has(this.text[this.pos] as string)
    ) {
      this.pos += 1;
    }
  }

  private parseValue(depth: number): unknown {
    if (depth > this.maxDepth) {
      throw new StrictParseError(
        'malformed',
        `Nesting depth exceeds the bound of ${this.maxDepth}.`,
      );
    }
    const ch = this.text[this.pos];
    if (ch === undefined) throw this.syntax('Unexpected end of input.');
    if (ch === '{') return this.parseObject(depth);
    if (ch === '[') return this.parseArray(depth);
    if (ch === '"') return this.parseString();
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.text.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    throw this.syntax(`Unexpected character ${JSON.stringify(ch)}.`);
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.expect('{');
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.pos] === '}') {
      this.pos += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.pos] !== '"') {
        throw this.syntax('Expected a string object key.');
      }
      const key = this.parseString();
      if (seen.has(key)) {
        throw new StrictParseError(
          'duplicate_key',
          `Duplicate object key ${JSON.stringify(key)}.`,
        );
      }
      seen.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      const value = this.parseValue(depth + 1);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos += 1;
        continue;
      }
      if (next === '}') {
        this.pos += 1;
        return result;
      }
      throw this.syntax('Expected "," or "}" in object.');
    }
  }

  private parseArray(depth: number): unknown[] {
    this.expect('[');
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.pos] === ']') {
      this.pos += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos += 1;
        continue;
      }
      if (next === ']') {
        this.pos += 1;
        return result;
      }
      throw this.syntax('Expected "," or "]" in array.');
    }
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw this.syntax('Unterminated string.');
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos];
        if (esc === undefined) throw this.syntax('Unterminated escape.');
        if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          const hex = this.text.slice(this.pos + 1, this.pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw this.syntax('Invalid \\u escape.');
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
        } else {
          throw this.syntax(`Invalid escape \\${esc}.`);
        }
        this.pos += 1;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        throw this.syntax('Unescaped control character in string.');
      }
      out += ch;
      this.pos += 1;
    }
  }

  private parseNumber(): number {
    const start = this.pos;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.text.slice(this.pos),
    );
    if (!match || match[0].length === 0) {
      throw this.syntax('Invalid number.');
    }
    this.pos = start + match[0].length;
    return Number(match[0]);
  }

  private expect(ch: string): void {
    if (this.text[this.pos] !== ch) {
      throw this.syntax(`Expected ${JSON.stringify(ch)}.`);
    }
    this.pos += 1;
  }
}
