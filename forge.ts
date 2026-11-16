// forge.ts — shared domain operations for the GraphQL v4 and MCP surfaces.
// These are the same operations the REST v3 layer performs, factored out so
// all three surfaces read and write the one in-memory store identically:
// creating/closing issues, creating/merging pull requests, adding comments,
// and the opaque stable global ids GraphQL and MCP hand out.
//
// Global ids are base64url of a typed string ("Repository:<id>",
// "Issue:<repoId>:<number>", "PullRequest:<repoId>:<number>",
// "IssueComment:<repoId>:<issueNumber>:<commentId>"). They are opaque and
// stable, and never the bare numeric id.

import { parseCommit } from './gitpack.ts';
import type { Issue, IssueComment, Pull, Repo } from './store.ts';
import type { RestContext } from './rest.ts';

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64url');
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64url');
}

export interface DecodedGlobalId {
  readonly kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment';
  readonly repoId: number;
  readonly number: number;
  readonly commentId: number;
}

/** Decode a global id produced by this module; null when it is not one. */
export function decodeGlobalId(id: unknown): DecodedGlobalId | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0];
  if (kind !== 'Repository' && kind !== 'Issue' && kind !== 'PullRequest' && kind !== 'IssueComment') return null;
  const repoId = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(repoId) || repoId <= 0) return null;
  const number = Number.parseInt(parts[2] ?? '', 10);
  const commentId = Number.parseInt(parts[3] ?? '', 10);
  return {
    kind,
    repoId,
    number: Number.isFinite(number) ? number : 0,
    commentId: Number.isFinite(commentId) ? commentId : 0,
  };
}

export function findRepoById(ctx: RestContext, repoId: number): Repo | undefined {
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return undefined;
}

export function findIssueByGlobalId(
  ctx: RestContext,
  id: unknown,
): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = findRepoById(ctx, decoded.repoId);
  if (repo === undefined) return null;
  const issue = repo.issues.find((i) => i.number === decoded.number);
  if (issue === undefined) return null;
  return { repo, issue };
}

export function findPullByGlobalId(ctx: RestContext, id: unknown): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = findRepoById(ctx, decoded.repoId);
  if (repo === undefined) return null;
  const pull = repo.pulls.find((p) => p.number === decoded.number);
  if (pull === undefined) return null;
  return { repo, pull };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Create an issue (same shape as POST /repos/{o}/{r}/issues). */
export function createIssue(ctx: RestContext, repo: Repo, title: string, body: string): Issue {
  const seq = ctx.store.clock.tick();
  const issue: Issue = {
    id: ctx.store.nextId(),
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels: [],
    createdSeq: seq,
    createdAt: ctx.store.clock.iso(seq),
    updatedAt: ctx.store.clock.iso(seq),
    userLogin: ctx.viewerLogin,
    comments: [],
  };
  repo.nextIssueNumber += 1;
  repo.issues.push(issue);
  return issue;
}

/** Close an issue (same as PATCH .../issues/{n} with state closed). */
export function closeIssue(ctx: RestContext, repo: Repo, issue: Issue): void {
  issue.state = 'closed';
  issue.updatedAt = ctx.store.clock.iso(ctx.store.clock.tick());
  void repo;
}

/**
 * Create a pull request (same validation as POST /repos/{o}/{r}/pulls).
 * Returns an error string when the head/base branches are unusable.
 */
export function createPullRequest(
  ctx: RestContext,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | { error: string } {
  const headSha = ctx.store.refTip(repo, headRef);
  const baseSha = ctx.store.refTip(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) {
    return { error: 'Validation Failed: head or base branch has no commits' };
  }
  const mergeBaseSha = ctx.store.mergeBase(repo, headSha, baseSha);
  if (mergeBaseSha === undefined) {
    return { error: 'Validation Failed: no merge base between head and base' };
  }
  const headCommit = repo.objects.get(headSha);
  const baseCommit = repo.objects.get(mergeBaseSha);
  if (headCommit === undefined || baseCommit === undefined) {
    return { error: 'Validation Failed: missing commit object' };
  }
  const files = ctx.store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  const seq = ctx.store.clock.tick();
  const pull: Pull = {
    id: ctx.store.nextId(),
    number: repo.nextPullNumber,
    title,
    body,
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
  return pull;
}

/**
 * Merge a pull request with a single squash-style merge commit (same as
 * PUT .../pulls/{n}/merge). Returns the merge commit oid, or an error string.
 */
export function mergePullRequest(
  ctx: RestContext,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; error: string } {
  if (pull.state === 'closed') return { ok: false, error: 'Pull Request is already closed' };
  const currentBaseTip = ctx.store.refTip(repo, pull.baseRef);
  if (currentBaseTip === undefined) return { ok: false, error: 'Merge conflict: base branch has no commits' };
  const merged = ctx.store.threeWayMerge(repo, pull.mergeBaseSha, pull.headSha, currentBaseTip);
  if (merged === null) return { ok: false, error: 'Merge conflict: head and base both changed the same files' };
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
  return { ok: true, sha: mergeCommitOid };
}

/** Add a comment to an issue (same as POST .../issues/{n}/comments). */
export function addComment(ctx: RestContext, repo: Repo, issue: Issue, body: string): IssueComment {
  const seq = ctx.store.clock.tick();
  const comment: IssueComment = {
    id: ctx.store.nextId(),
    body: str(body),
    userLogin: ctx.viewerLogin,
    createdAt: ctx.store.clock.iso(seq),
    updatedAt: ctx.store.clock.iso(seq),
  };
  issue.comments.push(comment);
  void repo;
  return comment;
}

/** "MERGEABLE" when a three-way merge would succeed, "CONFLICTING" when not. */
export function pullMergeable(ctx: RestContext, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const currentBaseTip = ctx.store.refTip(repo, pull.baseRef);
  if (currentBaseTip === undefined) return 'UNKNOWN';
  const merged = ctx.store.threeWayMerge(repo, pull.mergeBaseSha, pull.headSha, currentBaseTip);
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}
