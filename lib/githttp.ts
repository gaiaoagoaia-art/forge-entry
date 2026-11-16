// Git smart HTTP: info/refs advertisements (v0 and v2), the v2 ls-refs and fetch
// commands, the v0 fetch fallback, and receive-pack pushes with report-status.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  peelToCommit,
  parseTree,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type Packet,
} from './gitobj.ts';
import type { RepoRec } from './store.ts';

export const AGENT = 'makefun-forge/1.0.0';
const ZERO = ZERO_OID;

type Service = 'git-upload-pack' | 'git-receive-pack';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- advertisements

export function infoRefsBody(repo: RepoRec, service: Service, protocolV2: boolean): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (service === 'git-upload-pack' && protocolV2) {
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const target = headTarget(repo);
  const capabilities = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:${target} agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO} capabilities^{}\0${capabilities}\n`));
  } else {
    const headOid = repo.refs.get(target) ?? ZERO;
    parts.push(pktLine(`${headOid} HEAD\0${capabilities}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const object = repo.store.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.store, oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsBody(repo: RepoRec, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.store.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.store, oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** Objects a client provably holds: closure of its haves, not crossing its shallow boundary. */
function clientObjects(repo: RepoRec, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (!shallow.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

interface PackPlan {
  objects: GitObject[];
  /** The oids of `objects`, in the same order: the pack cache's key material. */
  oids: string[];
  shallowLines: string[];
}

/** Decide exactly which objects a fetch sends, and the shallow-info lines it reports. */
function planFetch(repo: RepoRec, args: FetchArgs): PackPlan {
  const store = repo.store;
  const shallowSet = new Set(args.shallow);
  const held = clientObjects(repo, args.haves, shallowSet);
  // BFS over commits from the wants, recording distance (for deepen) and inclusion.
  const included = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    if (store.get(want)?.type === 'commit' && !distance.has(want)) {
      distance.set(want, 1);
      queue.push(want);
    }
  }
  const includedCommits: string[] = [];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const dist = distance.get(oid) as number;
    if (args.depth !== null && dist > args.depth) continue;
    if (included.has(oid)) continue;
    included.add(oid);
    includedCommits.push(oid);
    const commit = parseCommit((store.get(oid) as GitObject).data);
    if (args.depth === null || dist < args.depth) {
      for (const parent of commit.parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    }
  }
  // Non-commit wants (tags, trees, blobs) are included directly.
  for (const want of args.wants) {
    const object = store.get(want);
    if (object !== undefined && object.type !== 'commit') included.add(want);
  }
  // Expand included commits and tags to their trees and blobs.
  const expanded = new Set<string>(included);
  const stack = [...included];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      if (!expanded.has(tree)) { expanded.add(tree); stack.push(tree); }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (!expanded.has(entry.oid)) { expanded.add(entry.oid); stack.push(entry.oid); }
      }
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (!expanded.has(target)) { expanded.add(target); stack.push(target); }
    }
  }
  const send = [...expanded].filter((oid) => !held.has(oid));
  // Shallow lines: included commits whose parents were left out become the new boundary;
  // client-shallow commits that are now fully included are unshallowed.
  const shallowLines: string[] = [];
  if (args.depth !== null || args.shallow.length > 0) {
    for (const oid of includedCommits) {
      const commit = parseCommit((store.get(oid) as GitObject).data);
      const parentsOut = commit.parents.some((parent) => !included.has(parent) && !held.has(parent));
      if (parentsOut) shallowLines.push(`shallow ${oid}`);
      if (shallowSet.has(oid) && !parentsOut) shallowLines.push(`unshallow ${oid}`);
    }
    for (const oid of args.shallow) {
      if (includedCommits.includes(oid) && !shallowLines.some((line) => line.endsWith(oid))) {
        const commit = parseCommit((store.get(oid) as GitObject).data);
        const parentsOut = commit.parents.some((parent) => !included.has(parent) && !held.has(parent));
        if (!parentsOut) shallowLines.push(`unshallow ${oid}`);
      }
    }
  }
  const entries = send
    .map((oid) => ({ oid, object: store.get(oid) }))
    .filter((entry): entry is { oid: string; object: GitObject } => entry.object !== undefined);
  // Commits first, then trees, then blobs, then tags: a stable, readable pack order.
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 } as const;
  entries.sort((a, b) => rank[a.object.type] - rank[b.object.type]);
  const objects = entries.map((entry) => ({ type: entry.object.type, data: entry.object.data }));
  const oids = entries.map((entry) => entry.oid);
  return { objects, oids, shallowLines };
}

// ---------------------------------------------------------------- pack cache

/**
 * Built packs by their exact object list. Objects are content-addressed and
 * immutable and writePack is deterministic, so the same oid list always
 * builds the same bytes; repeated fetches of one tip (the clone workload's
 * fifty identical requests) build the pack once. Bounded in count and size.
 */
const PACK_CACHE_LIMIT = 64;
const PACK_CACHE_MAX_BYTES = 1_048_576;
const packCaches = new WeakMap<RepoRec, Map<string, Buffer>>();

function packForPlan(repo: RepoRec, plan: PackPlan): Buffer {
  let cache = packCaches.get(repo);
  if (cache === undefined) {
    cache = new Map<string, Buffer>();
    packCaches.set(repo, cache);
  }
  const key = plan.oids.join(' ');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(plan.objects);
  if (pack.length <= PACK_CACHE_MAX_BYTES) {
    cache.set(key, pack);
    if (cache.size > PACK_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return pack;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function fetchV2Body(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = packForPlan(repo, plan);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const common = args.haves.filter((have) => args.wants.some((want) => have === want || isAncestor(repo.store, have, want)));
  if (common.length > 0) {
    parts.push(pktLine(`ACK ${common[0]}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Body(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = packForPlan(repo, plan);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- POST dispatch

function dataLines(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Handle a POST to git-upload-pack: a v2 command (ls-refs/fetch) or a v0 fetch.
 *  Malformed bodies get a protocol ERR packet, never a throw. */
export function uploadPack(repo: RepoRec, body: Buffer): Buffer {
  try {
    return uploadPackInner(repo, body);
  } catch {
    return Buffer.concat([pktLine('ERR malformed upload-pack request\n'), PKT_FLUSH]);
  }
}

function uploadPackInner(repo: RepoRec, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstLine = firstData !== undefined && firstData.kind === 'data' ? firstData.payload.toString('utf8') : '';
  if (firstLine.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    // Arguments live after the first delimiter packet.
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') { afterDelim = true; continue; }
      if (packet.kind === 'flush') break;
      if (!afterDelim || packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return lsRefsBody(repo, args);
  }
  if (firstLine.startsWith('command=fetch')) {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
    for (const line of dataLines(packets)) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
      else if (line === 'done') args.done = true;
    }
    return fetchV2Body(repo, args);
  }
  // v0 fetch: want lines (the first may carry capabilities), a flush, then haves and done.
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of dataLines(packets)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  if (args.wants.length === 0) throw new Error('upload-pack: no wants');
  return fetchV0Body(repo, args);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle a POST to git-receive-pack. Always answers a report-status stream.
 *  A malformed body is reported as an unpack failure, never thrown: the repo
 *  (and the server) must survive bad pushes. */
export function receivePack(repo: RepoRec, body: Buffer): Buffer {
  let decoded: { packets: Packet[]; consumed: number };
  try {
    decoded = decodePktLines(body, 0, true);
  } catch {
    const report = Buffer.concat([pktLine('unpack malformed pkt-line framing\n'), PKT_FLUSH]);
    return report;
  }
  const { packets, consumed } = decoded;
  const commands: PushCommandLine[] = [];
  let clientCapabilities = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCapabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const parts = line.split(' ');
    if (parts.length === 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = body.subarray(consumed);
  const wantsSideband = clientCapabilities.split(' ').includes('side-band-64k');
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const entries = readPack(packBytes, (oid) => repo.store.get(oid));
      for (const entry of entries) repo.store.putObject(entry.oid, { type: entry.type, data: entry.data });
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const report: string[] = [];
  report.push(unpackError === null ? 'unpack ok' : `unpack ${unpackError}`);
  for (const command of commands) {
    if (unpackError !== null) break;
    const reason = applyCommand(repo, command);
    report.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (!wantsSideband) return inner;
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const chunk = inner.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Validate and apply one ref update; returns the refusal reason, or null on success. */
function applyCommand(repo: RepoRec, command: PushCommandLine): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) return 'bad ref';
  const current = repo.refs.get(ref) ?? ZERO;
  if (current !== oldOid) return 'stale info';
  if (newOid === ZERO) {
    repo.refs.delete(ref);
    return null;
  }
  const object = repo.store.get(newOid);
  if (object === undefined) return 'not found';
  if (object.type !== 'commit' && object.type !== 'tag') return 'bad object';
  if (oldOid !== ZERO && ref.startsWith('refs/heads/')) {
    const oldCommit = peelToCommit(repo.store, oldOid);
    const newCommit = peelToCommit(repo.store, newOid);
    if (oldCommit !== undefined && newCommit !== undefined && oldCommit !== newCommit
      && !isAncestor(repo.store, oldCommit, newCommit)) {
      return 'non-fast-forward';
    }
  }
  repo.refs.set(ref, newOid);
  return null;
}
