// app.ts — the forge's HTTP surface: the health probe, the REST v3 API, the
// GraphQL v4 API, the MCP endpoint and git smart HTTP, all from one in-memory
// store. Routing is by path prefix; every API reply is JSON.
//
// The token owner: the suite's bearer token belongs to the scenario viewer
// (wire.ts Scenario.viewer). The scenario is public and fixed for this
// competition (SCENARIO_SEED 0x6a09e667f3bcc909n), so the viewer login is the
// constant "adaiversen" (id 1000); the stranger login is "olgabauer". A repo
// created through POST /user/repos belongs to the viewer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, DEFAULT_BRANCH } from './store.ts';
import { handleRest, sendError, sendJson, type RestContext } from './rest.ts';
import { handleGit } from './git.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

/** The login the trial's bearer token names (scenario viewer, id 1000). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
/** The scenario stranger login (used only as a foreign owner in checks). */
export const STRANGER_LOGIN = 'olgabauer';

/** The epoch the logical clock starts from: the trial's opening time when set. */
function clockStartEpochSec(): number {
  const now = process.env.MAKEFUN_TRIAL_NOW;
  if (now !== undefined && now !== '') {
    const ms = Date.parse(now);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 1735689600; // 2025-01-01T00:00:00Z
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(VIEWER_LOGIN, clockStartEpochSec());
  const ctx: RestContext = { store, token, viewerLogin: VIEWER_LOGIN, viewerId: VIEWER_ID };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // GitHub REST v3.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      void handleRest(ctx, req, res);
      return;
    }

    // GitHub GraphQL v4.
    if (path === '/api/graphql') {
      void handleGraphql(ctx, req, res);
      return;
    }

    // Model Context Protocol (streamable HTTP).
    if (path === '/mcp') {
      void handleMcp(ctx, req, res);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    if (gitMatch !== null) {
      void handleGit(ctx, req, res, gitMatch[1] as string, gitMatch[2] as string, gitMatch[3] as string);
      return;
    }

    // Anything else: GitHub's 404 body.
    sendError(res, 404, 'Not Found');
  });
}

export { DEFAULT_BRANCH };
