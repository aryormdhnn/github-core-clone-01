// rest.ts — the GitHub REST v3 surface (/api/v3). Implements exactly the endpoints
// the sealed conformance suite calls (see kit sdk/conformance/checks-rest.ts):
// repositories, branches, commits, contents, labels, issues, comments, pull
// requests and merges. Every reply is JSON with a non-empty X-GitHub-Request-Id;
// errors are JSON {"message": string}. Auth: every call needs
// Authorization: Bearer <MAKEFUN_SHOP_TOKEN>; anything else is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, DEFAULT_BRANCH, type Repo, type Issue, type Pull } from './store.ts';
import { parseCommit } from './gitpack.ts';

export interface RestContext {
  readonly store: Store;
  readonly token: string;
  readonly viewerLogin: string;
  readonly viewerId: number;
}

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; on syntax error returns null and the caller answers 400. */
export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// serializers (GitHub-shaped; the checks assert a minimum, extra fields are allowed)
// -------------------------------------------------------------------------------------------

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === ctx.viewerLogin ? ctx.viewerId : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: { login: issue.userLogin, id: issue.userLogin === ctx.viewerLogin ? ctx.viewerId : 0, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: { login: ctx.viewerLogin, id: ctx.viewerId, type: 'User' },
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: repo.owner, type: 'User' },
      repo: repoJson(ctx, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: repo.owner, type: 'User' },
      repo: repoJson(ctx, repo),
    },
    merged: pull.merged,
    mergeable: true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

// -------------------------------------------------------------------------------------------
// routing
// -------------------------------------------------------------------------------------------

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: (ctx: RestContext, req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, url: URL) => Promise<void>;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a /api/v3 path into decoded segments (a contents path keeps its slashes). */
function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map(decodeSegment);
}

async function handleRoot(ctx: RestContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(
    res,
    200,
    {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?repository_id={repository_id}&q={query}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/user/starred/gists',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

async function handleMeta(_ctx: RestContext, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
}

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, perPageRaw)) : 30;
  return { page, perPage };
}

/** GitHub-style Link header for a paginated list. */
function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
  const link = (p: number, rel: string): string => `<${base}?page=${p}&per_page=${perPage}>; rel="${rel}"`;
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'));
  if (page > 1) parts.push(link(page - 1, 'prev'));
  parts.push(link(1, 'first'));
  parts.push(link(totalPages, 'last'));
  return parts.join(', ');
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function repoOr404(ctx: RestContext, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/v3\/?$/,
    handler: async (ctx, req, res) => {
      await handleRoot(ctx, req, res);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/meta$/,
    handler: async (ctx, req, res) => {
      await handleMeta(ctx, req, res);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/user\/repos$/,
    handler: async (ctx, req, res) => {
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const name = str(input.name);
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      if (ctx.store.getRepo(ctx.viewerLogin, name) !== undefined) {
        sendError(res, 422, `Validation Failed: name already exists on this account`);
        return;
      }
      const repo = ctx.store.createRepo(ctx.viewerLogin, name, bool(input.private, false), str(input.description));
      sendJson(res, 201, repoJson(ctx, repo));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/user\/repos$/,
    handler: async (ctx, req, res, _match, url) => {
      const { page, perPage } = pageParams(url);
      const repos = ctx.store.listReposByOwner(ctx.viewerLogin);
      const items = paginate(repos, page, perPage).map((r) => repoJson(ctx, r));
      sendJson(res, 200, items, { link: linkHeader(req, url, page, perPage, repos.length) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      sendJson(res, 200, repoJson(ctx, repo));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      if (typeof input.description === 'string') repo.description = input.description;
      sendJson(res, 200, repoJson(ctx, repo));
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      ctx.store.deleteRepo(repo.owner, repo.name);
      sendNoContent(res);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const ref = str(input.ref);
      const sha = str(input.sha);
      if (ref === '' || !/^refs\//.test(ref)) {
        sendError(res, 422, 'Validation Failed: ref must start with refs/');
        return;
      }
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') {
        sendError(res, 422, 'Validation Failed: sha is not a commit');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      sendJson(res, 200, branches);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/,
    handler: async (ctx, _req, res, match, url) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const shaParam = url.searchParams.get('sha');
      const tip =
        shaParam !== null
          ? ctx.store.resolveRef(repo, decodeURIComponent(shaParam))
          : ctx.store.refTip(repo, repo.defaultBranch);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return;
      }
      const commits = ctx.store.reachableCommits(repo, tip).map((oid) => {
        const obj = repo.objects.get(oid) as { type: 'commit'; data: Buffer };
        const info = parseCommit(obj.data);
        return {
          sha: oid,
          commit: {
            message: info.message,
            author: { name: ctx.viewerLogin, email: `${ctx.viewerLogin}@example.invalid` },
            committer: { name: ctx.viewerLogin, email: `${ctx.viewerLogin}@example.invalid` },
            tree: { sha: info.tree },
          },
          author: { login: ctx.viewerLogin },
          committer: { login: ctx.viewerLogin },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      sendJson(res, 200, commits);
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const path = (match[3] as string).split('/').map(decodeSegment).join('/');
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const message = str(input.message, 'Update file');
      const contentB64 = str(input.content);
      const branch = str(input.branch, repo.defaultBranch);
      const sha = str(input.sha);
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(contentB64, 'base64');
      } catch {
        sendError(res, 422, 'Validation Failed: content is not valid base64');
        return;
      }
      const tip = ctx.store.refTip(repo, branch);
      const existing = tip !== undefined ? ctx.store.readPath(repo, tip, path) : undefined;
      const isUpdate = existing !== undefined && existing.kind === 'blob';
      if (isUpdate && sha !== '' && sha.toLowerCase() !== (existing as { oid: string }).oid.toLowerCase()) {
        sendError(res, 409, 'Conflict: sha does not match the current blob');
        return;
      }
      if (isUpdate && sha === '') {
        sendError(res, 409, 'Conflict: sha is required to update a file');
        return;
      }
      const blobOid = ctx.store.putObject(repo, { type: 'blob', data: contentBytes });
      const baseTreeOid = tip !== undefined ? parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree : '';
      const newTreeOid = ctx.store.setPathInTree(repo, baseTreeOid, path.split('/'), blobOid);
      const parents = tip !== undefined ? [tip] : [];
      const commitOid = ctx.store.commitOnBranch(repo, branch, message, newTreeOid, parents);
      sendJson(res, isUpdate ? 200 : 201, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: contentBytes.length,
          encoding: 'base64',
          content: contentB64,
          type: 'file',
        },
        commit: { sha: commitOid, message },
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)$/,
    handler: async (ctx, _req, res, match, url) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const path = (match[3] as string).split('/').filter((s) => s !== '').map(decodeSegment).join('/');
      const refParam = url.searchParams.get('ref');
      const branch = refParam !== null ? decodeURIComponent(refParam) : repo.defaultBranch;
      const tip = ctx.store.refTip(repo, branch);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const found = ctx.store.readPath(repo, tip, path);
      if (found === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (found.kind === 'blob') {
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: found.data.toString('base64'),
          sha: found.oid,
          size: found.data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
        return;
      }
      const entries = found.entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      }));
      sendJson(res, 200, entries);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const path = (match[3] as string).split('/').map(decodeSegment).join('/');
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const message = str(input.message, 'Delete file');
      const sha = str(input.sha);
      const branch = str(input.branch, repo.defaultBranch);
      const tip = ctx.store.refTip(repo, branch);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const existing = ctx.store.readPath(repo, tip, path);
      if (existing === undefined || existing.kind !== 'blob') {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (sha !== '' && sha.toLowerCase() !== existing.oid.toLowerCase()) {
        sendError(res, 409, 'Conflict: sha does not match the current blob');
        return;
      }
      const baseTreeOid = parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
      const newTreeOid = ctx.store.setPathInTree(repo, baseTreeOid, path.split('/'), null);
      const commitOid = ctx.store.commitOnBranch(repo, branch, message, newTreeOid, [tip]);
      sendJson(res, 200, { commit: { sha: commitOid, message } });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const name = str(input.name);
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return;
      }
      const color = str(input.color, 'ededed');
      repo.labels.set(name, { name, color });
      sendJson(res, 201, { name, color });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const title = str(input.title);
      const labelsInput: string[] = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
      for (const label of labelsInput) {
        if (!repo.labels.has(label)) {
          sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
          return;
        }
      }
      const seq = ctx.store.clock.tick();
      const issue: Issue = {
        id: ctx.store.nextId(),
        number: repo.nextIssueNumber,
        title,
        body: str(input.body),
        state: 'open',
        labels: labelsInput,
        createdSeq: seq,
        createdAt: ctx.store.clock.iso(seq),
        updatedAt: ctx.store.clock.iso(seq),
        userLogin: ctx.viewerLogin,
        comments: [],
      };
      repo.nextIssueNumber += 1;
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(ctx, repo, issue));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
    handler: async (ctx, _req, res, match, url) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      const { page, perPage } = pageParams(url);
      let items = [...repo.issues];
      if (state !== 'all') items = items.filter((i) => i.state === state);
      if (sort === 'created') {
        items.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const total = items.length;
      const pageItems = paginate(items, page, perPage).map((i) => issueJson(ctx, repo, i));
      sendJson(res, 200, pageItems, { link: linkHeader(_req, url, page, perPage, total) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, issueJson(ctx, repo, issue));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      if (input.state === 'open' || input.state === 'closed') {
        issue.state = input.state;
        issue.updatedAt = ctx.store.clock.iso(ctx.store.clock.tick());
      }
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      sendJson(res, 200, issueJson(ctx, repo, issue));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const seq = ctx.store.clock.tick();
      const comment = {
        id: ctx.store.nextId(),
        body: str(input.body),
        userLogin: ctx.viewerLogin,
        createdAt: ctx.store.clock.iso(seq),
        updatedAt: ctx.store.clock.iso(seq),
      };
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        body: comment.body,
        user: { login: comment.userLogin, type: 'User' },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(
        res,
        200,
        issue.comments.map((c) => ({
          id: c.id,
          body: c.body,
          user: { login: c.userLogin, type: 'User' },
          created_at: c.createdAt,
          updated_at: c.updatedAt,
        })),
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const input = asObject(body);
      const headRef = str(input.head);
      const baseRef = str(input.base, repo.defaultBranch);
      const headSha = ctx.store.refTip(repo, headRef);
      const baseSha = ctx.store.refTip(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        sendError(res, 422, 'Validation Failed: head or base branch has no commits');
        return;
      }
      const mergeBaseSha = ctx.store.mergeBase(repo, headSha, baseSha);
      if (mergeBaseSha === undefined) {
        sendError(res, 422, 'Validation Failed: no merge base between head and base');
        return;
      }
      const headCommit = repo.objects.get(headSha) as { data: Buffer };
      const baseCommit = repo.objects.get(baseSha) as { data: Buffer };
      const files = ctx.store.diffTrees(
        repo,
        parseCommit((repo.objects.get(mergeBaseSha) as { data: Buffer }).data).tree,
        parseCommit(headCommit.data).tree,
      );
      const seq = ctx.store.clock.tick();
      const pull: Pull = {
        id: ctx.store.nextId(),
        number: repo.nextPullNumber,
        title: str(input.title),
        body: str(input.body),
        state: 'open',
        headRef,
        headSha,
        baseRef,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeBaseSha,
        files,
        createdSeq: seq,
        createdAt: ctx.store.clock.iso(seq),
        updatedAt: ctx.store.clock.iso(seq),
      };
      repo.nextPullNumber += 1;
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(ctx, repo, pull));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
    handler: async (ctx, _req, res, match, url) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const state = url.searchParams.get('state') ?? 'open';
      const { page, perPage } = pageParams(url);
      let items = [...repo.pulls];
      if (state !== 'all') items = items.filter((p) => p.state === state);
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const total = items.length;
      const pageItems = paginate(items, page, perPage).map((p) => pullJson(ctx, repo, p));
      sendJson(res, 200, pageItems, { link: linkHeader(_req, url, page, perPage, total) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, pullJson(ctx, repo, pull));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/,
    handler: async (ctx, _req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(
        res,
        200,
        pull.files.map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        })),
      );
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/,
    handler: async (ctx, req, res, match) => {
      const repo = repoOr404(ctx, res, decodeSegment(match[1] as string), decodeSegment(match[2] as string));
      if (repo === null) return;
      const number = Number.parseInt(match[3] as string, 10);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (pull.state === 'closed') {
        sendError(res, 405, 'Pull Request is already closed');
        return;
      }
      const raw = await readBody(req);
      const body = parseJsonBody(raw);
      if (body === null) {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
      const currentBaseTip = ctx.store.refTip(repo, pull.baseRef);
      if (currentBaseTip === undefined) {
        sendError(res, 405, 'Merge conflict: base branch has no commits');
        return;
      }
      const merged = ctx.store.threeWayMerge(repo, pull.mergeBaseSha, pull.headSha, currentBaseTip);
      if (merged === null) {
        sendError(res, 405, 'Merge conflict: head and base both changed the same files');
        return;
      }
      const mergedTreeOid = ctx.store.buildTreeFromPaths(repo, merged);
      const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
      const mergeCommitOid = ctx.store.commitOnBranch(repo, pull.baseRef, message, mergedTreeOid, [currentBaseTip]);
      pull.state = 'closed';
      pull.merged = true;
      const seq = ctx.store.clock.tick();
      pull.mergedAt = ctx.store.clock.iso(seq);
      pull.mergeCommitSha = mergeCommitOid;
      pull.baseSha = mergeCommitOid;
      pull.updatedAt = pull.mergedAt;
      sendJson(res, 200, { merged: true, sha: mergeCommitOid, message: 'Pull Request successfully merged' });
    },
  },
];

/** Dispatch one request under /api/v3. Returns true when handled (always true for /api/v3 paths). */
export async function handleRest(ctx: RestContext, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // Auth: every /api/v3 call needs the trial's bearer token.
  const auth = req.headers.authorization ?? '';
  if (ctx.token !== '' && auth !== `Bearer ${ctx.token}`) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match !== null) {
      try {
        await route.handler(ctx, req, res, match, url);
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      }
      return true;
    }
  }
  sendError(res, 404, 'Not Found');
  return true;
}

export { segmentsOf };
