import { cellValue } from './sheetModel';

export interface GridCell { display: string; raw: string; isNumber: boolean; fx: boolean; error?: string }

// ---- values ---------------------------------------------------------------

type Num = { k: 'n'; v: number };
type Val = Num | { k: 't'; v: string } | { k: 'empty' } | { k: 'e'; code: string } | { k: 'u' };

const UNSUP: Val = { k: 'u' };
const err = (code: string): Val => ({ k: 'e', code });

class Unsupported extends Error {}

// ---- parsing ----------------------------------------------------------------

type Node =
  | { k: 'num'; v: number }
  | { k: 'ref'; r: number; c: number }
  | { k: 'range'; r1: number; c1: number; r2: number; c2: number }
  | { k: 'neg'; e: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

type Tok =
  | { t: 'num'; v: number }
  | { t: 'ref'; r: number; c: number }
  | { t: 'range'; r1: number; c1: number; r2: number; c2: number }
  | { t: 'fn'; name: string }
  | { t: 'op'; s: string }
  | { t: 'end' };

const REF_AT = /\$?([A-Za-z]{1,3})\$?([0-9]+)/y;
const IDENT_AT = /[A-Za-z_][A-Za-z0-9_.]*/y;
const NUM_AT = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/y;
const FUNCTIONS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT'];

/** Reads an A1 reference at pos; null when there is none (or it is the start of a longer name). */
function readRef(src: string, pos: number): { r: number; c: number; end: number } | null {
  REF_AT.lastIndex = pos;
  const m = REF_AT.exec(src);
  if (!m) return null;
  const end = pos + m[0].length;
  if (end < src.length && /[A-Za-z0-9_.(]/.test(src[end])) return null;
  const row = parseInt(m[2], 10);
  if (row < 1) throw new Unsupported();
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { r: row - 1, c: col - 1, end };
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let pos = 0;
  while (pos < src.length) {
    const ch = src[pos];
    if (/\s/.test(ch)) { pos++; continue; }
    if (/[0-9.]/.test(ch)) {
      NUM_AT.lastIndex = pos;
      const m = NUM_AT.exec(src);
      if (!m) throw new Unsupported();
      out.push({ t: 'num', v: Number(m[0]) });
      pos += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const ref = readRef(src, pos);
      if (ref) {
        pos = ref.end;
        if (src[pos] === ':') {
          const b = readRef(src, pos + 1);
          if (!b) throw new Unsupported();
          out.push({ t: 'range', r1: ref.r, c1: ref.c, r2: b.r, c2: b.c });
          pos = b.end;
        } else {
          out.push({ t: 'ref', r: ref.r, c: ref.c });
        }
        continue;
      }
      IDENT_AT.lastIndex = pos;
      const m = IDENT_AT.exec(src);
      if (!m) throw new Unsupported();
      pos += m[0].length;
      if (src[pos] !== '(') throw new Unsupported();
      out.push({ t: 'fn', name: m[0].toUpperCase() });
      continue;
    }
    if ('+-*/(),'.indexOf(ch) >= 0) {
      out.push({ t: 'op', s: ch });
      pos++;
      continue;
    }
    throw new Unsupported();
  }
  out.push({ t: 'end' });
  return out;
}

/** Recursive-descent parser: expr = term (+|- term)*, term = unary (*|/ unary)*, unary = -unary | primary. */
function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const isOp = (s: string) => toks[p].t === 'op' && (toks[p] as { s: string }).s === s;
  const expect = (s: string) => {
    if (!isOp(s)) throw new Unsupported();
    p++;
  };

  function expr(): Node {
    let n = term();
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { s: string }).s;
      n = { k: 'bin', op, a: n, b: term() };
    }
    return n;
  }
  function term(): Node {
    let n = unary();
    while (isOp('*') || isOp('/')) {
      const op = (toks[p++] as { s: string }).s;
      n = { k: 'bin', op, a: n, b: unary() };
    }
    return n;
  }
  function unary(): Node {
    if (isOp('-')) { p++; return { k: 'neg', e: unary() }; }
    if (isOp('+')) { p++; return unary(); }
    return primary();
  }
  function primary(): Node {
    const t = toks[p];
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'ref') { p++; return { k: 'ref', r: t.r, c: t.c }; }
    if (t.t === 'range') { p++; return { k: 'range', r1: t.r1, c1: t.c1, r2: t.r2, c2: t.c2 }; }
    if (t.t === 'fn') {
      p++;
      if (FUNCTIONS.indexOf(t.name) < 0) throw new Unsupported();
      expect('(');
      const args: Node[] = [expr()];
      while (isOp(',')) { p++; args.push(expr()); }
      expect(')');
      return { k: 'call', name: t.name, args };
    }
    if (isOp('(')) {
      p++;
      const n = expr();
      expect(')');
      return n;
    }
    throw new Unsupported();
  }

  const root = expr();
  if (toks[p].t !== 'end') throw new Unsupported();
  return root;
}

// ---- evaluation -------------------------------------------------------------

function toNum(v: Val): Val {
  if (v.k === 'empty') return { k: 'n', v: 0 };
  if (v.k === 't') return err('#VALUE!');
  return v;
}

function finite(v: number): Val {
  return isFinite(v) ? { k: 'n', v } : err('#NUM!');
}

class Evaluator {
  private memo = new Map<string, Val>();
  private busy = new Set<string>();
  private height: number;
  private width: number;

  constructor(private rows: string[][]) {
    this.height = rows.length;
    this.width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  }

  /** Value of the cell at row index r, column index c (both 0-based). Memoised; cycles give #REF!. */
  cell(r: number, c: number): Val {
    if (r < 0 || c < 0) return err('#REF!');
    if (r >= this.height || c >= this.width) return { k: 'empty' };
    const raw = this.rows[r][c] ?? '';
    const cv = cellValue(raw);
    if (cv.t === 'number') return { k: 'n', v: cv.v };
    if (cv.t === 'text') return raw.trim() === '' ? { k: 'empty' } : { k: 't', v: raw };
    const key = r + ',' + c;
    const hit = this.memo.get(key);
    if (hit) return hit;
    if (this.busy.has(key)) return err('#REF!');
    this.busy.add(key);
    let val: Val = UNSUP;
    try {
      val = this.formula(cv.f);
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      val = UNSUP;
    } finally {
      this.busy.delete(key);
    }
    this.memo.set(key, val);
    return val;
  }

  private formula(f: string): Val {
    const root = parseFormula(f);
    if (root.k === 'range') throw new Unsupported();
    return this.node(root);
  }

  private node(n: Node): Val {
    switch (n.k) {
      case 'num':
        return { k: 'n', v: n.v };
      case 'ref':
        return this.cell(n.r, n.c);
      case 'range':
        throw new Unsupported();
      case 'neg': {
        const a = toNum(this.node(n.e));
        if (a.k !== 'n') return a;
        return { k: 'n', v: -a.v };
      }
      case 'bin': {
        const a = toNum(this.node(n.a));
        const b = toNum(this.node(n.b));
        if (a.k === 'u' || b.k === 'u') return UNSUP;
        if (a.k !== 'n') return a;
        if (b.k !== 'n') return b;
        switch (n.op) {
          case '+': return finite(a.v + b.v);
          case '-': return finite(a.v - b.v);
          case '*': return finite(a.v * b.v);
          case '/':
            if (b.v === 0) return err('#DIV/0!');
            return finite(a.v / b.v);
        }
        throw new Unsupported();
      }
      case 'call':
        return this.call(n.name, n.args);
    }
  }

  private call(name: string, args: Node[]): Val {
    // Collect numeric values: text and empty cells in ranges or refs are ignored; errors propagate.
    const nums: number[] = [];
    for (const a of args) {
      if (a.k === 'range') {
        const r2 = Math.min(a.r2, this.height - 1);
        const c2 = Math.min(a.c2, this.width - 1);
        for (let r = a.r1; r <= r2; r++) {
          for (let c = a.c1; c <= c2; c++) {
            const v = this.cell(r, c);
            if (v.k === 'n') nums.push(v.v);
            else if (v.k === 'e' || v.k === 'u') return v;
          }
        }
      } else {
        const v = a.k === 'ref' ? this.cell(a.r, a.c) : toNum(this.node(a));
        if (v.k === 'n') nums.push(v.v);
        else if (v.k === 'e' || v.k === 'u') return v;
      }
    }
    let sum = 0;
    for (const x of nums) sum += x;
    switch (name) {
      case 'SUM':
        return finite(sum);
      case 'COUNT':
        return { k: 'n', v: nums.length };
      case 'AVERAGE':
        if (nums.length === 0) return err('#DIV/0!');
        return finite(sum / nums.length);
      case 'MIN':
      case 'MAX': {
        if (nums.length === 0) return { k: 'n', v: 0 };
        let best = nums[0];
        for (const x of nums) if (name === 'MIN' ? x < best : x > best) best = x;
        return { k: 'n', v: best };
      }
    }
    throw new Unsupported();
  }
}

/** Shows a number with up to 10 significant digits and no trailing zeros. */
function formatNumber(v: number): string {
  return String(Number(v.toPrecision(10)));
}

/** Computes display values for a grid of raw cell strings. A1 refs index rows directly (row 1 = rows[0], column A = index 0). */
export function computeGrid(rows: string[][]): GridCell[][] {
  const ev = new Evaluator(rows);
  return rows.map((row, r) =>
    row.map((cell, c): GridCell => {
      const raw = cell ?? '';
      const cv = cellValue(raw);
      if (cv.t !== 'formula') return { display: raw, raw, isNumber: cv.t === 'number', fx: false };
      const v = ev.cell(r, c);
      switch (v.k) {
        case 'n':
          return { display: formatNumber(v.v), raw, isNumber: true, fx: true };
        case 'e':
          return { display: v.code, raw, isNumber: false, fx: true, error: v.code };
        case 't':
          return { display: v.v, raw, isNumber: false, fx: true };
        case 'empty':
          return { display: '0', raw, isNumber: true, fx: true };
        default:
          return { display: raw, raw, isNumber: false, fx: true };
      }
    }),
  );
}
