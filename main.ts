// main.ts is mend, the CLI SPEC.md specifies (MIT, kit starter plus the sections 5 to 8 written
// for this entry: line matching at three tiers, unified diffs, SEARCH/REPLACE blocks and V4A
// patches). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order: used to print `R` lines (SPEC.md section 2). */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines (SPEC.md section 3): its break, its lines, whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One body line of a hunk, block or chunk (SPEC.md section 5): context, old or new. */
interface Op {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with those positions only. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single line at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/**
 * The lines that replace O at position `pos` (SPEC.md section 5): a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line of N is re-indented from
 * the leading whitespace of O's first line to that of the file's first matched line.
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const oLines: string[] = [];
  const ctxOIndex: number[] = [];
  for (const op of ops) {
    if (op.kind === 'new') continue;
    if (op.kind === 'ctx') ctxOIndex.push(oLines.length);
    oLines.push(op.text);
  }
  const p = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const out: string[] = [];
  let seen = 0;
  for (const op of ops) {
    if (op.kind === 'old') continue;
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + ctxOIndex[seen]!]!);
      seen += 1;
    } else if (tier === 2 && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk (SPEC.md section 6): its old start line, its body lines, and whether a `\` line
 * follows its last context or `+` line (bsCtxPlus) or its last `+` line (bsPlus). */
interface Hunk {
  a: number;
  ops: Op[];
  bsCtxPlus: boolean;
  bsPlus: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;

/** The path a `--- ` / `+++ ` line names: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** Strip one leading `a/` or `b/`; `/dev/null` means no file. */
function cleanPath(raw: string): string | null {
  const p = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
  return p === '/dev/null' ? null : p;
}

/** Split a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

/** Parse one hunk at lines[i] (a `@@` line) inside a section; returns the hunk and the next index. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  let j = i + 1;
  const start = j;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      j += 1;
      continue;
    }
    break;
  }
  let end = j;
  while (end > start && lines[end - 1] === '') end -= 1;
  const ops: Op[] = [];
  const opLine: number[] = [];
  for (let k = start; k < end; k++) {
    const l = lines[k]!;
    if (l === '') {
      ops.push({ kind: 'ctx', text: '' });
      opLine.push(k);
    } else if (l[0] === ' ') {
      ops.push({ kind: 'ctx', text: l.slice(1) });
      opLine.push(k);
    } else if (l[0] === '-') {
      ops.push({ kind: 'old', text: l.slice(1) });
      opLine.push(k);
    } else if (l[0] === '+') {
      ops.push({ kind: 'new', text: l.slice(1) });
      opLine.push(k);
    }
    // A `\` line refers to the body line before it; it adds no line of its own.
  }
  const bsAfter = (kind: 'ctx' | 'new' | 'plus'): boolean => {
    for (let q = ops.length - 1; q >= 0; q--) {
      const op = ops[q]!;
      if (kind === 'plus' ? op.kind === 'new' : op.kind === 'ctx' || op.kind === 'new') {
        const li = opLine[q]!;
        return (lines[li + 1] ?? '').startsWith('\\');
      }
    }
    return false;
  };
  return { hunk: { a, ops, bsCtxPlus: bsAfter('ctx'), bsPlus: bsAfter('plus') }, next: j };
}

/**
 * Parse a unified diff (SPEC.md section 6) into one edit per section. A section with no hunks is
 * still one edit (a change that checks the file exists, a creation of an empty file, a deletion).
 */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const paths = diffGitPaths(l);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { oldPath: paths[0], newPath: paths[1], create: false, del: false, hunks: [] };
      i += 1;
      i = parseSectionRest(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
      i = parseSectionRest(lines, i, sec);
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/**
 * Parse a section's header (up to its first hunk) and its hunks, starting at index i; returns the
 * index after the section. `diffOld`/`diffNew` are the `diff --git` paths when the section started
 * at one, else null.
 */
function parseSectionRest(lines: string[], i: number, sec: Section): number {
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = sec.oldPath;
  let diffNew: string | null = sec.newPath;
  let inHeader = true;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        pairOld = cleanPath(headerPath(l));
        pairNew = cleanPath(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        pairNew = cleanPath(headerPath(l));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // Past the first hunk: a new section starts at `diff --git` or at a `---`/`+++` pair.
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    // Any other line after a hunk is ignored prose until the next section starts.
    i += 1;
  }
  sec.oldPath = pairOld ?? renameFrom ?? diffOld;
  sec.newPath = pairNew ?? renameTo ?? diffNew;
  return i;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bs = false;
      let seenPlus = false;
      for (const h of sec.hunks) {
        for (const op of h.ops) if (op.kind === 'new') plus.push(op.text);
        if (h.ops.some((o) => o.kind === 'new')) {
          bs = h.bsPlus;
          seenPlus = true;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (seenPlus && bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== newP;
    if (!safe(oldP!)) throw new Fail('unsafe', oldP!);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(oldP!);
    if (before === null) throw new Fail('missing', oldP!);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const cur = splitFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const ops = hunk.ops;
      const oLines = ops.filter((o) => o.kind !== 'new').map((o) => o.text);
      const nLen = ops.filter((o) => o.kind !== 'old').length;
      if (oLines.length === 0) {
        const at = Math.min(hunk.a + d, cur.lines.length);
        const rep = buildReplacement(ops, cur.lines, at, 0);
        const atEnd = at === cur.lines.length;
        cur.lines.splice(at, 0, ...rep);
        if (atEnd) cur.final = !hunk.bsCtxPlus;
        d += nLen;
        continue;
      }
      const found = findTier(cur.lines, oLines, strict);
      if (found === null) throw new Fail('no-match', oldP!);
      const target = hunk.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(ops, cur.lines, best, found.tier);
      const runsToEnd = best + oLines.length === cur.lines.length;
      cur.lines.splice(best, oLines.length, ...rep);
      if (runsToEnd) cur.final = !hunk.bsCtxPlus;
      d += nLen - oLines.length;
    }
    const out = joinFile(cur);
    if (isMove) {
      tree.now.set(newP!, out);
      tree.now.set(oldP!, null);
      tree.moves.push({ old: oldP!, new: newP! });
    } else {
      tree.now.set(oldP!, out);
    }
  };
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(p: string, oLines: string[], nLines: string[], strict: boolean): Edit {
  const ops: Op[] = [...oLines.map((t) => ({ kind: 'old' as const, text: t })), ...nLines.map((t) => ({ kind: 'new' as const, text: t }))];
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, nLines.length === 0 ? '' : nLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, oLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const rep = buildReplacement(ops, f.lines, found.pos[0]!, found.tier);
    f.lines.splice(found.pos[0]!, oLines.length, ...rep);
    tree.now.set(p, joinFile(f));
  };
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

/** Parse a V4A patch (SPEC.md section 8) into one edit per section. */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const secStart = v4aSectionStart(l);
    if (secStart === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const kind = secStart.kind;
    const path = secStart.path;
    // Collect the section's raw lines: up to the next section start or `*** End Patch`.
    let j = i + 1;
    while (j < last) {
      const m = lines[j]!;
      if (v4aSectionStart(m) !== null || m.trim() === '*** End Patch') break;
      j += 1;
    }
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl === '') fileLines.push('');
        else if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, i + 1, headLine, strict));
    }
    i = j;
  }
  return edits;
}

function v4aSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice('*** Add File: '.length).trim() };
  if (l.startsWith('*** Delete File: ')) return { kind: 'delete', path: l.slice('*** Delete File: '.length).trim() };
  if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice('*** Update File: '.length).trim() };
  return null;
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/**
 * Parse one Update File section's raw lines (already stripped of trailing blank lines) into its
 * edit. `startIdx` is the 0-based index of the first raw line; `headLine` its 1-based line number
 * of the `*** Update File:` line, for the no-chunk parse error.
 */
function v4aUpdateEdit(p: string, raw: string[], startIdx: number, headLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    const lineNo = startIdx + k + 1;
    if (l.startsWith('*** Move to: ')) {
      if (k !== 0 || moveTo !== null) throw new Exit2(`error: parse ${lineNo}`);
      moveTo = l.slice('*** Move to: '.length).trim();
      continue;
    }
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, ops: [] };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (seenChunk) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, ops: [] };
        chunks.push(cur);
        seenChunk = true;
      }
      if (l === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.ops.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.ops.push({ kind: 'old', text: l.slice(1) });
      else cur.ops.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const oLines = chunk.ops.filter((o) => o.kind !== 'new').map((o) => o.text);
      if (oLines.length === 0) {
        const at = chunk.eof ? f.lines.length : cursor;
        const rep = buildReplacement(chunk.ops, f.lines, at, 0);
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      // The first tier with an occurrence at or after the cursor; an end-of-file chunk takes
      // only an occurrence that ends at the file's last line.
      let found: { tier: number; pos: number[] } | null = null;
      if (chunk.eof) {
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occurrences(f.lines, oLines, t).filter((q) => q >= cursor && q + oLines.length === f.lines.length);
          if (pos.length > 0) {
            found = { tier: t, pos };
            break;
          }
        }
      } else {
        found = findTierFrom(f.lines, oLines, cursor, strict);
      }
      if (found === null) throw new Fail('no-match', p);
      const pos = found.pos[0]!;
      const rep = buildReplacement(chunk.ops, f.lines, pos, found.tier);
      f.lines.splice(pos, oLines.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(p, null);
      tree.moves.push({ old: p, new: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One line per path whose state changed, in byte order; a move whose old path existed before
  // the patch and is gone after it, and whose new path did not exist before it and does after
  // it, is one `R <old> -> <new>` line (sorted by <new>) in place of its `D` and `A` lines.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const rowByPath = new Map<string, string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowByPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of tree.moves) {
    if (
      tree.original(m.old) !== null &&
      tree.original(m.new) === null &&
      tree.get(m.old) === null &&
      tree.get(m.new) !== null &&
      rowByPath.get(m.old)?.startsWith('D ') === true &&
      rowByPath.get(m.new)?.startsWith('A ') === true &&
      !suppressed.has(m.old) &&
      !suppressed.has(m.new)
    ) {
      suppressed.add(m.old);
      suppressed.add(m.new);
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: rowByPath.get(p)! });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = rows.map((r) => r.line);
  for (const p of changed) {
    if (check) continue;
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
