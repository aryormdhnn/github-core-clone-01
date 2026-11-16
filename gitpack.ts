// gitpack.ts — SHA-1 git objects, packfile parse/build, pkt-line framing, delta
// application, and tree/commit helpers. Pure functions over Buffers; no I/O.
// Written against the git smart-HTTP wire format (see kit sdk/conformance/git-client.ts:
// the suite's client writes plain (undeltad) packs on push and reads version 2/3 packs
// with OFS_DELTA/REF_DELTA on fetch; object ids are SHA-1 hex).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODE: Readonly<Record<ObjType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

export const CODE_TYPE: Readonly<Record<number, ObjType>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
});

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The git object id of a typed object: sha1("<type> <len>\\0" + data). */
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= (delta[offset++] as number) << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= (delta[offset++] as number) << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/**
 * Find the end of the zlib stream starting at `start` in `buf`, knowing the stream must
 * inflate to exactly `expectedSize` bytes. Node's inflateSync ignores trailing data and
 * throws on a truncated stream, so a binary search over the prefix length finds the
 * exact end. Returns the offset just past the stream, or -1 when no prefix works.
 */
function findZlibEnd(buf: Buffer, start: number, expectedSize: number): number {
  let lo = start;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(start, mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  if (lo > buf.length) return -1;
  try {
    if (inflateSync(buf.subarray(start, lo)).length !== expectedSize) return -1;
  } catch {
    return -1;
  }
  return lo;
}

interface RawPackEntry {
  readonly offset: number;
  readonly type: ObjType | 'ofs-delta' | 'ref-delta';
  readonly size: number;
  /** Inflated payload (for deltas: the delta instruction stream). */
  readonly data: Buffer;
  /** For ofs-delta: the entry offset of the base. For ref-delta: the base oid. */
  readonly baseOffset: number;
  readonly baseOid: string;
}

/**
 * Parse a packfile (version 2 or 3) into a map of oid -> object, resolving OFS_DELTA
 * and REF_DELTA entries. `external` resolves base oids not present in this pack
 * (objects the server already holds); it is consulted for ref-deltas only.
 */
export function parsePack(buf: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: RawPackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset++] as number;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[offset++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    let type: RawPackEntry['type'];
    if (typeCode === 6) {
      type = 'ofs-delta';
      byte = buf[offset++] as number;
      let off = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[offset++] as number;
        off = ((off + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - off;
    } else if (typeCode === 7) {
      type = 'ref-delta';
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      const t = CODE_TYPE[typeCode];
      if (t === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      type = t;
    }
    const end = findZlibEnd(buf, offset, size);
    if (end < 0) throw new Error('pack object zlib stream not found');
    const data = inflateSync(buf.subarray(offset, end));
    offset = end;
    entries.push({ offset: entryOffset, type, size, data, baseOffset, baseOid });
  }
  // Trailer: 20-byte pack checksum (not verified — the client's packs are trusted
  // after per-object inflate; a bad trailer would fail object verification anyway).
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<number, GitObject>();
  const resolve = (entry: RawPackEntry, depth: number): GitObject => {
    if (depth > 64) throw new Error('delta chain too deep');
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let result: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry, depth + 1);
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else if (entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      for (const other of entries) {
        if (other.type !== 'ofs-delta' && other.type !== 'ref-delta') {
          if (oidOf(other.type as ObjType, other.data) === entry.baseOid) {
            base = { type: other.type as ObjType, data: other.data };
            break;
          }
        }
      }
      if (base === undefined) {
        // Maybe the base is itself a delta in this pack, or an object we already hold.
        for (const other of entries) {
          if (other.type === 'ofs-delta' || other.type === 'ref-delta') {
            const candidate = resolve(other, depth + 1);
            if (oidOf(candidate.type, candidate.data) === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
      }
      if (base === undefined && external !== undefined) base = external(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      const data = applyDelta(base.data, entry.data);
      result = { type: base.type, data };
    } else {
      result = { type: entry.type as ObjType, data: entry.data };
    }
    resolved.set(entry.offset, result);
    return result;
  };
  const out = new Map<string, GitObject>();
  for (const entry of entries) {
    const obj = resolve(entry, 0);
    out.set(oidOf(obj.type, obj.data), obj);
  }
  return out;
}

/**
 * Build a packfile (version 2) holding the given objects as plain (undeltad) entries,
 * in oid order for deterministic output, with the SHA-1 trailer.
 */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = oidOf(a.type, a.data);
    const bo = oidOf(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    const typeCode = TYPE_CODE[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (size & 0x0f) | (typeCode << 4);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// -------------------------------------------------------------------------------------------
// pkt-line framing (git protocol)
// -------------------------------------------------------------------------------------------

/** Encode a string payload as one pkt-line (4-hex length prefix, length includes header). */
export function pktLine(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Encode a raw buffer payload as one pkt-line. */
export function pktLineBuffer(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

/** The flush packet: "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet: "0001". */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** A sideband-64k data packet: channel byte (1=pack, 2=progress, 3=error) + payload. */
export function sideband(channel: 1 | 2 | 3, payload: Buffer): Buffer {
  return pktLineBuffer(Buffer.concat([Buffer.from([channel]), payload]));
}

/** Split a buffer into sideband-64k packets. A pkt-line is at most 65520 bytes
 * TOTAL including its 4-byte length header, and a sideband packet spends one
 * byte on the channel, so at most 65515 bytes of data fit per packet. */
export function sidebandChunks(channel: 1 | 2 | 3, payload: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const max = 65515;
  if (payload.length === 0) {
    out.push(sideband(channel, Buffer.alloc(0)));
    return out;
  }
  for (let i = 0; i < payload.length; i += max) {
    out.push(sideband(channel, payload.subarray(i, Math.min(payload.length, i + max))));
  }
  return out;
}

/** Decode a buffer of pkt-lines into payload strings ('flush'/'delim' for specials). */
export function parsePktLines(buf: Buffer): Array<string | 'flush' | 'delim'> {
  const out: Array<string | 'flush' | 'delim'> = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push('flush');
      offset += 4;
    } else if (len === 1) {
      out.push('delim');
      offset += 4;
    } else {
      out.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
      offset += len;
    }
  }
  return out;
}

/** Decode a buffer of pkt-lines into raw payload buffers ('flush'/'delim' for specials). */
export function parsePktLineBuffers(buf: Buffer): Array<Buffer | 'flush' | 'delim'> {
  const out: Array<Buffer | 'flush' | 'delim'> = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      out.push('flush');
      offset += 4;
    } else if (len === 1) {
      out.push('delim');
      offset += 4;
    } else {
      out.push(buf.subarray(offset + 4, offset + len));
      offset += len;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// tree objects
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries (mode SP name NUL 20-byte sha, in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries (sorted git-style: dirs compare as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// commit objects
// -------------------------------------------------------------------------------------------

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's header lines and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}
