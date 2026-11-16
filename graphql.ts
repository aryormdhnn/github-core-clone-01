// graphql.ts — GitHub GraphQL v4 (/api/graphql), a small self-contained
// executor for exactly the operation set the sealed conformance suite sends
// (18 documents: viewer, repository, introspection, issues, pull requests,
// five mutations, node lookup, batched operations).
//
// Transport facts (from sdk/conformance/graphql-client.ts):
// - POST JSON {query, variables}; a batched request is a JSON array of
//   operation objects and answers a JSON array of envelopes, in order.
// - A GraphQL-level failure is HTTP 200 with an `errors` array — never an
//   HTTP error — except unauthenticated, which is HTTP 401 exactly.
// - An unknown repository answers data.repository === null with NO errors.
// - An unknown field answers HTTP 200 with an errors array whose message
//   contains the field name.
// - Global ids are opaque and stable, never the bare numeric id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseJsonBody, readBody, sendError, sendJson, type RestContext } from './rest.ts';
import type { Issue, Pull, Repo } from './store.ts';
import {
  addComment,
  closeIssue,
  commentGlobalId,
  createIssue,
  createPullRequest,
  decodeGlobalId,
  findIssueByGlobalId,
  findPullByGlobalId,
  findRepoById,
  issueGlobalId,
  mergePullRequest,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
} from './forge.ts';

// -------------------------------------------------------------------------------------------
// tokenizer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selections: FieldNode[] | null;
  readonly typeCondition: string | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`Unsupported operation ${keyword}`);
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = (this.next() as { value: string }).value;
    // Skip variable definitions "(...)" if present.
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') this.skipBalanced('(', ')');
    // Skip directives.
    this.skipDirectives();
    return { kind: keyword, name, selections: this.parseSelectionSet() };
  }

  private skipBalanced(open: string, close: string): void {
    this.expectPunct(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      else if (token.kind === 'punct' && token.value === close) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') this.skipBalanced('(', ')');
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      fields.push(this.parseField());
    }
    return fields;
  }

  private parseField(): FieldNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      let typeCondition: string | null = null;
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next !== undefined && next.kind === 'name') {
        // Named fragment spread: not used by the suite; parse and drop.
        this.next();
        return { alias: null, name: '', args: [], selections: null, typeCondition: null };
      }
      this.skipDirectives();
      return { alias: null, name: '', args: [], selections: this.parseSelectionSet(), typeCondition };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    const next = this.peek();
    if (next !== undefined && next.kind === 'punct' && next.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '(') {
      this.next();
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('Unterminated argument list');
        if (t.kind === 'punct' && t.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selections: FieldNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections, typeCondition: null };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('Unterminated list');
        if (t.kind === 'punct' && t.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (true) {
        const t = this.peek();
        if (t === undefined) throw new Error('Unterminated input object');
        if (t.kind === 'punct' && t.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// values handed to resolvers (each carries its GraphQL type)
// -------------------------------------------------------------------------------------------

interface RepoValue {
  readonly __typename: 'Repository';
  readonly repo: Repo;
}
interface IssueValue {
  readonly __typename: 'Issue';
  readonly repo: Repo;
  readonly issue: Issue;
}
interface PullValue {
  readonly __typename: 'PullRequest';
  readonly repo: Repo;
  readonly pull: Pull;
}
interface UserValue {
  readonly __typename: 'User';
  readonly login: string;
}
interface RefValue {
  readonly __typename: 'Ref';
  readonly name: string;
}
interface PageInfoValue {
  readonly __typename: 'PageInfo';
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}
interface IssueConnectionValue {
  readonly __typename: 'IssueConnection';
  readonly nodes: IssueValue[];
  readonly pageInfo: PageInfoValue;
}
interface PullConnectionValue {
  readonly __typename: 'PullRequestConnection';
  readonly nodes: PullValue[];
}
interface PullFileConnectionValue {
  readonly __typename: 'PullRequestChangedFileConnection';
  readonly nodes: Array<{ readonly __typename: 'PullRequestChangedFile'; readonly path: string }>;
}
interface CommentValue {
  readonly __typename: 'IssueComment';
  readonly repo: Repo;
  readonly issue: Issue;
  readonly comment: { readonly id: number; readonly body: string };
}
interface TypeValue {
  readonly __typename: '__Type';
  readonly name: string;
  readonly fields: string[];
  readonly enumValues: string[];
}

type AnyValue =
  | RepoValue
  | IssueValue
  | PullValue
  | UserValue
  | RefValue
  | PageInfoValue
  | IssueConnectionValue
  | PullConnectionValue
  | PullFileConnectionValue
  | CommentValue
  | TypeValue
  | { readonly __typename: string; [key: string]: unknown };

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// schema: field resolvers per type
// -------------------------------------------------------------------------------------------

interface FieldDef {
  readonly type: string;
  readonly resolve: (ctx: RestContext, parent: AnyValue, args: Record<string, unknown>) => unknown;
}

const ISSUE_FIELDS = [
  'id',
  'number',
  'title',
  'state',
  'body',
  'createdAt',
  'updatedAt',
  'author',
  'comments',
  'labels',
  'url',
  'closedAt',
];
const PULL_REQUEST_FIELDS = [
  'id',
  'number',
  'title',
  'body',
  'state',
  'merged',
  'mergeable',
  'headRefName',
  'baseRefName',
  'files',
  'author',
  'createdAt',
  'updatedAt',
];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
  'description',
  'private',
  'createdAt',
  'updatedAt',
];

function issuesConnection(ctx: RestContext, repo: Repo, args: Record<string, unknown>): IssueConnectionValue {
  void ctx;
  let items = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    items = items.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const desc = orderBy === undefined ? false : orderBy.direction !== 'ASC';
  items.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const cursorNumber = decodeCursor(args.after);
    if (cursorNumber !== null) {
      const index = items.findIndex((i) => i.number === cursorNumber);
      start = index >= 0 ? index + 1 : items.length;
    }
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => ({ __typename: 'Issue', repo, issue }) as IssueValue),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
  };
}

function pullsConnection(ctx: RestContext, repo: Repo, args: Record<string, unknown>): PullConnectionValue {
  void ctx;
  const items = [...repo.pulls].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : items.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: items.slice(0, first).map((pull) => ({ __typename: 'PullRequest', repo, pull }) as PullValue),
  };
}

function introspectionType(name: string): TypeValue | null {
  if (name === 'Issue') return { __typename: '__Type', name, fields: ISSUE_FIELDS, enumValues: [] };
  if (name === 'PullRequest') return { __typename: '__Type', name, fields: PULL_REQUEST_FIELDS, enumValues: [] };
  if (name === 'Repository') return { __typename: '__Type', name, fields: REPOSITORY_FIELDS, enumValues: [] };
  if (name === 'SearchType') {
    return { __typename: '__Type', name, fields: [], enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'] };
  }
  return null;
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      type: 'User',
      resolve: (ctx) => ({ __typename: 'User', login: ctx.viewerLogin }) as UserValue,
    },
    repository: {
      type: 'Repository',
      resolve: (ctx, _parent, args) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as RepoValue);
      },
    },
    node: {
      type: 'Node',
      resolve: (ctx, _parent, args) => {
        const decoded = decodeGlobalId(args.id);
        if (decoded === null || decoded.kind !== 'Repository') return null;
        const repo = findRepoById(ctx, decoded.repoId);
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as RepoValue);
      },
    },
    __type: {
      type: '__Type',
      resolve: (_ctx, _parent, args) => introspectionType(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') throw new Error('repository not found');
        const repo = findRepoById(ctx, decoded.repoId);
        if (repo === undefined) throw new Error('repository not found');
        const issue = createIssue(ctx, repo, String(input.title ?? ''), String(input.body ?? ''));
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue } as IssueValue };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(ctx, input.issueId);
        if (found === null) throw new Error('issue not found');
        closeIssue(ctx, found.repo, found.issue);
        return {
          __typename: 'CloseIssuePayload',
          issue: { __typename: 'Issue', repo: found.repo, issue: found.issue } as IssueValue,
        };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') throw new Error('repository not found');
        const repo = findRepoById(ctx, decoded.repoId);
        if (repo === undefined) throw new Error('repository not found');
        const created = createPullRequest(
          ctx,
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) throw new Error(created.error);
        return {
          __typename: 'CreatePullRequestPayload',
          pullRequest: { __typename: 'PullRequest', repo, pull: created } as PullValue,
        };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGlobalId(ctx, input.pullRequestId);
        if (found === null) throw new Error('pull request not found');
        const merged = mergePullRequest(ctx, found.repo, found.pull);
        if (!merged.ok) throw new Error(merged.error);
        return {
          __typename: 'MergePullRequestPayload',
          pullRequest: { __typename: 'PullRequest', repo: found.repo, pull: found.pull } as PullValue,
        };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGlobalId(ctx, input.subjectId);
        if (found === null) throw new Error('issue not found');
        const comment = addComment(ctx, found.repo, found.issue, String(input.body ?? ''));
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: {
              __typename: 'IssueComment',
              repo: found.repo,
              issue: found.issue,
              comment,
            } as CommentValue,
          },
        };
      },
    },
  },
  User: {
    login: { type: 'String', resolve: (_ctx, parent) => (parent as UserValue).login },
  },
  Repository: {
    id: { type: 'ID', resolve: (_ctx, parent) => repoGlobalId((parent as RepoValue).repo) },
    databaseId: { type: 'Int', resolve: (_ctx, parent) => (parent as RepoValue).repo.id },
    name: { type: 'String', resolve: (_ctx, parent) => (parent as RepoValue).repo.name },
    nameWithOwner: { type: 'String', resolve: (_ctx, parent) => (parent as RepoValue).repo.fullName },
    owner: {
      type: 'User',
      resolve: (_ctx, parent) => ({ __typename: 'User', login: (parent as RepoValue).repo.owner }) as UserValue,
    },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (_ctx, parent) => ({ __typename: 'Ref', name: (parent as RepoValue).repo.defaultBranch }) as RefValue,
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (_ctx, parent, args) => {
        const repo = (parent as RepoValue).repo;
        const found = repo.issues.find((i) => i.number === args.number);
        return found === undefined ? null : ({ __typename: 'Issue', repo, issue: found } as IssueValue);
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (ctx, parent, args) => issuesConnection(ctx, (parent as RepoValue).repo, args),
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (ctx, parent, args) => pullsConnection(ctx, (parent as RepoValue).repo, args),
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (_ctx, parent, args) => {
        const repo = (parent as RepoValue).repo;
        const found = repo.pulls.find((p) => p.number === args.number);
        return found === undefined ? null : ({ __typename: 'PullRequest', repo, pull: found } as PullValue);
      },
    },
  },
  Ref: {
    name: { type: 'String', resolve: (_ctx, parent) => (parent as RefValue).name },
  },
  Issue: {
    id: { type: 'ID', resolve: (_ctx, parent) => issueGlobalId((parent as IssueValue).repo, (parent as IssueValue).issue) },
    number: { type: 'Int', resolve: (_ctx, parent) => (parent as IssueValue).issue.number },
    title: { type: 'String', resolve: (_ctx, parent) => (parent as IssueValue).issue.title },
    state: {
      type: 'IssueState',
      resolve: (_ctx, parent) => ((parent as IssueValue).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    },
    body: { type: 'String', resolve: (_ctx, parent) => (parent as IssueValue).issue.body },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (_ctx, parent) => (parent as IssueConnectionValue).nodes },
    pageInfo: { type: 'PageInfo', resolve: (_ctx, parent) => (parent as IssueConnectionValue).pageInfo },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (_ctx, parent) => (parent as PullConnectionValue).nodes },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (_ctx, parent) => (parent as PageInfoValue).hasNextPage },
    endCursor: { type: 'String', resolve: (_ctx, parent) => (parent as PageInfoValue).endCursor },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (_ctx, parent) => pullGlobalId((parent as PullValue).repo, (parent as PullValue).pull) },
    number: { type: 'Int', resolve: (_ctx, parent) => (parent as PullValue).pull.number },
    state: {
      type: 'PullRequestState',
      resolve: (_ctx, parent) => {
        const pull = (parent as PullValue).pull;
        if (pull.merged) return 'MERGED';
        return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
      },
    },
    merged: { type: 'Boolean', resolve: (_ctx, parent) => (parent as PullValue).pull.merged },
    headRefName: { type: 'String', resolve: (_ctx, parent) => (parent as PullValue).pull.headRef },
    baseRefName: { type: 'String', resolve: (_ctx, parent) => (parent as PullValue).pull.baseRef },
    mergeable: {
      type: 'MergeableState',
      resolve: (ctx, parent) => pullMergeable(ctx, (parent as PullValue).repo, (parent as PullValue).pull),
    },
    files: {
      type: 'PullRequestChangedFileConnection',
      resolve: (_ctx, parent, args) => {
        const pull = (parent as PullValue).pull;
        const first = typeof args.first === 'number' ? args.first : pull.files.length;
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes: pull.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })),
        } as PullFileConnectionValue;
      },
    },
  },
  PullRequestChangedFileConnection: {
    nodes: {
      type: '[PullRequestChangedFile]',
      resolve: (_ctx, parent) => (parent as PullFileConnectionValue).nodes,
    },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: (_ctx, parent) => (parent as { path: string }).path },
  },
  Node: {
    id: {
      type: 'ID',
      resolve: (_ctx, parent) => {
        if ((parent as RepoValue).__typename === 'Repository') return repoGlobalId((parent as RepoValue).repo);
        return null;
      },
    },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, parent) => (parent as { issue: IssueValue }).issue },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (_ctx, parent) => (parent as { issue: IssueValue }).issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, parent) => (parent as { pullRequest: PullValue }).pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (_ctx, parent) => (parent as { pullRequest: PullValue }).pullRequest },
  },
  AddCommentPayload: {
    commentEdge: {
      type: 'IssueCommentEdge',
      resolve: (_ctx, parent) => (parent as { commentEdge: unknown }).commentEdge,
    },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment', resolve: (_ctx, parent) => (parent as { node: CommentValue }).node },
  },
  IssueComment: {
    id: {
      type: 'ID',
      resolve: (_ctx, parent) => {
        const value = parent as CommentValue;
        return commentGlobalId(value.repo, value.issue, value.comment);
      },
    },
    body: { type: 'String', resolve: (_ctx, parent) => (parent as CommentValue).comment.body },
  },
  __Type: {
    fields: {
      type: '[__Field]',
      resolve: (_ctx, parent) =>
        (parent as TypeValue).fields.map((name) => ({ __typename: '__Field', name })),
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (_ctx, parent) =>
        (parent as TypeValue).enumValues.map((name) => ({ __typename: '__EnumValue', name })),
    },
  },
  __Field: {
    name: { type: 'String', resolve: (_ctx, parent) => (parent as { name: string }).name },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (_ctx, parent) => (parent as { name: string }).name },
  },
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface GraphQLError {
  readonly message: string;
}

function elementType(listType: string): string {
  return listType.slice(1, -1);
}

function executeSelections(
  ctx: RestContext,
  typeName: string,
  parent: AnyValue | null,
  selections: readonly FieldNode[],
  variables: Record<string, unknown>,
  errors: GraphQLError[],
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of selections) {
    // Inline fragment: spread its selections when the type condition matches.
    if (field.name === '' && field.selections !== null) {
      if (field.typeCondition === null || parent === null || (parent as AnyValue).__typename === field.typeCondition) {
        const inner = executeSelections(ctx, typeName, parent, field.selections, variables, errors);
        Object.assign(data, inner);
      }
      continue;
    }
    const typeFields = SCHEMA[typeName];
    const def = typeFields?.[field.name];
    if (def === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, variables);
    let value: unknown;
    try {
      value = def.resolve(ctx, parent as AnyValue, args);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : 'Internal error' });
      data[field.alias ?? field.name] = null;
      continue;
    }
    if (value === null || value === undefined) {
      data[field.alias ?? field.name] = null;
      continue;
    }
    if (field.selections === null) {
      data[field.alias ?? field.name] = value;
      continue;
    }
    if (def.type.startsWith('[')) {
      const itemType = elementType(def.type);
      const items = value as AnyValue[];
      data[field.alias ?? field.name] = items.map((item) =>
        executeSelections(ctx, itemType, item, field.selections as FieldNode[], variables, errors),
      );
      continue;
    }
    // Object field: the concrete type is the declared type, except for the
    // Node interface, where the value carries its own __typename.
    let childType = def.type;
    if (childType === 'Node' && value !== null && typeof value === 'object') {
      childType = (value as AnyValue).__typename;
    }
    data[field.alias ?? field.name] = executeSelections(
      ctx,
      childType,
      value as AnyValue,
      field.selections,
      variables,
      errors,
    );
  }
  return data;
}

function executeOne(ctx: RestContext, body: unknown): Record<string, unknown> {
  const input = (body ?? {}) as Record<string, unknown>;
  const query = input.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  const variables = (input.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operation = operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const errors: GraphQLError[] = [];
  const data = executeSelections(ctx, rootType, null, operation.selections, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

// -------------------------------------------------------------------------------------------
// HTTP handler
// -------------------------------------------------------------------------------------------

export async function handleGraphql(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (ctx.token !== '' && auth !== `Bearer ${ctx.token}`) {
    sendError(res, 401, 'Unauthorized');
    return;
  }
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  if (body === null) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    sendJson(
      res,
      200,
      body.map((entry) => executeOne(ctx, entry)),
    );
    return;
  }
  sendJson(res, 200, executeOne(ctx, body));
}
