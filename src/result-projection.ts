import { createHash } from 'node:crypto';

export const RESULT_PROJECTION_VERSION = 'sof-rp-projection-v1' as const;
export const RESULT_PROJECTION_CONTENT_TYPE =
  'application/vnd.sigil.response-projection.v1' as const;
export const CALL_TOOL_RESULT_CONTENT_TYPE =
  'application/vnd.modelcontextprotocol.call-tool-result+json' as const;
export const MAX_RESULT_PROJECTION_BYTES = 16 * 1024 * 1024;
export const MAX_RESULT_NESTING_DEPTH = 16;

const PROJECTION_MAGIC = Buffer.from('SOF-RP-PROJECTION-1\n', 'ascii');

export interface ResultProjectionRecord {
  path: string;
  value: string;
  /** Half-open UTF-8 byte range within the complete framed projection. */
  start: number;
  end: number;
}

export interface ResultProjectionV1 {
  version: typeof RESULT_PROJECTION_VERSION;
  contentType: typeof RESULT_PROJECTION_CONTENT_TYPE;
  bytes: Uint8Array;
  digest: string;
  records: readonly ResultProjectionRecord[];
}

export type ResultProjectionFailureReason =
  | 'unsupported_binary_result'
  | 'projection_limit'
  | 'nesting_limit'
  | 'evaluator_failure';

export type ProjectCallToolResult =
  | { ok: true; projection: ResultProjectionV1 }
  | { ok: false; reason: ResultProjectionFailureReason };

interface PendingRecord {
  path: string;
  value: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

function ownDataValues(value: object): readonly unknown[] {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError('Symbol-keyed projection value.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Object.keys(descriptors).map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError('Accessor projection value.');
    }
    return descriptor.value;
  });
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function jsonDepth(value: unknown, depth = 1): number {
  if (depth > MAX_RESULT_NESTING_DEPTH) return depth;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('Non-plain projection array.');
    }
    let maximum = depth;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
        throw new TypeError('Sparse or accessor projection array.');
      }
      maximum = Math.max(maximum, jsonDepth(descriptor.value, depth + 1));
    }
    return maximum;
  }
  if (isRecord(value)) {
    if (!isPlainObject(value)) throw new TypeError('Non-plain projection object.');
    let maximum = depth;
    for (const item of ownDataValues(value)) {
      maximum = Math.max(maximum, jsonDepth(item, depth + 1));
    }
    return maximum;
  }
  return depth;
}

interface CanonicalWriter {
  parts: string[];
  remaining: number;
  stack: Set<object>;
}

function appendBounded(writer: CanonicalWriter, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > writer.remaining) throw new RangeError('Projection limit.');
  writer.parts.push(value);
  writer.remaining -= bytes;
}

function appendJsonString(writer: CanonicalWriter, value: string): void {
  appendBounded(writer, '"');
  let segmentStart = 0;
  const flush = (end: number): void => {
    if (end > segmentStart) appendBounded(writer, value.slice(segmentStart, end));
  };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    if (code === 0x22) escaped = '\\"';
    else if (code === 0x5c) escaped = '\\\\';
    else if (code === 0x08) escaped = '\\b';
    else if (code === 0x0c) escaped = '\\f';
    else if (code === 0x0a) escaped = '\\n';
    else if (code === 0x0d) escaped = '\\r';
    else if (code === 0x09) escaped = '\\t';
    else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
          continue;
        }
      }
      escaped = `\\u${code.toString(16).padStart(4, '0')}`;
    }
    if (escaped !== undefined) {
      flush(index);
      appendBounded(writer, escaped);
      segmentStart = index + 1;
    }
  }
  flush(value.length);
  appendBounded(writer, '"');
}

function appendCanonicalJson(writer: CanonicalWriter, value: unknown): void {
  if (value === null) {
    appendBounded(writer, 'null');
    return;
  }
  if (typeof value === 'string') {
    appendJsonString(writer, value);
    return;
  }
  if (typeof value === 'boolean') {
    appendBounded(writer, value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number.');
    appendBounded(writer, JSON.stringify(value));
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('Non-JSON projection value.');
  }
  if (writer.stack.has(value)) throw new TypeError('Cyclic projection value.');
  writer.stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Non-plain projection array.');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Sparse projection array.');
      }
      appendBounded(writer, '[');
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) appendBounded(writer, ',');
        appendCanonicalJson(writer, value[index]);
      }
      appendBounded(writer, ']');
      return;
    }
    if (!isRecord(value) || !isPlainObject(value)) {
      throw new TypeError('Non-plain projection object.');
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError('Symbol-keyed projection object.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    appendBounded(writer, '{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] ?? '';
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
        throw new TypeError('Accessor projection object.');
      }
      if (descriptor.value === undefined) throw new TypeError('Undefined projection value.');
      if (index > 0) appendBounded(writer, ',');
      appendJsonString(writer, key);
      appendBounded(writer, ':');
      appendCanonicalJson(writer, descriptor.value);
    }
    appendBounded(writer, '}');
  } finally {
    writer.stack.delete(value);
  }
}

function framedBytesUsed(records: PendingRecord[], nextPath: string): number {
  return Buffer.byteLength('SOF-RP-PROJECTION-1\n', 'ascii') + 4 + records.reduce(
    (total, record) => total + 4 + Buffer.byteLength(record.path, 'utf8') + 8 + Buffer.byteLength(record.value, 'utf8'),
    0,
  ) + 4 + Buffer.byteLength(nextPath, 'utf8') + 8;
}

function canonicalJson(value: unknown, maxBytes: number): string {
  const writer: CanonicalWriter = { parts: [], remaining: maxBytes, stack: new Set() };
  appendCanonicalJson(writer, value);
  return writer.parts.join('');
}

function appendString(
  records: PendingRecord[],
  path: string,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  records.push({ path, value });
  return true;
}

function appendCanonical(
  records: PendingRecord[],
  path: string,
  value: unknown,
): void {
  const remaining = MAX_RESULT_PROJECTION_BYTES - framedBytesUsed(records, path);
  if (remaining < 0) throw new RangeError('Projection limit.');
  records.push({ path, value: canonicalJson(value, remaining) });
}

function appendOptionalMetadata(
  value: Record<string, unknown>,
  basePath: string,
  records: PendingRecord[],
): void {
  for (const field of ['annotations', '_meta'] as const) {
    if (Object.hasOwn(value, field)) {
      appendCanonical(records, `${basePath}/${field}`, value[field]);
    }
  }
}

function collectContentRecord(
  block: unknown,
  index: number,
  records: PendingRecord[],
): boolean {
  if (!isRecord(block) || typeof block.type !== 'string') return false;
  if (block.type === 'text') {
    if (!hasOnlyKeys(block, ['type', 'text', 'annotations', '_meta'])) return false;
    if (!appendString(records, `/content/${index}/text`, block.text)) return false;
    appendOptionalMetadata(block, `/content/${index}`, records);
    return true;
  }
  if (block.type === 'resource') {
    if (
      !hasOnlyKeys(block, ['type', 'resource', 'annotations', '_meta']) ||
      !isRecord(block.resource) ||
      !hasOnlyKeys(block.resource, ['uri', 'text', 'mimeType', '_meta']) ||
      !Object.hasOwn(block.resource, 'uri') ||
      !Object.hasOwn(block.resource, 'text') ||
      Object.hasOwn(block.resource, 'blob')
    ) {
      return false;
    }
    for (const field of ['uri', 'text', 'mimeType'] as const) {
      if (!Object.hasOwn(block.resource, field)) continue;
      if (!appendString(records, `/content/${index}/resource/${field}`, block.resource[field])) {
        return false;
      }
    }
    appendOptionalMetadata(block.resource, `/content/${index}/resource`, records);
    appendOptionalMetadata(block, `/content/${index}`, records);
    return true;
  }
  if (block.type === 'resource_link') {
    if (
      !hasOnlyKeys(block, [
        'type',
        'uri',
        'name',
        'title',
        'description',
        'mimeType',
        'size',
        'icons',
        'annotations',
        '_meta',
      ])
      || !Object.hasOwn(block, 'uri')
      || !Object.hasOwn(block, 'name')
    ) {
      return false;
    }
    let found = false;
    for (const field of ['uri', 'name', 'title', 'description', 'mimeType'] as const) {
      if (!Object.hasOwn(block, field)) continue;
      if (!appendString(records, `/content/${index}/${field}`, block[field])) return false;
      found = true;
    }
    for (const field of ['size', 'icons'] as const) {
      if (!Object.hasOwn(block, field)) continue;
      appendCanonical(records, `/content/${index}/${field}`, block[field]);
      found = true;
    }
    appendOptionalMetadata(block, `/content/${index}`, records);
    return found;
  }
  return false;
}

function frameRecords(pending: readonly PendingRecord[]): ResultProjectionV1 | null {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(pending.length);
  const chunks: Buffer[] = [PROJECTION_MAGIC, count];
  const records: ResultProjectionRecord[] = [];
  let offset = PROJECTION_MAGIC.length + count.length;

  for (const record of pending) {
    const pathBytes = Buffer.byteLength(record.path, 'utf8');
    const valueBytes = Buffer.byteLength(record.value, 'utf8');
    const end = offset + 4 + pathBytes + 8 + valueBytes;
    if (end > MAX_RESULT_PROJECTION_BYTES) return null;
    const path = Buffer.from(record.path, 'utf8');
    const value = Buffer.from(record.value, 'utf8');
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(path.length);
    const valueLength = Buffer.alloc(8);
    valueLength.writeBigUInt64BE(BigInt(value.length));
    const start = offset + 4 + path.length + 8;
    chunks.push(pathLength, path, valueLength, value);
    records.push({ path: record.path, value: record.value, start, end });
    offset = end;
  }

  const bytes = Buffer.concat(chunks);
  return Object.freeze({
    version: RESULT_PROJECTION_VERSION,
    contentType: RESULT_PROJECTION_CONTENT_TYPE,
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    records: Object.freeze(records.map((record) => Object.freeze(record))),
  });
}

/**
 * Builds the frozen `sof-rp-projection-v1` framing from an SDK-decoded MCP
 * CallToolResult. Binary, mixed, unknown, oversized, and over-depth values fail
 * closed. The returned bytes remain local and are never passed to a callback.
 */
export function projectCallToolResult(result: unknown): ProjectCallToolResult {
  try {
    if (!isRecord(result)) return { ok: false, reason: 'evaluator_failure' };
    if (
      !hasOnlyKeys(result, ['content', 'structuredContent', 'isError', '_meta']) ||
      (Object.hasOwn(result, 'isError') && typeof result.isError !== 'boolean')
    ) {
      return { ok: false, reason: 'evaluator_failure' };
    }
    if (jsonDepth(result) > MAX_RESULT_NESTING_DEPTH) {
      return { ok: false, reason: 'nesting_limit' };
    }
    const records: PendingRecord[] = [];
    if (!Array.isArray(result.content)) {
      return { ok: false, reason: 'evaluator_failure' };
    }
    for (let index = 0; index < result.content.length; index += 1) {
      if (!collectContentRecord(result.content[index], index, records)) {
        return { ok: false, reason: 'unsupported_binary_result' };
      }
    }
    if (Object.hasOwn(result, 'structuredContent')) {
      if (jsonDepth(result.structuredContent) > MAX_RESULT_NESTING_DEPTH) {
        return { ok: false, reason: 'nesting_limit' };
      }
      appendCanonical(records, '/structuredContent', result.structuredContent);
    }
    if (Object.hasOwn(result, '_meta')) {
      appendCanonical(records, '/_meta', result._meta);
    }
    const projection = frameRecords(records);
    return projection
      ? { ok: true, projection }
      : { ok: false, reason: 'projection_limit' };
  } catch (error) {
    return error instanceof RangeError
      ? { ok: false, reason: 'projection_limit' }
      : { ok: false, reason: 'evaluator_failure' };
  }
}
