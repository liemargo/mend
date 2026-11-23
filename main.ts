// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

// ---- Section 5's machinery, shared by sections 6 to 8: a file as lines plus its break style,
// ---- occurrences of old lines at three matching tiers, and building a replacement segment.

// A file split the way section 3 describes: its own break, its lines, whether it ends with a break.
interface FileModel {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = text.endsWith(br);
  const lines = text.split(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.finalBr ? m.br : '');
}

const trailWs = /[ \t]+$/;
const leadWs = /^[ \t]+/;
const stripTrail = (s: string): string => s.replace(trailWs, '');
const stripBoth = (s: string): string => s.replace(leadWs, '').replace(trailWs, '');
const leadOf = (s: string): string => s.match(leadWs)?.[0] ?? '';

interface TierHit {
  tier: number;
  positions: number[];
}

// Every start position at or after `from` where o matches `lines`, at the first tier that has any.
function findTier(lines: string[], o: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const norm = tier === 0 ? (s: string): string => s : tier === 1 ? stripTrail : stripBoth;
    const want = o.map(norm);
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (norm(lines[i + j]!) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// One line of a replacement segment: a context line (its index into the old lines) or a line of its own.
type NPart = { ctx: number } | { own: string };

// The segment that replaces o, matched at `pos` in `lines`: context lines come from the file itself,
// and at tier 2 the other lines shift from the patch's indentation to the file's (section 5).
function materialize(lines: string[], pos: number, o: string[], parts: NPart[], tier: number): string[] {
  const f = tier === 2 ? leadOf(lines[pos]!) : '';
  const p = tier === 2 ? leadOf(o[0]!) : '';
  return parts.map((part) => {
    if ('ctx' in part) return lines[pos + part.ctx]!;
    const line = part.own;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

// Move edits that succeeded, in patch order, so section 2's `R` lines can replace their `D` and `A` lines.
const moves: Array<[string, string]> = [];

// ---- Section 6: unified diffs. ----

interface BodyLine {
  kind: 'ctx' | '-' | '+' | '\\';
  text: string;
}

interface UHunk {
  a: number;
  o: string[];
  parts: NPart[];
  plus: string[];
  noNlN: boolean;
  lastPlusNoNl: boolean;
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  headOld?: string;
  headNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

// The path a --- or +++ line names: after the marker, up to a tab, spaces removed, a/ or b/ stripped.
function headerPath(raw: string): string {
  const tab = raw.indexOf('\t');
  let p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

// The two paths of a `diff --git a/<X> b/<Y>` line; any other shape is a parse error at that line.
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const at = rest.startsWith('a/') ? rest.lastIndexOf(' b/') : -1;
  const x = at > 2 ? rest.slice(2, at) : '';
  const y = at > 2 ? rest.slice(at + 3) : '';
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return [x, y];
}

// One hunk whose header is lines[i]; returns the hunk and the index of the first line after its body.
function parseHunk(lines: string[], i: number): { hunk: UHunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const bl = lines[j]!;
    if (bl.startsWith('diff --git ')) break;
    if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (bl === '') body.push({ kind: 'ctx', text: '' });
    else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
    else if (bl[0] === '-') body.push({ kind: '-', text: bl.slice(1) });
    else if (bl[0] === '+') body.push({ kind: '+', text: bl.slice(1) });
    else if (bl[0] === '\\') body.push({ kind: '\\', text: '' });
    else break;
    j += 1;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  const o: string[] = [];
  const parts: NPart[] = [];
  const plus: string[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      parts.push({ ctx: o.length });
      o.push(e.text);
    } else if (e.kind === '-') o.push(e.text);
    else if (e.kind === '+') {
      parts.push({ own: e.text });
      plus.push(e.text);
    }
  }
  let lastN = -1;
  let lastPlus = -1;
  body.forEach((e, k) => {
    if (e.kind === 'ctx' || e.kind === '+') lastN = k;
    if (e.kind === '+') lastPlus = k;
  });
  const hunk: UHunk = {
    a: Number(m[1]),
    o,
    parts,
    plus,
    noNlN: lastN >= 0 && body[lastN + 1]?.kind === '\\',
    lastPlusNoNl: lastPlus >= 0 && body[lastPlus + 1]?.kind === '\\',
  };
  return { hunk, next: j };
}

// Apply one hunk to the model; returns how much the file's line count grew, for the next hunk's offset.
function applyHunk(model: FileModel, h: UHunk, d: number, strict: boolean, path: string): number {
  if (h.o.length === 0) {
    const oldLen = model.lines.length;
    let at = h.a + d;
    if (at < 0) at = 0;
    if (at > oldLen) at = oldLen;
    const seg = h.parts.map((part) => ('own' in part ? part.own : ''));
    model.lines.splice(at, 0, ...seg);
    if (at === oldLen) model.finalBr = !h.noNlN;
    return seg.length;
  }
  const hit = findTier(model.lines, h.o, strict, 0);
  if (hit === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = hit.positions[0]!;
  for (const p of hit.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const runsToEnd = best + h.o.length === model.lines.length;
  const seg = materialize(model.lines, best, h.o, h.parts, hit.tier);
  model.lines.splice(best, h.o.length, ...seg);
  if (runsToEnd) model.finalBr = !h.noNlN;
  return seg.length - h.o.length;
}

// One unified section as an edit: creation, deletion, move or change, its hunks applied in order.
function sectionEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.headOld ?? sec.renameFrom ?? sec.gitOld ?? '';
  const newPath = sec.headNew ?? sec.renameTo ?? sec.gitNew ?? '';
  const creation = oldPath === '/dev/null' || sec.newFile;
  const deletion = newPath === '/dev/null' || sec.delFile;
  return (tree) => {
    if (oldPath !== '/dev/null' && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== '/dev/null' && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const fileLines: string[] = [];
      let finalBr = true;
      for (const h of sec.hunks) {
        fileLines.push(...h.plus);
        if (h.plus.length > 0) finalBr = !h.lastPlusNoNl;
      }
      tree.now.set(newPath, joinFile({ lines: fileLines, br: '\n', finalBr }));
      return;
    }
    if (deletion) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const isMove = oldPath !== newPath;
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) d += applyHunk(model, h, d, strict, oldPath);
    tree.now.set(newPath, joinFile(model));
    if (isMove) {
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
    }
  };
}

// Read a whole unified patch: sections and their hunks; prose and fences outside bodies are ignored.
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const fresh = (): USection => {
    const s: USection = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, i + 1);
      const s = fresh();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (followed) {
        const target = cur !== null && inHeader && cur.headOld === undefined ? cur : fresh();
        target.headOld = headerPath(line.slice(4));
        target.headNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks. ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

// The path a block names: the nearest line before its SEARCH line, back to the previous block's
// end, that is not blank and does not open a code fence; failing that, the previous block's path.
function blockPath(lines: string[], from: number, searchAt: number, prev: string | null): string {
  for (let i = searchAt - 1; i >= from; i -= 1) {
    const t = lines[i]!.trim();
    if (t === '' || t.startsWith('```')) continue;
    return t;
  }
  if (prev !== null) return prev;
  throw new Exit2(`error: parse ${searchAt + 1}`);
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let regionStart = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let mid = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let j = mid + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const path = blockPath(lines, regionStart, i, prevPath);
    blocks.push({ path, oldLines: lines.slice(i + 1, mid), newLines: lines.slice(mid + 1, end) });
    prevPath = path;
    regionStart = end + 1;
    i = end + 1;
  }
  return blocks.map((b) => {
    const parts: NPart[] = b.newLines.map((t) => ({ own: t }));
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, joinFile({ lines: [...b.newLines], br: '\n', finalBr: true }));
        return;
      }
      const before = tree.get(b.path);
      if (before === null) throw new Fail('missing', b.path);
      const model = splitFile(before);
      const hit = findTier(model.lines, b.oldLines, strict, 0);
      if (hit === null) throw new Fail('no-match', b.path);
      if (hit.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = hit.positions[0]!;
      const seg = materialize(model.lines, pos, b.oldLines, parts, hit.tier);
      model.lines.splice(pos, b.oldLines.length, ...seg);
      tree.now.set(b.path, joinFile(model));
    };
  });
}

// ---- Section 8: V4A patches. ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  parts: NPart[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  fileLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const v4aHeader = (line: string): 'add' | 'delete' | 'update' | null =>
  line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : line.startsWith('*** Update File: ') ? 'update' : null;

// The chunks of an Update File section's body (its lines, with their patch line numbers).
function parseChunks(body: Array<{ text: string; no: number }>): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const start = (anchor: string | null): VChunk => {
    const c: VChunk = { anchor, eof: false, o: [], parts: [] };
    chunks.push(c);
    cur = c;
    return c;
  };
  for (const { text, no } of body) {
    if (text.startsWith('@@')) {
      const a = text.slice(2).trim();
      start(a === '' ? null : a);
      continue;
    }
    if (text.trimEnd() === '*** End of File' && text[0] !== ' ' && text[0] !== '-' && text[0] !== '+') {
      if (cur === null) start(null);
      cur!.eof = true;
      cur = null;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      const c = cur ?? start(null);
      if (text === '' || text[0] === ' ') {
        c.parts.push({ ctx: c.o.length });
        c.o.push(text === '' ? '' : text.slice(1));
      } else if (text[0] === '-') c.o.push(text.slice(1));
      else c.parts.push({ own: text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  return chunks;
}

// One V4A section as an edit.
function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, joinFile({ lines: [...sec.fileLines], br: '\n', finalBr: true }));
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const hit = findTier(model.lines, [chunk.anchor], strict, cursor);
        if (hit === null) throw new Fail('no-match', sec.path);
        cursor = hit.positions[0]! + 1;
      }
      if (chunk.o.length === 0) {
        const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const seg = chunk.parts.map((part) => ('own' in part ? part.own : ''));
        model.lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
        continue;
      }
      const hit = findTier(model.lines, chunk.o, strict, cursor);
      if (hit === null) throw new Fail('no-match', sec.path);
      let pos = hit.positions[0]!;
      if (chunk.eof) {
        const ending = hit.positions.filter((p) => p + chunk.o.length === model.lines.length);
        if (ending.length === 0) throw new Fail('no-match', sec.path);
        pos = ending[0]!;
      }
      const seg = materialize(model.lines, pos, chunk.o, chunk.parts, hit.tier);
      model.lines.splice(pos, chunk.o.length, ...seg);
      cursor = pos + seg.length;
    }
    const dest = sec.moveTo ?? sec.path;
    tree.now.set(dest, joinFile(model));
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      moves.push([sec.path, sec.moveTo]);
    }
  };
}

// Read a whole V4A patch: its sections between the Begin and End markers.
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const head = v4aHeader(lines[i]!);
    if (head === null) {
      if (blank(lines[i]!)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const path = lines[i]!
      .slice(head === 'add' ? '*** Add File: '.length : head === 'delete' ? '*** Delete File: '.length : '*** Update File: '.length)
      .trim();
    const body: Array<{ text: string; no: number }> = [];
    let j = i + 1;
    while (j < last && v4aHeader(lines[j]!) === null) {
      body.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (head === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else if (b.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      sections.push({ kind: 'add', path, fileLines, moveTo: null, chunks: [] });
    } else if (head === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      sections.push({ kind: 'delete', path, fileLines: [], moveTo: null, chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks = parseChunks(rest);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path, fileLines: [], moveTo, chunks });
    }
    i = j;
  }
  return sections.map((s) => v4aEdit(s, strict));
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
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  moves.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    kind: string;
    path: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, kind, path: p, text: `${kind} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move replaces its pair's D and A lines with one R line, sorted by the new path.
  for (const [o, n] of moves) {
    if (o === n || tree.original(o) === null || tree.original(n) !== null) continue;
    if (tree.get(o) !== null || tree.get(n) === null) continue;
    const di = rows.findIndex((r) => r.kind === 'D' && r.path === o);
    const ai = rows.findIndex((r) => r.kind === 'A' && r.path === n);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: n, kind: 'R', path: n, text: `R ${o} -> ${n}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
