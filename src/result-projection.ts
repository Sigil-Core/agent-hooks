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

class ProjectionLimitError extends Error {}

class BoundedUtf8Writer {
  private readonly parts: string[] = [];
  private pending = '';
  private pendingBytes = 0;
  private remaining: number;

  constructor(limit: number) {
    this.remaining = limit;
  }

  append(value: string): void {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.remaining) throw new ProjectionLimitError('Projection limit exceeded.');
    if (this.pendingBytes > 0 && this.pendingBytes + bytes > 8192) {
      this.parts.push(this.pending);
      this.pending = '';
      this.pendingBytes = 0;
    }
    if (bytes > 8192) this.parts.push(value);
    else {
      this.pending += value;
      this.pendingBytes += bytes;
    }
    this.remaining -= bytes;
  }

  finish(): string {
    return this.pendingBytes > 0 ? [...this.parts, this.pending].join('') : this.parts.join('');
  }
}

const pendingRecordBytes = new WeakMap<PendingRecord[], number>();

function usedRecordBytes(records: PendingRecord[]): number {
  return pendingRecordBytes.get(records) ?? PROJECTION_MAGIC.length + 4;
}

function pushRecord(records: PendingRecord[], path: string, value: string): void {
  const next = usedRecordBytes(records)
    + 4 + Buffer.byteLength(path, 'utf8')
    + 8 + Buffer.byteLength(value, 'utf8');
  if (next > MAX_RESULT_PROJECTION_BYTES) {
    throw new ProjectionLimitError('Projection limit exceeded.');
  }
  records.push({ path, value });
  pendingRecordBytes.set(records, next);
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

function appendJsonString(value: string, writer: BoundedUtf8Writer): void {
  writer.append('"');
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + 4096, value.length);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end += 1;
    }
    const encoded = JSON.stringify(value.slice(start, end));
    writer.append(encoded.slice(1, -1));
    start = end;
  }
  writer.append('"');
}

function appendCanonicalJson(
  value: unknown,
  writer: BoundedUtf8Writer,
  stack: Set<object>,
): void {
  if (value === null) {
    writer.append('null');
    return;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    if (typeof value === 'string') appendJsonString(value, writer);
    else writer.append(JSON.stringify(value));
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number.');
    writer.append(JSON.stringify(value));
    return;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError('Non-JSON projection value.');
  }
  if (stack.has(value)) throw new TypeError('Cyclic projection value.');
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError('Non-plain projection array.');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Sparse projection array.');
      }
      writer.append('[');
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) writer.append(',');
        appendCanonicalJson(value[index], writer, stack);
      }
      writer.append(']');
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
    writer.append('{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get || descriptor.set) {
        throw new TypeError('Accessor projection object.');
      }
      if (descriptor.value === undefined) {
        throw new TypeError('Undefined projection value.');
      }
      if (index > 0) writer.append(',');
      appendJsonString(key, writer);
      writer.append(':');
      appendCanonicalJson(descriptor.value, writer, stack);
    }
    writer.append('}');
  } finally {
    stack.delete(value);
  }
}

function canonicalJson(value: unknown, limit: number): string {
  const writer = new BoundedUtf8Writer(limit);
  appendCanonicalJson(value, writer, new Set<object>());
  return writer.finish();
}

function remainingRecordValueBytes(records: PendingRecord[], path: string): number {
  return MAX_RESULT_PROJECTION_BYTES
    - usedRecordBytes(records)
    - 4 - Buffer.byteLength(path, 'utf8') - 8;
}

function appendString(
  records: PendingRecord[],
  path: string,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  pushRecord(records, path, value);
  return true;
}

function appendCanonical(
  records: PendingRecord[],
  path: string,
  value: unknown,
): void {
  const remaining = remainingRecordValueBytes(records, path);
  if (remaining < 0) throw new ProjectionLimitError('Projection limit exceeded.');
  pushRecord(records, path, canonicalJson(value, remaining));
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
    if (error instanceof ProjectionLimitError) return { ok: false, reason: 'projection_limit' };
    return { ok: false, reason: 'evaluator_failure' };
  }
}
