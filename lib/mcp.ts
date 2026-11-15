// The MCP endpoint: JSON-RPC 2.0 over POST /mcp, in both protocol eras.
// `server/discover` (2026 era) and `initialize` (legacy era) are both answered,
// `tools/list` is a static array, and `tools/call` runs the same domain logic
// as the REST surface so ids and state agree across protocols.

import {
  VIEWER,
  mergePull,
  nowIso,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpReply {
  status: number;
  body?: unknown;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const OWNER_REPO: Record<string, { type: string; description: string }> = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO }, required: ['owner', 'repo'] },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash by default).',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type Json = Record<string, unknown>;

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolOk(value: unknown): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Json,
    isError: false,
  };
}

function toolError(message: string): Json {
  return {
    content: [{ type: 'text', text: JSON.stringify({ message }) }],
    structuredContent: { message },
    isError: true,
  };
}

function argString(args: Json, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function argNumber(args: Json, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

function findRepo(forge: Forge, args: Json): RepoRec | undefined {
  const owner = argString(args, 'owner');
  const name = argString(args, 'repo', 'name', 'repository');
  if (owner === undefined || name === undefined) return undefined;
  const repo = forge.getRepo(owner, name);
  return repo !== undefined && repo.owner === VIEWER.login ? repo : undefined;
}

function callTool(forge: Forge, name: string, args: Json): Json {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name', 'repo');
      if (repoName === undefined) return toolError('name is required');
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) {
        return toolError(`Repository ${repoName} already exists`);
      }
      const repo = forge.createRepo(VIEWER.login, repoName, {
        description: argString(args, 'description') ?? null,
        private: args.private === true,
      });
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      return toolOk(repoJson(repo));
    }
    case 'list_repos': {
      return toolOk({ repositories: forge.reposOf(VIEWER.login).map(repoJson) });
    }
    case 'create_issue': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      const title = argString(args, 'title');
      if (title === undefined) return toolError('title is required');
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return toolError(`Label ${label} does not exist in this repository`);
      }
      const issue: IssueRec = {
        kind: 'issue',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: argString(args, 'body') ?? '',
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
      return toolOk(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      const state = (argString(args, 'state') ?? 'open').toLowerCase();
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return toolOk({ issues: list.map((issue) => issueJson(repo, issue)), total_count: list.length });
    }
    case 'get_issue': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      const number = argNumber(args, 'issue_number', 'number');
      const issue = number === undefined ? undefined : repo.issues.get(number);
      if (issue === undefined) return toolError('Issue not found');
      return toolOk(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      const title = argString(args, 'title');
      const headRaw = argString(args, 'head', 'head_branch');
      const baseRaw = argString(args, 'base', 'base_branch');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        return toolError('title, head and base are required');
      }
      const head = (headRaw.split(':').pop() as string).replace(/^refs\/heads\//, '');
      const base = (baseRaw.split(':').pop() as string).replace(/^refs\/heads\//, '');
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`Head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`Base branch ${base} does not exist`);
      const pull: PullRec = {
        kind: 'pull',
        id: forge.nextNodeId(),
        number: repo.nextNumber,
        title,
        body: argString(args, 'body') ?? '',
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
      return toolOk(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args);
      if (repo === undefined) return toolError('Repository not found');
      const number = argNumber(args, 'pull_number', 'number', 'pullRequestNumber');
      const pull = number === undefined ? undefined : repo.pulls.get(number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.state !== 'open' || pull.merged) return toolError('Pull Request is not mergeable');
      const methodRaw = (argString(args, 'merge_method', 'method') ?? 'squash').toLowerCase();
      const sha = mergePull(repo, pull, methodRaw === 'merge' ? 'merge' : 'squash');
      if (sha === null) return toolError('Pull Request is not mergeable: merge conflict');
      return toolOk({ sha, merged: true, pull_request: pullJson(repo, pull) });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleOne(forge: Forge, message: Json): McpReply {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = 'id' in message ? message.id : undefined;
  const isNotification = id === undefined;
  const params = (message.params ?? {}) as Json;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Json;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      return rpcResult(id, callTool(forge, toolName, args));
    }
    default:
      if (isNotification) return { status: 202 };
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp body. Auth is enforced by the router before this runs. */
export function handleMcp(forge: Forge, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    let status = 200;
    for (const item of parsed) {
      const reply = handleOne(forge, (item ?? {}) as Json);
      if (reply.status === 202) continue;
      status = reply.status;
      replies.push(reply.body);
    }
    if (replies.length === 0) return { status: 202 };
    return { status, body: replies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, -32600, 'Invalid request', 400);
  }
  return handleOne(forge, parsed as Json);
}
