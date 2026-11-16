// mcp.ts — Model Context Protocol over Streamable HTTP (/mcp), JSON-RPC 2.0.
//
// Transport facts (from sdk/conformance/mcp-client.ts):
// - POST {baseUrl}/mcp, plain-JSON answers are accepted (SSE is optional).
// - Modern era: the client probes `server/discover` first; a result makes it
//   modern with revision 2026-07-28. Legacy handshake (initialize with an
//   offered revision) is the fallback; this server answers discover, so the
//   modern path is taken.
// - `tools/list` must return at least the six canonical tools (by name or
//   alias/suffix match), each with a non-empty description and an inputSchema
//   {type: "object"}; two consecutive lists must be byte-identical.
// - `tools/call` answers content blocks of text (a JSON string) and/or
//   structuredContent; effects must be visible over REST v3 with the same ids.
// - Unknown tool -> JSON-RPC -32602 or -32601, never HTTP 500. Missing
//   arguments -> -32602 or a result with isError: true. Non-JSON body ->
//   HTTP 400 with JSON-RPC -32700. No Authorization header -> HTTP 401,
//   decided before tool existence.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, repoJson, sendError, sendJson, type RestContext } from './rest.ts';
import type { Repo } from './store.ts';
import { addComment, closeIssue, createIssue, createPullRequest, mergePullRequest } from './forge.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string; readonly description?: string }>;
    readonly required: string[];
  };
}

/** The six canonical tools. This array is a module constant so two
 * tools/list calls serialize byte-identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
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
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const CANONICAL = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a tool name the way the suite does: exact normalized match, then
 * suffix match (a server prefix is allowed). */
function findTool(name: string): ToolDef | undefined {
  const wanted = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === wanted) return tool;
  }
  for (const tool of TOOLS) {
    const normalized = normalizeName(tool.name);
    if (normalized.length > wanted.length && normalized.endsWith(wanted)) return tool;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strArg(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string') return value;
  }
  return '';
}

function numArg(args: Record<string, unknown>, ...names: string[]): number {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function boolArg(args: Record<string, unknown>, ...names: string[]): boolean {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'boolean') return value;
  }
  return false;
}

interface ToolResult {
  readonly content: Array<{ readonly type: 'text'; readonly text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

function toolOk(result: unknown): ToolResult {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoOrError(ctx: RestContext, owner: string, repo: string): Repo | ToolResult {
  const found = ctx.store.getRepo(owner, repo);
  if (found === undefined) return toolError(`repository not found: ${owner}/${repo}`);
  return found;
}

function callTool(ctx: RestContext, name: string, args: Record<string, unknown>): ToolResult {
  const tool = findTool(name);
  if (tool === undefined) throw { code: -32601, message: `Method not found: ${name}` };
  switch (tool.name) {
    case 'create_repo': {
      const owner = strArg(args, 'owner', 'owner_login', 'login') || ctx.viewerLogin;
      const repoName = strArg(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
      if (repoName === '') return toolError('Missing required argument: name');
      if (ctx.store.getRepo(owner, repoName) !== undefined) {
        return toolError(`repository already exists: ${owner}/${repoName}`);
      }
      const repo = ctx.store.createRepo(
        owner,
        repoName,
        boolArg(args, 'private', 'is_private'),
        strArg(args, 'description', 'about', 'summary', 'body'),
      );
      return toolOk(repoJson(ctx, repo));
    }
    case 'get_repo': {
      const owner = strArg(args, 'owner', 'owner_login', 'login');
      const repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const repo = repoOrError(ctx, owner, repoName);
      if ('content' in repo) return repo;
      return toolOk(repoJson(ctx, repo as Repo));
    }
    case 'create_issue': {
      const owner = strArg(args, 'owner', 'owner_login', 'login');
      const repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const title = strArg(args, 'title', 'issue_title', 'subject');
      if (title === '') return toolError('Missing required argument: title');
      const repo = repoOrError(ctx, owner, repoName);
      if ('content' in repo) return repo;
      const issue = createIssue(ctx, repo as Repo, title, strArg(args, 'body', 'issue_body', 'description', 'content', 'text'));
      return toolOk({
        id: issue.id,
        node_id: `I_${issue.id}`,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        user: { login: issue.userLogin, type: 'User' },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        html_url: `https://github.com/${(repo as Repo).fullName}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const owner = strArg(args, 'owner', 'owner_login', 'login');
      const repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const state = strArg(args, 'state', 'status') || 'open';
      const repo = repoOrError(ctx, owner, repoName);
      if ('content' in repo) return repo;
      const found = (repo as Repo).issues.filter((i) => state === 'all' || i.state === state);
      return toolOk({
        issues: found.map((i) => ({
          id: i.id,
          node_id: `I_${i.id}`,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          created_at: i.createdAt,
          updated_at: i.updatedAt,
        })),
      });
    }
    case 'create_pull_request': {
      const owner = strArg(args, 'owner', 'owner_login', 'login');
      const repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const title = strArg(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = strArg(args, 'head', 'head_ref', 'head_branch', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
      const base = strArg(args, 'base', 'base_ref', 'base_branch', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
      if (title === '' || head === '' || base === '') {
        return toolError('Missing required argument: title, head, and base are required');
      }
      const repo = repoOrError(ctx, owner, repoName);
      if ('content' in repo) return repo;
      const created = createPullRequest(ctx, repo as Repo, title, strArg(args, 'body', 'description', 'content', 'text'), head, base);
      if ('error' in created) return toolError(created.error);
      return toolOk({
        id: created.id,
        node_id: `PR_${created.id}`,
        number: created.number,
        pull_number: created.number,
        pull_request_number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
        merged: created.merged,
        created_at: created.createdAt,
        updated_at: created.updatedAt,
        html_url: `https://github.com/${(repo as Repo).fullName}/pull/${created.number}`,
      });
    }
    case 'merge_pull_request': {
      const owner = strArg(args, 'owner', 'owner_login', 'login');
      const repoName = strArg(args, 'repo', 'repository', 'repository_name', 'repo_name');
      const number = numArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
      if (number === 0) return toolError('Missing required argument: pull_number');
      const repo = repoOrError(ctx, owner, repoName);
      if ('content' in repo) return repo;
      const pull = (repo as Repo).pulls.find((p) => p.number === number);
      if (pull === undefined) return toolError(`pull request not found: #${number}`);
      const merged = mergePullRequest(ctx, repo as Repo, pull);
      if (!merged.ok) return toolError(merged.error);
      return toolOk({
        id: pull.id,
        node_id: `PR_${pull.id}`,
        number: pull.number,
        pull_number: pull.number,
        pull_request_number: pull.number,
        title: pull.title,
        state: pull.state,
        merged: pull.merged,
        merged_at: pull.mergedAt,
        merge_commit_sha: pull.mergeCommitSha,
        sha: pull.mergeCommitSha,
      });
    }
    default:
      throw { code: -32601, message: `Method not found: ${name}` };
  }
}

function sendRpc(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function sendRpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export async function handleMcp(ctx: RestContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  // Auth is decided before method dispatch or tool existence.
  const auth = req.headers.authorization ?? '';
  if (ctx.token !== '' && auth !== `Bearer ${ctx.token}`) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const raw = await readBody(req);
  let request: unknown;
  try {
    request = JSON.parse(raw.toString('utf8'));
  } catch {
    sendRpcError(res, null, -32700, 'Parse error', 400);
    return;
  }
  if (!isObject(request) || typeof request.method !== 'string') {
    sendRpcError(res, isObject(request) ? request.id : null, -32600, 'Invalid Request', 400);
    return;
  }
  const id = request.id;
  const method = request.method;
  const params = isObject(request.params) ? request.params : {};

  // Notifications carry no id and expect no JSON-RPC response.
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }

  try {
    switch (method) {
      case 'server/discover': {
        sendRpc(res, id, {
          supportedVersions: [REVISION],
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'A standalone GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, REST v3, GraphQL v4.',
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
        return;
      }
      case 'initialize': {
        sendRpc(res, id, {
          protocolVersion: REVISION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case 'ping': {
        sendRpc(res, id, {});
        return;
      }
      case 'tools/list': {
        sendRpc(res, id, { tools: TOOLS });
        return;
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = isObject(params.arguments) ? params.arguments : {};
        // Missing name or arguments entirely: the missing-arguments check
        // calls create_issue with {} and accepts -32602 or isError: true.
        if (name === '') {
          sendRpcError(res, id, -32602, 'Invalid params: tool name is required');
          return;
        }
        const result = callTool(ctx, name, args);
        sendRpc(res, id, result);
        return;
      }
      default: {
        sendRpcError(res, id, -32601, `Method not found: ${method}`);
        return;
      }
    }
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'number') {
      const rpcErr = err as { code: number; message: string };
      sendRpcError(res, id, rpcErr.code, rpcErr.message);
      return;
    }
    // A tool failure must never surface as HTTP 500.
    sendRpcError(res, id, -32603, err instanceof Error ? err.message : 'Internal error');
  }
}
