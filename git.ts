// git.ts — git smart HTTP: info/refs advertisements (protocol v2 for
// upload-pack when the client sends Git-Protocol: version=2, v0 otherwise;
// receive-pack is v0-only), protocol v2 ls-refs and fetch, protocol v0
// upload-pack, and protocol v0 receive-pack with report-status in sideband.
//
// Wire facts (from the suite's client, sdk/conformance/git-client.ts):
// - v2 advertisement: "# service=git-upload-pack" preamble, "version 2", then
//   capability lines; required capabilities: fetch, ls-refs (ls-refs=unborn),
//   object-format=sha1. fetch features advertised: shallow, wait-for-done.
//   (No filter: the suite never sends one.)
// - v0 upload-pack advertisement: "# service=..." preamble, HEAD line carrying
//   capabilities after NUL, peeled tag lines "<oid> <ref>^{}"; must advertise
//   side-band-64k. Empty repos advertise "<zero> capabilities^{}" with the caps.
// - v0 receive-pack advertisement: same shape; must advertise report-status,
//   side-band-64k and delete-refs.
// - v2 fetch response sections: acknowledgments (ACK/NAK + ready),
//   shallow-info (shallow/unshallow), packfile (sideband-64k band 1).
// - v0 fetch response: NAK/ACK lines, shallow/unshallow lines, then the pack
//   in sideband-64k.
// - receive-pack request: command lines "<old> <new> <ref>" (capabilities
//   after NUL on the first), flush, then the raw packfile. Response: the
//   report-status stream ("unpack ok", "ok <ref>" / "ng <ref> <reason>") as
//   pkt-lines inside sideband band 1. A refused ref says "non-fast-forward".

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  pktLine,
  pktLineBuffer,
  pktFlush,
  pktDelim,
  sidebandChunks,
  parsePktLines,
  parsePktLineBuffers,
  parsePack,
  buildPack,
  parseTree,
  parseCommit,
  oidOf,
  isOid,
  ZERO_OID,
  type GitObject,
} from './gitpack.ts';
import { readBody, sendError, type RestContext } from './rest.ts';
import type { Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const UPLOAD_PACK_CT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_CT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT_CT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT_CT = 'application/x-git-receive-pack-result';

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** All refs of a repo, sorted by name (heads then tags, each group sorted). */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs.entries()) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The target commit of an annotated tag object, following tag chains. */
function peelTag(repo: Repo, tagOid: string, depth = 0): string | undefined {
  if (depth > 8) return undefined;
  const obj = repo.objects.get(tagOid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  if (match === null) return undefined;
  const target = match[1] as string;
  const targetObj = repo.objects.get(target);
  if (targetObj !== undefined && targetObj.type === 'tag') return peelTag(repo, target, depth + 1);
  return target;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

/** Protocol v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

const V0_UPLOAD_CAPS = `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

/** Protocol v0 ref advertisement for either service. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = defaultTip ?? refs.find((r) => r.name.startsWith('refs/heads/'))?.oid ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peelTag(repo, ref.oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch set computation
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** All objects reachable from exactly the given commit set (each commit plus
 * its trees and blobs). Ancestors are NOT walked: the caller decides which
 * commits belong in the set, so a depth limit is honoured here. */
function reachableObjects(repo: Repo, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visitTree = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree' || out.has(treeOid)) return;
    out.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
      }
    }
  };
  for (const oid of commits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (!out.has(oid)) out.set(oid, obj);
    visitTree(parseCommit(obj.data).tree);
  }
  return out;
}

/**
 * The fetch plan: which objects to send, which new shallow boundaries, and
 * which of the client's shallow boundaries are no longer shallow.
 * - wanted commits: BFS from wants, at most `depth` generations (depth 1 =
 *   the wants alone; null = unlimited).
 * - held commits: BFS from haves, stopping at the client's shallow boundaries
 *   (a shallow have's parents are NOT held).
 * - sent commits = wanted minus held; sent objects = reachable(sent) minus
 *   reachable(held) — an object the client already holds is never re-sent.
 * - a sent commit is a new shallow boundary when it has a parent in neither
 *   the sent nor the held set.
 * - a client's boundary is unshallow when it is sent and all its parents are
 *   sent or held.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  // Resolve wants: commits feed the BFS; tag objects (and anything else that
  // is not a commit, e.g. a blob) are sent as extra objects, with a tag's
  // target resolved recursively so the commit it peels to is fetched too.
  const commitWants: string[] = [];
  const extraObjects = new Map<string, GitObject>();
  const resolveWant = (oid: string, chain = 0): void => {
    if (chain > 8) return;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return;
    if (obj.type === 'commit') {
      commitWants.push(oid);
      return;
    }
    if (obj.type === 'tag') {
      extraObjects.set(oid, obj);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) resolveWant(match[1] as string, chain + 1);
      return;
    }
    extraObjects.set(oid, obj);
  };
  for (const want of wants) resolveWant(want);
  const wanted = new Set<string>();
  {
    const queue: Array<{ oid: string; dist: number }> = commitWants.map((oid) => ({ oid, dist: 0 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      wanted.add(oid);
      if (depth !== null && dist + 1 >= depth) continue;
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
    }
  }
  const held = new Set<string>();
  {
    const shallowSet = new Set(clientShallow);
    const stack = [...haves];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      held.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  const sent = new Set<string>();
  for (const oid of wanted) if (!held.has(oid)) sent.add(oid);
  const sentObjects = reachableObjects(repo, sent);
  const heldObjects = reachableObjects(repo, held);
  const objects: GitObject[] = [];
  for (const [oid, obj] of sentObjects) {
    if (!heldObjects.has(oid)) objects.push(obj);
  }
  for (const [oid, obj] of extraObjects) {
    if (!heldObjects.has(oid)) objects.push(obj);
  }
  const parentsOf = (oid: string): string[] => {
    const obj = repo.objects.get(oid);
    return obj !== undefined && obj.type === 'commit' ? [...parseCommit(obj.data).parents] : [];
  };
  const shallow: string[] = [];
  for (const oid of sent) {
    const parents = parentsOf(oid);
    if (parents.length > 0 && parents.some((p) => !sent.has(p) && !held.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!sent.has(boundary)) continue;
    const parents = parentsOf(boundary);
    if (parents.every((p) => sent.has(p) || held.has(p))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

/** Acknowledgment lines for the haves: ACK for a have that is an ancestor of a want. */
function ackLines(repo: Repo, wants: readonly string[], haves: readonly string[]): string[] {
  const lines: string[] = [];
  let acked = false;
  for (const have of haves) {
    if (!repo.objects.has(have)) continue;
    if (wants.some((want) => repo.objects.has(want) && (want === have || isAncestorOf(repo, have, want)))) {
      lines.push(`ACK ${have}\n`);
      acked = true;
    }
  }
  if (!acked) lines.push('NAK\n');
  lines.push('ready\n');
  return lines;
}

function isAncestorOf(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
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

// -------------------------------------------------------------------------------------------
// protocol v2: ls-refs and fetch
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = sortedRefs(repo);
  const hasRefs = refs.length > 0;
  if (keep('HEAD')) {
    if (hasRefs && defaultTip !== undefined) {
      parts.push(pktLine(`${defaultTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
    // thin-pack, no-progress, ofs-delta, filter, agent, object-format, done: accepted, no action.
  }
  return args;
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet === 'flush') continue;
    if (packet === 'delim') {
      lines.push('delim');
      continue;
    }
    lines.push(packet.replace(/\n$/, ''));
  }
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    const delimIndex = lines.indexOf('delim');
    const argLines = delimIndex >= 0 ? lines.slice(delimIndex + 1) : lines.slice(1);
    return lsRefsResponse(repo, parseLsRefsArgs(argLines));
  }
  if (command !== 'command=fetch') {
    // Unknown v2 command: answer an empty packfile section so the client fails cleanly.
    return Buffer.concat([pktLine('packfile\n'), ...sidebandChunks(1, buildPack([])), pktFlush()]);
  }
  const delimIndex = lines.indexOf('delim');
  const argLines = delimIndex >= 0 ? lines.slice(delimIndex + 1) : lines.slice(1);
  const args = parseFetchArgs(argLines);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const line of ackLines(repo, args.wants, args.haves)) parts.push(pktLine(line));
  parts.push(pktDelim());
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// protocol v0: upload-pack
// -------------------------------------------------------------------------------------------

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = parsePktLineBuffers(body);
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet === 'delim') continue;
    const text = (packet as Buffer).toString('utf8').replace(/\n$/, '');
    (sections[sections.length - 1] as string[]).push(text);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of sections[0] ?? []) {
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace >= 0 ? line.slice(0, firstSpace) : line;
    const rest = firstSpace >= 0 ? line.slice(firstSpace + 1) : '';
    if (verb === 'want') wants.push(rest.split(' ')[0] as string);
    else if (verb === 'shallow') shallow.push(rest);
    else if (verb === 'deepen') {
      const n = Number.parseInt(rest, 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  for (const line of ackLines(repo, wants, haves)) parts.push(pktLine(line));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandChunks(1, pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// protocol v0: receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const commands: PushCommand[] = [];
  let packStart = -1;
  let offset = 0;
  // Walk the raw body pkt by pkt to find the flush that ends the command list;
  // everything after it is the raw packfile.
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = offset + 4;
      break;
    }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const firstLine = nul >= 0 ? payload.slice(0, nul) : payload;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(firstLine.trim());
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    offset += len;
  }
  let unpackOk = true;
  if (packStart >= 0 && packStart < body.length) {
    try {
      const objects = parsePack(body.subarray(packStart), (oid) => repo.objects.get(oid));
      for (const obj of objects.values()) {
        const oid = oidOf(obj.type, obj.data);
        repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!unpackOk || !repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, and the new tip must descend from the old.
    if (current === undefined || current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const newObj = repo.objects.get(command.newOid);
    if (newObj === undefined || newObj.type !== 'commit') {
      results.push({ ref: command.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (!isAncestorOf(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const reportLines: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack failed\n')];
  for (const result of results) {
    reportLines.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const report = Buffer.concat(reportLines);
  const parts: Buffer[] = [...sidebandChunks(1, report), pktFlush()];
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export async function handleGit(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rest: string,
): Promise<void> {
  const repo = ctx.store.getRepo(owner, repoName);
  const method = req.method ?? 'GET';

  if (method === 'GET' && rest.startsWith('info/refs')) {
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service');
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (service === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') {
        sendRaw(res, 200, UPLOAD_PACK_CT, v2Advertisement());
      } else {
        sendRaw(res, 200, UPLOAD_PACK_CT, v0Advertisement(repo, 'git-upload-pack'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, RECEIVE_PACK_CT, v0Advertisement(repo, 'git-receive-pack'));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'POST' && rest === 'git-upload-pack') {
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const body = await readBody(req);
    try {
      if (req.headers['git-protocol'] === 'version=2') {
        sendRaw(res, 200, UPLOAD_PACK_RESULT_CT, uploadPackV2(repo, body));
      } else {
        sendRaw(res, 200, UPLOAD_PACK_RESULT_CT, uploadPackV0(repo, body));
      }
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
    return;
  }

  if (method === 'POST' && rest === 'git-receive-pack') {
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const body = await readBody(req);
    try {
      sendRaw(res, 200, RECEIVE_PACK_RESULT_CT, receivePack(repo, body));
    } catch (err) {
      sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
    }
    return;
  }

  sendError(res, 404, 'Not Found');
}
