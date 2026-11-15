// The forge's HTTP server: one in-memory Forge behind four surfaces —
// git smart HTTP, the REST v3 API, GraphQL, and the MCP endpoint.
//
// Routing notes:
// - Every response carries a non-empty X-GitHub-Request-Id, as GitHub's does.
// - Auth is a bearer token: when MAKEFUN_SHOP_TOKEN is set it must match
//   exactly; the token's owner is the viewer for every surface. With no
//   token configured (local development), any non-empty bearer is accepted.
// - Bodies are read fully before dispatch; malformed JSON on the REST
//   surface is a 400, on the MCP surface a JSON-RPC parse error.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { handleMcp } from './lib/mcp.ts';
import { handleGraphql } from './lib/graphql.ts';
import { infoRefsBody, receivePack, uploadPack } from './lib/githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

function sendJson(
  res: ServerResponse,
  requestId: string,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendBuffer(
  res: ServerResponse,
  requestId: string,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendEmpty(res: ServerResponse, requestId: string, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId });
  res.end();
}

/** The bearer-token check shared by the API, GraphQL, MCP and git surfaces. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return false;
  const presented = (match[1] as string).trim();
  if (presented === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  return presented === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(forge: Forge = new Forge()): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, req, res).catch(() => {
      // A handler failure must never take the server down with it.
      if (!res.headersSent) {
        sendJson(res, nextRequestId(), 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, requestId, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot check: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, requestId, 200, { ok: true });
    return;
  }

  // ---- REST v3 -------------------------------------------------------------
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
          return;
        }
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const host = req.headers.host ?? 'localhost';
    const reply = handleRest(forge, {
      method,
      segments,
      query: url.searchParams,
      body,
      origin: `http://${host}`,
    });
    if (reply.status === 204 || reply.body === undefined) {
      sendEmpty(res, requestId, reply.status);
      return;
    }
    sendJson(res, requestId, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  // ---- GraphQL -------------------------------------------------------------
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { errors: [{ message: 'Method not allowed' }] });
      return;
    }
    const raw = await readBody(req);
    const reply = handleGraphql(forge, raw.toString('utf8'));
    sendJson(res, requestId, reply.status, reply.body);
    return;
  }

  // ---- MCP -----------------------------------------------------------------
  if (path === '/mcp') {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Unauthorized' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method not allowed' });
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(forge, raw.toString('utf8'));
    if (reply.status === 202 || reply.body === undefined) {
      sendEmpty(res, requestId, 202);
      return;
    }
    sendJson(res, requestId, reply.status, reply.body);
    return;
  }

  // ---- git smart HTTP --------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeSegment(gitMatch[1] as string);
    const repoName = decodeSegment(gitMatch[2] as string);
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }
    const route = gitMatch[3] as string;
    if (route === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, requestId, 400, { message: 'Unknown service' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && /(?:^|:)version=2(?:$|:)/.test(protocol);
      const body = infoRefsBody(repo, service, v2);
      sendBuffer(res, requestId, 200, body, `application/x-${service}-advertisement`);
      return;
    }
    const raw = await readBody(req);
    if (route === 'git-upload-pack') {
      sendBuffer(res, requestId, 200, uploadPack(repo, raw), 'application/x-git-upload-pack-result');
      return;
    }
    sendBuffer(res, requestId, 200, receivePack(repo, raw), 'application/x-git-receive-pack-result');
    return;
  }

  sendJson(res, requestId, 404, { message: 'Not Found' });
}
