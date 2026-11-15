// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, in GitHub's shapes.

import {
  ZERO_OID,
  mergeBase,
  parseCommit,
  parseTree,
} from './gitobj.ts';
import {
  VIEWER,
  applyFileChange,
  changedFiles,
  commitTree,
  flattenTree,
  listCommits,
  makeCommit,
  mergePull,
  nowIso,
  pullMergeability,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The request origin (http://host) for absolute Link headers. */
  origin: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Json = Record<string, unknown>;

function notFound(): RestReply {
  return { status: 404, body: { message: 'Not Found' } };
}

function unprocessable(message: string): RestReply {
  return { status: 422, body: { message } };
}

function stringField(body: Json, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------- serializers

export function userJson(login: string): Json {
  const user = login === VIEWER.login ? VIEWER : { id: 0, login, name: login, email: '' };
  return { login: user.login, id: user.id, type: 'User', site_admin: false, name: user.name, email: user.email };
}

export function repoJson(repo: RepoRec): Json {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: '',
    git_url: '',
    ssh_url: '',
    clone_url: '',
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(repo: RepoRec, name: string): Json {
  const label = repo.labels.get(name);
  const index = [...repo.labels.keys()].indexOf(name);
  return {
    id: repo.id * 100000 + index + 1,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.user),
    author_association: 'OWNER',
    comments: issue.comments.length,
    locked: false,
    active_lock_reason: null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: '',
    url: '',
  };
}

function refJson(repo: RepoRec, refName: string): Json {
  const sha = repo.refs.get(`refs/heads/${refName}`) ?? ZERO_OID;
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha,
    user: userJson(repo.owner),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: userJson(repo.owner) },
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Json {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    labels: [],
    draft: false,
    head: refJson(repo, pull.headRef),
    base: refJson(repo, pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeability(repo, pull) === 'MERGEABLE' : null,
    mergeable_state: pull.state === 'open' ? (pullMergeability(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty') : 'unknown',
    comments: pull.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: '',
    url: '',
  };
}

export function commentJson(comment: CommentRec): Json {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    author_association: 'OWNER',
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
    issue_url: '',
  };
}

function identParts(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: new Date(0).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function commitJson(repo: RepoRec, oid: string): Json {
  const object = repo.store.get(oid);
  const commit = object !== undefined && object.type === 'commit'
    ? parseCommit(object.data)
    : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  const author = identParts(commit.author);
  const committer = identParts(commit.committer);
  return {
    sha: oid,
    commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: '',
    url: '',
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

function paginate(items: unknown[], query: URLSearchParams, url: string): Page {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (page < lastPage) {
    const withPage = (target: number): string => {
      const next = new URL(url);
      next.searchParams.set('page', String(target));
      next.searchParams.set('per_page', String(perPage));
      return next.toString();
    };
    headers.link = `<${withPage(page + 1)}>; rel="next", <${withPage(lastPage)}>; rel="last"`;
  }
  return { items: slice, headers };
}

// ---------------------------------------------------------------- helpers

/** Resolve a ref-ish (branch name, tag name, full ref, oid, HEAD) to a commit oid. */
export function resolveRef(repo: RepoRec, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '' || ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.store.has(ref.toLowerCase())) return ref.toLowerCase();
  return undefined;
}

function repoOr404(forge: Forge, owner: string, name: string): RepoRec | RestReply {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
  return repo;
}

function isReply(value: RepoRec | RestReply): value is RestReply {
  return (value as RestReply).status !== undefined;
}

// ---------------------------------------------------------------- the router

export function handleRest(forge: Forge, req: RestRequest): RestReply {
  const { method, segments, query, body } = req;
  const apiBase = `${req.origin}/api/v3`;

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', github_developer_program_member: false } };
  }
  if (segments[0] === 'rate_limit' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 } } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, body: userJson(VIEWER.login) };
  }
  if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
    const user = forge.users.get(segments[1] as string);
    if (user === undefined) return notFound();
    return { status: 200, body: userJson(user.login) };
  }

  // The viewer's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = forge.reposOf(VIEWER.login).map(repoJson);
      const page = paginate(all, query, `${apiBase}/user/repos?${query.toString()}`);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (method === 'POST') {
      const name = stringField(body, 'name');
      if (name === undefined || name === '') return unprocessable('Repository creation failed: name is required');
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return unprocessable(`Repository creation failed: the name ${name} already exists on this account`);
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        description: stringField(body, 'description') ?? null,
        private: body.private === true,
        defaultBranch: stringField(body, 'default_branch'),
      });
      return { status: 201, body: repoJson(repo) };
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const found = repoOr404(forge, owner, name);
  if (isReply(found)) return found;
  const repo = found;
  const rest = segments.slice(3);
  const repoUrl = `${apiBase}/repos/${owner}/${name}`;

  // Repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      const newName = stringField(body, 'name');
      if (newName !== undefined && newName !== '' && newName !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = newName;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      if (typeof body.private === 'boolean') repo.private = body.private;
      const defaultBranch = stringField(body, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      repo.updatedAt = nowIso();
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = paginate(branches, query, `${repoUrl}/branches?${query.toString()}`);
      return { status: 200, body: page.items, headers: page.headers };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound();
      return { status: 200, body: { name: branch, commit: commitJson(repo, sha), protected: false } };
    }
    return notFound();
  }

  // Git data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined) return unprocessable('ref and sha are required');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      if (repo.refs.has(full)) return unprocessable(`Reference already exists: ${full}`);
      const object = repo.store.get(sha.toLowerCase());
      if (object === undefined) return unprocessable(`Object ${sha} does not exist`);
      repo.refs.set(full, sha.toLowerCase());
      repo.updatedAt = nowIso();
      return { status: 201, body: { ref: full, object: { sha: sha.toLowerCase(), type: object.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const full = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return notFound();
      const object = repo.store.get(sha);
      return { status: 200, body: { ref: full, object: { sha, type: object?.type ?? 'commit' } } };
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha') ?? undefined);
    if (tip === undefined) return { status: 200, body: [] };
    const all = listCommits(repo.store, tip, 1000).map((oid) => commitJson(repo, oid));
    const page = paginate(all, query, `${repoUrl}/commits?${query.toString()}`);
    return { status: 200, body: page.items, headers: page.headers };
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const oid = rest[1] as string;
    if (!repo.store.has(oid)) return notFound();
    return { status: 200, body: commitJson(repo, oid) };
  }

  // Contents.
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    return contentsRoute(forge, repo, req, path);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const labelName = stringField(body, 'name');
      if (labelName === undefined || labelName === '') return unprocessable('name is required');
      if (repo.labels.has(labelName)) return unprocessable(`Label ${labelName} already exists`);
      repo.labels.set(labelName, {
        name: labelName,
        color: (stringField(body, 'color') ?? 'ededed').replace(/^#/, ''),
        description: stringField(body, 'description') ?? null,
      });
      return { status: 201, body: labelJson(repo, labelName) };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)) };
    }
    return notFound();
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    return issuesRoute(forge, repo, req);
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return pullsRoute(forge, repo, req);
  }

  return notFound();
}

// ---------------------------------------------------------------- contents

function contentsRoute(forge: Forge, repo: RepoRec, req: RestRequest, path: string): RestReply {
  const { method, query, body } = req;
  if (method === 'GET') {
    const tip = resolveRef(repo, query.get('ref') ?? undefined);
    if (tip === undefined) return notFound();
    const tree = commitTree(repo.store, tip);
    if (tree === null) return notFound();
    const flat = flattenTree(repo.store, tree);
    const file = flat.get(path);
    if (file !== undefined) {
      const object = repo.store.get(file.oid);
      const data = object?.data ?? Buffer.alloc(0);
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop(),
          path,
          content: data.toString('base64'),
          sha: file.oid,
          url: '',
          git_url: '',
          html_url: '',
          download_url: null,
        },
      };
    }
    // Directory listing: direct children of `path` (or the root).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
    for (const [entryPath, entry] of flat) {
      if (!entryPath.startsWith(prefix)) continue;
      const remainder = entryPath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash === -1) {
        const object = repo.store.get(entry.oid);
        children.set(remainder, { type: 'file', oid: entry.oid, size: object?.data.length ?? 0 });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!children.has(dirName)) {
          children.set(dirName, { type: 'dir', oid: subtreeOid(repo, tree, prefix + dirName), size: 0 });
        }
      }
    }
    if (children.size === 0 && path !== '') return notFound();
    const listing = [...children.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([childName, child]) => ({
        type: child.type,
        name: childName,
        path: prefix + childName,
        sha: child.oid,
        size: child.size,
        url: '',
        git_url: '',
        html_url: '',
        download_url: null,
      }));
    return { status: 200, body: listing };
  }

  if (method === 'PUT' || method === 'DELETE') {
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined) {
      // A contents write names the branch into existence: from the default branch's
      // tip when there is one, or as the repository's first commit.
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const baseTree = tip === undefined ? null : commitTree(repo.store, tip);
    const flat = baseTree === null ? new Map() : flattenTree(repo.store, baseTree);
    const existing = flat.get(path);
    const message = stringField(body, 'message') ?? (method === 'PUT' ? `Update ${path}` : `Delete ${path}`);
    if (method === 'DELETE') {
      if (existing === undefined) return notFound();
      const sha = stringField(body, 'sha');
      if (sha !== undefined && sha.toLowerCase() !== existing.oid) {
        return { status: 409, body: { message: `${path} does not match ${sha}` } };
      }
      const newTree = applyFileChange(repo.store, baseTree, path, null);
      const commit = makeCommit(repo.store, { tree: newTree, parents: tip === undefined ? [] : [tip], message });
      repo.refs.set(refName, commit);
      repo.updatedAt = nowIso();
      return { status: 200, body: { content: null, commit: { sha: commit, message } } };
    }
    const content = stringField(body, 'content');
    if (content === undefined) return unprocessable('content is required');
    const data = Buffer.from(content.replace(/\s+/g, ''), 'base64');
    const blobOid = repo.store.put('blob', data);
    const sha = stringField(body, 'sha');
    if (sha !== undefined && (existing === undefined || sha.toLowerCase() !== existing.oid)) {
      return { status: 409, body: { message: `${path} has changed since ${sha}` } };
    }
    const newTree = applyFileChange(repo.store, baseTree, path, blobOid, existing?.mode ?? '100644');
    const commit = makeCommit(repo.store, { tree: newTree, parents: tip === undefined ? [] : [tip], message });
    repo.refs.set(refName, commit);
    repo.updatedAt = nowIso();
    return {
      status: existing === undefined ? 201 : 200,
      body: {
        content: {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: path.split('/').pop(),
          path,
          sha: blobOid,
          url: '',
          git_url: '',
          html_url: '',
          download_url: null,
        },
        commit: { sha: commit, message, tree: { sha: newTree } },
      },
    };
  }
  return notFound();
}

/** The tree oid of a directory path inside a root tree (for directory listings). */
function subtreeOid(repo: RepoRec, rootTree: string, dirPath: string): string {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const object = repo.store.get(current);
    if (object === undefined || object.type !== 'tree') return ZERO_OID;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return ZERO_OID;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- issues

function issuesRoute(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const { method, query, body } = req;
  const segments = req.segments;
  const at = segments.indexOf('issues');
  const tail = segments.slice(at + 1);

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return unprocessable('title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return unprocessable(`Label ${label} does not exist in this repository`);
      }
      const issue: IssueRec = {
        kind: 'issue',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        labels,
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      repo.updatedAt = nowIso();
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = paginate(list.map((issue) => issueJson(repo, issue)), query, '');
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);

  if (tail.length === 1) {
    if (issue === undefined && pull === undefined) return notFound();
    if (method === 'GET') {
      return { status: 200, body: issue !== undefined ? issueJson(repo, issue) : pullJson(repo, pull as PullRec) };
    }
    if (method === 'PATCH' && issue !== undefined) {
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') issue.state = state;
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((x): x is string => typeof x === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return unprocessable(`Label ${label} does not exist in this repository`);
        }
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      return { status: 200, body: issueJson(repo, issue) };
    }
    if (method === 'PATCH' && pull !== undefined) {
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') {
        pull.state = state;
        pull.updatedAt = nowIso();
      }
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    const host = issue ?? pull;
    if (host === undefined) return notFound();
    if (method === 'POST') {
      const text = stringField(body, 'body');
      if (text === undefined) return unprocessable('body is required');
      const comment: CommentRec = {
        id: forge.nextCommentId(),
        body: text,
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      host.comments.push(comment);
      host.updatedAt = nowIso();
      return { status: 201, body: commentJson(comment) };
    }
    if (method === 'GET') {
      const page = paginate(host.comments.map(commentJson), query, '');
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- pulls

function pullsRoute(forge: Forge, repo: RepoRec, req: RestRequest): RestReply {
  const { method, query, body } = req;
  const segments = req.segments;
  const at = segments.indexOf('pulls');
  const tail = segments.slice(at + 1);

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = stringField(body, 'title');
      const headRaw = stringField(body, 'head');
      const baseRaw = stringField(body, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return unprocessable('title, head and base are required');
      }
      const head = (headRaw.split(':').pop() as string).replace(/^refs\/heads\//, '');
      const base = (baseRaw.split(':').pop() as string).replace(/^refs\/heads\//, '');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return unprocessable(`Head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return unprocessable(`Base branch ${base} does not exist`);
      if (head === base) return unprocessable('Head and base are the same branch');
      const existing = [...repo.pulls.values()].find(
        (pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open',
      );
      if (existing !== undefined) {
        return unprocessable(`A pull request already exists for ${head} into ${base} (#${existing.number})`);
      }
      const pull: PullRec = {
        kind: 'pull',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        user: VIEWER.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = nowIso();
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const page = paginate(list.map((pull) => pullJson(repo, pull)), query, '');
      return { status: 200, body: page.items, headers: page.headers };
    }
    return notFound();
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);

  if (tail.length === 1 && method === 'GET') {
    if (pull === undefined) return notFound();
    return { status: 200, body: pullJson(repo, pull) };
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return { status: 200, body: [] };
    const base = mergeBase(repo.store, baseTip, headTip) ?? baseTip;
    const baseTree = commitTree(repo.store, base);
    const headTree = commitTree(repo.store, headTip);
    const changes = changedFiles(repo.store, baseTree, headTree);
    const headFlat = headTree === null ? new Map() : flattenTree(repo.store, headTree);
    const baseFlat = baseTree === null ? new Map() : flattenTree(repo.store, baseTree);
    const files = changes.map((change) => ({
      sha: (headFlat.get(change.path) ?? baseFlat.get(change.path))?.oid ?? ZERO_OID,
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    const page = paginate(files, query, '');
    return { status: 200, body: page.items, headers: page.headers };
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    if (pull.state !== 'open' || pull.merged) {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    const methodRaw = stringField(body, 'merge_method') ?? 'merge';
    const mergeMethod = methodRaw === 'squash' ? 'squash' : methodRaw === 'rebase' ? 'rebase' : 'merge';
    const sha = mergePull(repo, pull, mergeMethod);
    if (sha === null) {
      return { status: 405, body: { message: 'Pull Request is not mergeable: merge conflict' } };
    }
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return notFound();
}
