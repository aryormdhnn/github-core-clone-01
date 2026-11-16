// store.ts — the forge's in-memory data model: repositories, git objects, refs,
// issues, labels, comments and pull requests, plus the git graph operations the
// REST and git surfaces share (ancestry, merge-base, three-way merge, tree edits).
// Everything lives in memory; the repo is mounted read-only at grading time, and
// timestamps come from a logical clock (deterministic, strictly increasing) so
// ordering checks hold and live/replay runs cannot diverge on wall-clock reads.

import {
  oidOf,
  parseCommit,
  buildCommit,
  parseTree,
  buildTree,
  type GitObject,
  type TreeEntry,
} from './gitpack.ts';

export const DEFAULT_BRANCH = 'main';
export const FORGE_AUTHOR_NAME = 'forge';
export const FORGE_AUTHOR_EMAIL = 'forge@example.invalid';

/** Logical clock: seconds since the trial's fixed epoch, +1 per tick. */
export class Clock {
  private current: number;
  constructor(startEpochSec: number) {
    this.current = startEpochSec;
  }
  tick(): number {
    this.current += 1;
    return this.current;
  }
  peek(): number {
    return this.current;
  }
  iso(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString();
  }
}

export interface Label {
  readonly name: string;
  readonly color: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  readonly userLogin: string;
  comments: IssueComment[];
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  headSha: string;
  readonly baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly mergeBaseSha: string;
  files: PullFile[];
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  description: string;
  readonly private: boolean;
  readonly defaultBranch: string;
  readonly refs: Map<string, string>;
  readonly objects: Map<string, GitObject>;
  issues: Issue[];
  nextIssueNumber: number;
  readonly labels: Map<string, Label>;
  pulls: Pull[];
  nextPullNumber: number;
  readonly createdSeq: number;
  readonly createdAt: string;
}

export interface DiffLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** A tiny LCS line diff (blobs here are a few KiB at most). */
export function diffLines(oldText: string, newText: string): DiffLineCounts {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length;
  const m = b.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[m] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly clock: Clock;
  private nextRepoId = 1;
  private nextGlobalId = 1;
  readonly viewerLogin: string;

  constructor(viewerLogin: string, clockStartEpochSec: number) {
    this.viewerLogin = viewerLogin;
    this.clock = new Clock(clockStartEpochSec);
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const seq = this.clock.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      nextIssueNumber: 1,
      labels: new Map<string, Label>(),
      pulls: [],
      nextPullNumber: 1,
      createdSeq: seq,
      createdAt: this.clock.iso(seq),
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextId(): number {
    const id = this.nextGlobalId;
    this.nextGlobalId += 1;
    return id;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, obj: GitObject): string {
    const oid = oidOf(obj.type, obj.data);
    repo.objects.set(oid, obj);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The commit oid a ref (full name, or a branch/tag short name) points at. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const head = repo.refs.get(`refs/heads/${ref}`);
    if (head !== undefined) return head;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
    return undefined;
  }

  refTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** All refs reachable from `tip`, tip first, parents after (depth-first, first-parent biased). */
  reachableCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      const info = parseCommit(obj.data);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) {
        stack.push(info.parents[i] as string);
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base of two tips: the first common ancestor found walking from `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsB = new Set(this.reachableCommits(repo, b));
    const seen = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (ancestorsB.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
    return undefined;
  }

  /** Flatten a commit's tree to path -> blob oid (files only). */
  flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(repo, entry.oid, path, out);
      } else {
        out.set(path, entry.oid);
      }
    }
  }

  /** Rebuild nested trees from a flat path -> blob oid map; stores the trees. */
  buildTreeFromPaths(repo: Repo, paths: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, oid] of paths) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    return build(root);
  }

  /**
   * Set (or delete, when blobOid is null) one path in the tree of `baseTreeOid`,
   * storing every new intermediate tree. Returns the new root tree oid.
   */
  setPathInTree(repo: Repo, baseTreeOid: string, pathParts: readonly string[], blobOid: string | null): string {
    const setIn = (treeOid: string, parts: readonly string[]): string => {
      const obj = repo.objects.get(treeOid);
      const entries: TreeEntry[] = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
      const [head, ...tail] = parts as [string, ...string[]];
      if (tail.length === 0) {
        const idx = entries.findIndex((e) => e.name === head);
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name: head, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name: head, oid: blobOid });
        }
      } else {
        const idx = entries.findIndex((e) => e.name === head);
        let childOid: string;
        if (idx >= 0 && entries[idx]?.mode === '40000') {
          childOid = setIn(entries[idx]!.oid, tail);
        } else {
          // No such directory (or a file sits there): build a fresh subtree.
          childOid = setIn('', tail);
          if (idx >= 0) entries.splice(idx, 1);
        }
        // Drop the directory if it became empty.
        const childObj = repo.objects.get(childOid);
        const childEmpty = childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length === 0;
        if (childEmpty) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name: head, oid: childOid };
        } else {
          entries.push({ mode: '40000', name: head, oid: childOid });
        }
      }
      const data = buildTree(entries);
      return this.putObject(repo, { type: 'tree', data });
    };
    if (baseTreeOid === '') {
      const data = buildTree([]);
      const emptyOid = this.putObject(repo, { type: 'tree', data });
      return setIn(emptyOid, pathParts);
    }
    return setIn(baseTreeOid, pathParts);
  }

  /** Read one path out of a commit's tree: a blob (with bytes) or a directory listing. */
  readPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'blob'; oid: string; data: Buffer } | { kind: 'tree'; entries: TreeEntry[] } | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const treeOid = parseCommit(commit.data).tree;
    if (path === '' || path === '/') {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined) return undefined;
      return { kind: 'tree', entries: parseTree(tree.data) };
    }
    const parts = path.split('/').filter((p) => p !== '');
    let currentTreeOid = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] as string;
      const tree = repo.objects.get(currentTreeOid);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((e) => e.name === part);
      if (entry === undefined) return undefined;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const sub = repo.objects.get(entry.oid);
          if (sub === undefined) return undefined;
          return { kind: 'tree', entries: parseTree(sub.data) };
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return undefined;
        return { kind: 'blob', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return undefined;
      currentTreeOid = entry.oid;
    }
    return undefined;
  }

  /** Create a commit object, store it, and move `branch` to it. Returns the commit oid. */
  commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: readonly string[]): string {
    const epochSec = this.clock.tick();
    const stamp = `${epochSec} +0000`;
    const author = `${this.viewerLogin} <${this.viewerLogin}@example.invalid> ${stamp}`;
    const data = buildCommit({ tree: treeOid, parents, author, committer: author, message });
    const oid = this.putObject(repo, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The diff between two trees as pull files (added/modified/removed with line counts). */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
    const base = new Map<string, string>();
    const head = new Map<string, string>();
    if (baseTreeOid !== '') this.flattenTree(repo, baseTreeOid, '', base);
    if (headTreeOid !== '') this.flattenTree(repo, headTreeOid, '', head);
    const files: PullFile[] = [];
    const all = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...all].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === h) continue;
      if (b === undefined && h !== undefined) {
        const blob = repo.objects.get(h);
        const text = blob !== undefined ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length;
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (h === undefined && b !== undefined) {
        const blob = repo.objects.get(b);
        const text = blob !== undefined ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length;
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b !== undefined && h !== undefined) {
        const oldBlob = repo.objects.get(b);
        const newBlob = repo.objects.get(h);
        const counts = diffLines(
          oldBlob !== undefined ? oldBlob.data.toString('utf8') : '',
          newBlob !== undefined ? newBlob.data.toString('utf8') : '',
        );
        files.push({
          filename: path,
          status: 'modified',
          additions: counts.additions,
          deletions: counts.deletions,
          changes: counts.additions + counts.deletions,
        });
      }
    }
    return files;
  }

  /**
   * Three-way merge of the head tip into the base tip over their merge-base.
   * Returns the merged flat path map, or null when both sides changed the same
   * path differently (a conflict).
   */
  threeWayMerge(repo: Repo, mergeBaseSha: string, headSha: string, baseSha: string): Map<string, string> | null {
    const baseCommit = repo.objects.get(mergeBaseSha);
    const headCommit = repo.objects.get(headSha);
    const currentCommit = repo.objects.get(baseSha);
    if (baseCommit === undefined || headCommit === undefined || currentCommit === undefined) return null;
    const baseTree = new Map<string, string>();
    const headTree = new Map<string, string>();
    const currentTree = new Map<string, string>();
    this.flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseTree);
    this.flattenTree(repo, parseCommit(headCommit.data).tree, '', headTree);
    this.flattenTree(repo, parseCommit(currentCommit.data).tree, '', currentTree);
    const out = new Map<string, string>(currentTree);
    const all = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of all) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      const c = currentTree.get(path);
      if (h === b) continue; // head did not change it
      if (c === b) {
        // Only head changed it: take head's version (or its deletion).
        if (h === undefined) out.delete(path);
        else out.set(path, h);
        continue;
      }
      if (h === c) continue; // both changed it the same way
      return null; // both changed it differently: conflict
    }
    return out;
  }
}
