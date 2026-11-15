// The forge's data model: users, repositories (git refs + objects), issues,
// pull requests, labels and comments, all in memory in one process.

import {
  ObjectStore,
  buildCommit,
  buildTree,
  collectReachable,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './gitobj.ts';

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The seeded user directory (the trial's one scenario): the token is the viewer's. */
export const USERS: readonly UserRec[] = [
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
];

export const VIEWER: UserRec = USERS[0] as UserRec;
export const ORG_LOGIN = 'faint-meadow-org';

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A git identity line for server-made commits: `Name <email> ts +0000`. */
export function serverIdent(): string {
  const ts = Math.floor(Date.now() / 1000);
  return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
}

export class Forge {
  readonly users = new Map<string, UserRec>(USERS.map((user) => [user.login, user]));
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private nodeSeq = 0;
  private commentSeq = 0;

  nextRepoId(): number {
    this.repoSeq += 1;
    return this.repoSeq;
  }

  nextNodeId(): number {
    this.nodeSeq += 1;
    return this.nodeSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, input: { description?: string | null; private?: boolean; defaultBranch?: string }): RepoRec {
    const stamp = nowIso();
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner,
      name,
      description: input.description ?? null,
      private: input.private ?? false,
      defaultBranch: input.defaultBranch !== undefined && input.defaultBranch !== '' ? input.defaultBranch : 'main',
      createdAt: stamp,
      updatedAt: stamp,
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------- tree surgery

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree object into a path -> entry map. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flattened path map; returns the root tree oid. */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      if (!node.dirs.has(segment)) node.dirs.set(segment, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segment) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The root tree oid of a commit, or null. */
export function commitTree(store: ObjectStore, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Apply one file change (blob oid, or null to delete) to a root tree; returns the new root tree oid. */
export function applyFileChange(store: ObjectStore, rootTree: string | null, path: string, blobOid: string | null, mode = '100644'): string {
  const flat = rootTree === null ? new Map<string, FlatEntry>() : flattenTree(store, rootTree);
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { oid: blobOid, mode });
  return treeFromFlat(store, flat);
}

/** Make a commit object in the store and return its oid. */
export function makeCommit(
  store: ObjectStore,
  input: { tree: string; parents: readonly string[]; message: string; ident?: string },
): string {
  const ident = input.ident ?? serverIdent();
  return store.put('commit', buildCommit({
    tree: input.tree,
    parents: input.parents,
    author: ident,
    committer: ident,
    message: input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  }));
}

/** The commit oids reachable from a tip, newest first (BFS by generation). */
export function listCommits(store: ObjectStore, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-diff counts between two blob contents (LCS over lines; bounded). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= n; j += 1) {
      const above = dp[j] as number;
      if (oldLines[i - 1] === newLines[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const lcs = dp[n] as number;
  return { additions: n - lcs, deletions: m - lcs };
}

function blobText(store: ObjectStore, oid: string | undefined): string {
  if (oid === undefined) return '';
  const object = store.get(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

/** The file-level changes between two root trees. */
export function changedFiles(store: ObjectStore, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const head = headTree === null ? new Map<string, FlatEntry>() : flattenTree(store, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const counts = lineDiffCounts(blobText(store, before?.oid), blobText(store, after?.oid));
    changes.push({
      path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  tree: string | null;
  conflicts: string[];
}

/** A file-level three-way merge of two root trees against their common base tree. */
export function threeWayMerge(
  store: ObjectStore,
  baseTree: string | null,
  ourTree: string | null,
  theirTree: string | null,
): MergeOutcome {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const ours = ourTree === null ? new Map<string, FlatEntry>() : flattenTree(store, ourTree);
  const theirs = theirTree === null ? new Map<string, FlatEntry>() : flattenTree(store, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const sameOid = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (sameOid(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (sameOid(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (sameOid(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, tree: null, conflicts };
  return { ok: true, tree: treeFromFlat(store, merged), conflicts: [] };
}

/** Whether merging `pull` into its base branch would conflict right now. */
export function pullMergeability(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  const outcome = threeWayMerge(
    repo.store,
    commitTree(repo.store, base),
    commitTree(repo.store, baseTip),
    commitTree(repo.store, headTip),
  );
  return outcome.ok ? 'MERGEABLE' : 'CONFLICTING';
}

/**
 * Merge a pull request into its base branch (squash by default; 'merge' keeps both
 * parents). Returns the merge commit oid, or null when it conflicts.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): string | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  if (isAncestor(repo.store, headTip, baseTip)) {
    // Already up to date: the head is contained in the base; a squash still records a commit.
    if (method === 'merge') return baseTip;
  }
  const base = mergeBase(repo.store, baseTip, headTip);
  if (base === null) return null;
  const outcome = threeWayMerge(
    repo.store,
    commitTree(repo.store, base),
    commitTree(repo.store, baseTip),
    commitTree(repo.store, headTip),
  );
  if (!outcome.ok || outcome.tree === null) return null;
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo.store, {
      tree: outcome.tree,
      parents: [baseTip, headTip],
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
    });
  } else {
    sha = makeCommit(repo.store, {
      tree: outcome.tree,
      parents: [baseTip],
      message: `${pull.title} (#${pull.number})\n${pull.body === '' ? '' : `\n${pull.body}\n`}`,
    });
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  repo.updatedAt = nowIso();
  return sha;
}

export { collectReachable, isAncestor, mergeBase };
