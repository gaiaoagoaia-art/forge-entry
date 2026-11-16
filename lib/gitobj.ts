// Git object model for the forge: SHA-1 addressed objects, trees, commits, tags,
// packfiles (read and write, with delta resolution) and pkt-line framing.
// Node standard library only.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const TYPE_CODES: Readonly<Record<GitObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Readonly<Record<number, GitObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** An in-memory object database. One per repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
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

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Peel a ref target to a commit: follow tag objects until a commit (or undefined). */
export function peelToCommit(store: ObjectStore, oid: string): string | undefined {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from `tips` (commits walk to parents, trees and blobs). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Ancestor test over the commit graph: is `ancestor` reachable from `descendant`? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (first shared node in BFS from both sides). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  };
  const fromA = ancestorsOf(a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- packfiles

/** Serialize objects into a version-2 packfile (no deltas: every object whole). */
export function writePack(objects: readonly { type: GitObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const size = object.data.length;
    const typeCode = TYPE_CODES[object.type];
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = Math.floor(size / 16);
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset += (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset += (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset += (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size += (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size += (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/** Inflate one deflate stream inside `buffer` starting at `pos`, reporting the consumed length. */
function inflateEntry(buffer: Buffer, pos: number): { data: Buffer; consumed: number } {
  const slice = buffer.subarray(pos);
  // One pass: zlib's info report names the bytes the stream actually consumed,
  // which is exactly where the next pack entry begins. Older engines without a
  // sane report fall back to the binary search below.
  try {
    const out = inflateSync(slice, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: unknown };
    };
    const consumed = out.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed > 0 && consumed <= slice.length) {
      return { data: out.buffer, consumed };
    }
  } catch {
    // Not a complete stream at this offset: the search below surfaces the error.
  }
  let lo = 1;
  let hi = slice.length;
  let best: Buffer | null = null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const data = inflateSync(slice.subarray(0, mid));
      best = data;
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) {
    // Even the whole remainder failed: let the real error surface.
    const data = inflateSync(slice);
    return { data, consumed: slice.length };
  }
  return { data: best, consumed: lo };
}

export interface PackEntry {
  oid: string;
  type: GitObjType;
  data: Buffer;
}

/**
 * Parse a packfile fully, resolving OFS_DELTA and REF_DELTA entries. `externalBase`
 * resolves a REF_DELTA base that is not in the pack (thin packs).
 */
export function readPack(pack: Buffer, externalBase?: (oid: string) => GitObject | undefined): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  let pos = 12;
  interface RawEntry {
    offset: number;
    type: GitObjType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let type: RawEntry['type'];
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let back = pack[pos] as number;
      pos += 1;
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      type = 'ofs-delta';
      baseOffset = entryOffset - offset;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
      type = 'ref-delta';
    } else {
      const whole = CODE_TYPES[typeCode];
      if (whole === undefined) throw new Error(`pack entry type ${typeCode}`);
      type = whole;
    }
    const inflated = inflateEntry(pack, pos);
    if (inflated.data.length !== size) throw new Error(`pack entry size ${inflated.data.length} != ${size}`);
    pos += inflated.consumed;
    byOffset.set(entryOffset, raw.length);
    raw.push({ offset: entryOffset, type, data: inflated.data, baseOffset, baseOid });
  }
  // The entries tile the pack exactly up to the trailer; a parse that lands
  // anywhere else desynchronized and must not be trusted.
  if (pos !== pack.length - 20) throw new Error('pack entries do not end where the trailer begins');
  const resolved: PackEntry[] = new Array(raw.length);
  const resolving = new Set<number>();
  const resolve = (index: number): PackEntry => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = raw[index] as RawEntry;
    let result: PackEntry;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let baseType: GitObjType;
      let baseData: Buffer;
      if (entry.type === 'ofs-delta') {
        const baseIndex = byOffset.get(entry.baseOffset as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
        const base = resolve(baseIndex);
        baseType = base.type;
        baseData = base.data;
      } else {
        const inside = raw.findIndex((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta'
          && hashObject(candidate.type, candidate.data) === entry.baseOid);
        if (inside >= 0) {
          const base = resolve(inside);
          baseType = base.type;
          baseData = base.data;
        } else if (externalBase !== undefined) {
          const base = externalBase(entry.baseOid as string);
          if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not available`);
          baseType = base.type;
          baseData = base.data;
        } else {
          throw new Error(`ref-delta base ${entry.baseOid} not in pack`);
        }
      }
      const data = applyDelta(baseData, entry.data);
      result = { oid: hashObject(baseType, data), type: baseType, data };
    } else {
      result = { oid: hashObject(entry.type, entry.data), type: entry.type, data: entry.data };
    }
    resolving.delete(index);
    resolved[index] = result;
    return result;
  };
  for (let index = 0; index < raw.length; index += 1) resolve(index);
  return resolved;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in a buffer; throws on malformed framing. With
 *  `stopAtFlush`, decoding ends at (and includes) the first flush packet —
 *  receive-pack bodies carry raw pack bytes after that flush. */
export function decodePktLines(buffer: Buffer, start = 0, stopAtFlush = false): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let pos = start;
  while (pos < buffer.length) {
    if (pos + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      if (stopAtFlush) break;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
    } else if (length < 4) {
      throw new Error(`pkt-line length ${length} is reserved`);
    } else {
      if (pos + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
      pos += length;
    }
  }
  return { packets, consumed: pos - start };
}
