# GitHub Core Clone

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/c/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/aryormdhnn/github-core-clone-01/rank.svg)](https://make.fun/c/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/aryormdhnn/github-core-clone-01/reward.svg)](https://make.fun/c/github-core-clone-01)

A standalone, GitHub-compatible git forge in one process, for the [make.fun](https://make.fun)
github-core-clone-01 bounty. No git binary, no database, no outside service: Node 22
standard library only, one in-memory store, deterministic behaviour.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen, exact object-set negotiation) and
  receive-pack v0 (fast-forward enforcement, per-ref ok/ng report-status in
  sideband). Packfiles are built and parsed by hand (SHA-1 objects, pkt-lines,
  zlib deltas).
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments, pull requests and squash merges, with pagination
  and `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql` — a small self-contained executor for
  viewer, repository, issues, pull requests, the five mutations
  (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment),
  `node(id:)` lookups, `__type` introspection and batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
  (`server/discover`, `initialize`, `tools/list`, `tools/call` with the six
  canonical tools, all sharing the same store as REST).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. The lifecycle is
the harness's: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`
`{"port": N}`, serve, then long-poll `GET $MAKEFUN_ENV_URL/done` until the
trial is over and exit 0. There is nothing to install: the program imports
`node:http` and its own modules only.

## Local verification

Against the kit's sealed suite (`sdk/run.ts`, local runner):

- **120/120 conformance checks** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15
  (feature 600/600, agent 200/200).
- **Performance 155/200** on a fresh server — push 41, clone 32, read 41,
  write 41 points; p50s of 665 / 178 / 1112 / 146 ms against the house
  reference times of 1641 / 267 / 2760 / 349 ms, i.e. faster than the
  reference forge on all four workloads.
- **Total 955/1000**, above the house baseline's ~900.

## Files

| File | What it is |
| --- | --- |
| `main.ts` | The entry <-> env lifecycle (bind, register, poll `/done`, exit 0). |
| `app.ts` | HTTP routing: health, REST, GraphQL, MCP, git. |
| `store.ts` | The in-memory model: repos, git objects, refs, issues, PRs, clock. |
| `gitpack.ts` | SHA-1 objects, packfile parse/build, pkt-line framing, deltas. |
| `git.ts` | Git smart HTTP: advertisements, v2 ls-refs/fetch, v0 fetch/push. |
| `rest.ts` | REST v3. |
| `graphql.ts` | GraphQL v4 parser + executor. |
| `mcp.ts` | MCP JSON-RPC 2.0 handler. |
| `forge.ts` | Shared domain operations (issues, PRs, merges, global ids). |
