# makefun-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gaiaoagoaia-art/forge-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gaiaoagoaia-art/forge-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small, standalone GitHub-compatible git forge in a single Node process —
no dependencies, no database, no git binary. Everything lives in memory and
is served from one store behind four surfaces:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with exact object
  selection, shallow clones and deepening) plus the v0 fallback, and
  `git-receive-pack` with per-ref report-status: fast-forward enforcement,
  mixed ok/ng pushes, deletes, and thin-pack resolution against the store.
  Packs are written without deltas and read with full OFS/REF delta support.
- **REST v3** — repositories, branches, commits, contents (create, read,
  update with sha checks, delete), labels, issues with comments, and pull
  requests with merge-base diffs and squash/merge three-way merges. Issue
  and PR numbers share one per-repo counter, as on GitHub.
- **GraphQL** — a hand-written lexer, parser and executor covering the
  viewer/repository/issue/pull-request graph, connections with cursor
  pagination, global node ids, the create/close/reopen issue and
  create/merge pull-request mutations, `addComment`, and introspection
  (`__type`, `__schema`) driven by a schema table.
- **MCP** — JSON-RPC over `POST /mcp` in both protocol eras
  (`server/discover` and legacy `initialize`), a static `tools/list`, and
  six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) that share the REST surface's
  domain logic, so ids and state agree across protocols.

Auth is one bearer token; its owner is the viewer on every surface.

## Run it

In a make.fun trial the env drives the lifecycle: the process binds an
ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, and polls
`$MAKEFUN_ENV_URL/done` until the trial ends.

```sh
node --experimental-strip-types main.ts
```

For local development, leave `MAKEFUN_ENV_URL` unset and the forge serves
on `$PORT` (default 8080) until killed:

```sh
MAKEFUN_SHOP_TOKEN=dev PORT=8080 node --experimental-strip-types main.ts
curl -H 'Authorization: Bearer dev' http://127.0.0.1:8080/api/v3/user
```

## Layout

- `main.ts` — the entry ↔ env lifecycle.
- `app.ts` — the HTTP router: auth, request ids, body handling.
- `lib/gitobj.ts` — SHA-1 object model, pack read/write, pkt-lines.
- `lib/store.ts` — the in-memory forge: repos, refs, tree surgery, merges.
- `lib/githttp.ts` — the smart-HTTP protocol.
- `lib/rest.ts`, `lib/graphql.ts`, `lib/mcp.ts` — the three API surfaces.
