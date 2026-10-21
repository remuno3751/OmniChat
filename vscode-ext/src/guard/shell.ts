/**
 * Lexical shell command analyser; pure, never executes or expands anything.
 * Splits on ; && || | |& & newline; recurses into $(…), `…`, <(…), >(…), (…)
 * (nested lists come before the command containing them). Redirect operators
 * stay in argv as tokens ([">", "/etc/x"]) so pathArgs() sees their targets.
 */

export const MAX_COMMAND_LENGTH = 8000;
const MAX_DEPTH = 64;
const MAX_WRAP = 32;

export class ShellParseError extends Error {}
export type ParseResult = { ok: true; commands: string[][] } | { ok: false; error: string };

interface Lexer { s: string; i: number; out: string[][]; depth: number }
type Tok = { kind: "word" | "redir" | "op" | "end"; text: string };

function fail(msg: string): never {
  throw new ShellParseError(msg);
}

const REDIR_OPS = ["<<<", "<<-", "<<", ">>", ">|", ">&", "<&", "<>", ">", "<"];
const FD_PREFIX = /\d+(?=[<>])/y;
const BREAK = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
const REDIR_RE = /^\d*(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>)$|^&>>?$/;

/** Parse without throwing. Oversized input or any syntax problem gives ok:false. */
export function parseShell(cmd: string): ParseResult {
  if (cmd.length > MAX_COMMAND_LENGTH) {
    return { ok: false, error: `command longer than ${MAX_COMMAND_LENGTH} characters` };
  }
  const lx: Lexer = { s: cmd, i: 0, out: [], depth: 0 };
  try {
    readList(lx, null);
    return { ok: true, commands: lx.out };
  } catch (err) {
    return { ok: false, error: err instanceof ShellParseError ? err.message : `parse failed: ${String(err)}` };
  }
}

/** Like parseShell but throws ShellParseError on failure. */
export function splitCommands(cmd: string): string[][] {
  const r = parseShell(cmd);
  if (!r.ok) throw new ShellParseError(r.error);
  return r.commands;
}

/** Redirect operator token, optionally with an fd prefix ("2>", "&>>"). */
export function isRedirectOp(tok: string): boolean {
  return REDIR_RE.test(tok);
}

/** Leading `NAME=value` assignment token. */
export function isAssignment(tok: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(tok);
}

/** Word that expansion could change (glob, $, brace, ~, backtick). */
export function hasExpansion(word: string): boolean {
  return /[$`*?[{~]/.test(word);
}

function readList(lx: Lexer, closer: string | null): void {
  let cur: string[] = [];
  const flush = (): void => {
    if (cur.length > 0) lx.out.push(cur);
    cur = [];
  };
  for (;;) {
    const t = nextToken(lx, closer);
    if (t.kind === "end") {
      if (closer !== null) fail(closer === ")" ? "unterminated $( or ( group" : "unterminated backtick");
      return flush();
    }
    if (t.kind === "word") cur.push(t.text);
    else if (t.kind === "redir") {
      const target = nextToken(lx, closer);
      if (target.kind !== "word") fail("redirect without target");
      cur.push(t.text, target.text);
    } else if (t.text === "(") nested(lx, ")");
    else if (t.text === ")" || t.text === "`") {
      if (t.text !== closer) fail(`unexpected ${t.text}`);
      return flush();
    } else flush();
  }
}

function nested(lx: Lexer, closer: string): void {
  if (++lx.depth > MAX_DEPTH) fail("nesting too deep");
  readList(lx, closer);
  lx.depth--;
}

function nextToken(lx: Lexer, closer: string | null): Tok {
  const s = lx.s;
  const take = (n: number, kind: Tok["kind"]): Tok => {
    const text = s.slice(lx.i, lx.i + n);
    lx.i += n;
    return { kind, text };
  };
  for (;;) {
    const c = s[lx.i];
    if (c === " " || c === "\t") lx.i++;
    else if (c === "\\" && s[lx.i + 1] === "\n") lx.i += 2;
    else if (c === "#") while (lx.i < s.length && s[lx.i] !== "\n") lx.i++;
    else break;
  }
  if (lx.i >= s.length) return { kind: "end", text: "" };
  const c = s[lx.i];
  const d = s[lx.i + 1];
  if (c === "&") return d === "&" ? take(2, "op") : d === ">" ? take(s[lx.i + 2] === ">" ? 3 : 2, "redir") : take(1, "op");
  if (c === "|") return take(d === "|" || d === "&" ? 2 : 1, "op");
  if (c === ";") return take(d === ";" ? 2 : 1, "op");
  if (c === "\n" || c === "(" || c === ")") return take(1, "op");
  if (c === "`" && closer === "`") return take(1, "op");
  if ((c === "<" || c === ">") && d !== "(") return redirTok(lx, "");
  if (c >= "0" && c <= "9") {
    FD_PREFIX.lastIndex = lx.i;
    const m = FD_PREFIX.exec(s);
    if (m !== null && s[lx.i + m[0].length + 1] !== "(") {
      lx.i += m[0].length;
      return redirTok(lx, m[0]);
    }
  }
  return { kind: "word", text: readWord(lx, closer, false) };
}

function redirTok(lx: Lexer, prefix: string): Tok {
  const op = REDIR_OPS.find((o) => lx.s.startsWith(o, lx.i));
  if (op === undefined) fail("unrecognised redirect");
  lx.i += op.length;
  return { kind: "redir", text: prefix + op };
}

/** Word with quotes removed; substitutions recurse and stay as raw text. dq=true reads a double-quoted body (lx.i past the opening quote). */
function readWord(lx: Lexer, closer: string | null, dq: boolean): string {
  const s = lx.s;
  let text = "";
  const sub = (n: number, cl: string): void => {
    const st = lx.i;
    lx.i += n;
    nested(lx, cl);
    text += s.slice(st, lx.i);
  };
  while (lx.i < s.length) {
    const c = s[lx.i];
    const d = s[lx.i + 1];
    if (dq) {
      if (c === '"') return lx.i++, text;
      if (c === "\\" && d !== undefined) {
        if (d !== "\n") text += '"\\$`'.includes(d) ? d : "\\" + d;
        lx.i += 2;
      } else if (c === "$" && d === "(") sub(2, ")");
      else if (c === "`") sub(1, "`");
      else text += c, lx.i++;
      continue;
    }
    if ((c === "<" || c === ">") && d === "(") sub(2, ")");
    else if (BREAK.has(c)) break;
    else if (c === "`") {
      if (closer === "`") break;
      sub(1, "`");
    } else if (c === "$" && d === "(") sub(2, ")");
    else if (c === "\\") {
      if (d === undefined) fail("trailing backslash");
      if (d !== "\n") text += d;
      lx.i += 2;
    } else if (c === "'") {
      const e = s.indexOf("'", lx.i + 1);
      if (e < 0) fail("unterminated single quote");
      text += s.slice(lx.i + 1, e);
      lx.i = e + 1;
    } else if (c === '"') {
      lx.i++;
      text += readWord(lx, closer, true);
      if (s[lx.i - 1] !== '"') fail("unterminated double quote");
    } else if (c === "$" && d === "'") {
      lx.i += 2;
      text += readAnsiC(lx);
    } else if (c === "$" && d === '"') lx.i++; // $"..." behaves as "..."
    else text += c, lx.i++;
  }
  if (dq) fail("unterminated double quote");
  return text;
}

/** $'...' body; the common escapes are decoded (bash runs $'\x72m' as "rm"). */
function readAnsiC(lx: Lexer): string {
  const s = lx.s;
  let text = "";
  while (lx.i < s.length) {
    const c = s[lx.i];
    if (c === "'") return lx.i++, text;
    if (c !== "\\" || lx.i + 1 >= s.length) {
      text += c;
      lx.i++;
      continue;
    }
    const e = s[lx.i + 1];
    lx.i += 2;
    const oct = e >= "0" && e <= "7";
    if (e === "x" || oct) {
      const start = oct ? lx.i - 1 : lx.i;
      const re = oct ? /[0-7]{1,3}/y : /[0-9a-fA-F]{1,2}/y;
      re.lastIndex = start;
      const m = re.exec(s);
      if (m !== null) {
        lx.i = start + m[0].length;
        text += String.fromCharCode(parseInt(m[0], oct || e !== "x" ? 8 : 16));
        continue;
      }
    }
    text += e === "'" || e === '"' || e === "\\" ? e : "\\" + e;
  }
  return fail("unterminated $'...'");
}

/** vals: options taking a separate value; pos: positionals to skip; noOpts: reserved word or `!`/`{`. */
interface WrapSpec { vals?: string[]; pos?: number; noOpts?: boolean }

const NO_OPTS: WrapSpec = { noOpts: true };
const WRAPPERS = new Map<string, WrapSpec>([
  ["sudo", { vals: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U"] }],
  ["doas", { vals: ["-u", "-C"] }],
  ["env", { vals: ["-u", "-C"] }],
  ["exec", { vals: ["-a"] }],
  ["time", { vals: ["-f", "-o"] }],
  ["nice", { vals: ["-n"] }],
  ["timeout", { vals: ["-s", "-k"], pos: 1 }],
  ["xargs", { vals: ["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a"] }],
  ["command", {}], ["builtin", {}], ["nohup", {}],
  ...["!", "{", "if", "then", "else", "elif", "do", "while", "until"].map(
    (k): [string, WrapSpec] => [k, NO_OPTS],
  ),
]);

const baseName = (t: string): string => t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1);

/** Index in argv where the command wrapped by `spec` starts. */
function skipWrapper(argv: string[], start: number, spec: WrapSpec): number {
  if (spec.noOpts) return start;
  const vals = new Set(spec.vals ?? []);
  let pos = spec.pos ?? 0;
  let optsOpen = true;
  let i = start;
  while (i < argv.length) {
    const t = argv[i];
    if (isRedirectOp(t)) i += 2;
    else if (isAssignment(t)) i++;
    else if (optsOpen && t === "--") optsOpen = false, i++;
    else if (optsOpen && t.length > 1 && t.startsWith("-")) i += vals.has(t) ? 2 : 1;
    else if (pos > 0) pos--, i++;
    else return i;
  }
  return i;
}

/** Effective command chain: element 0 skips leading assignments/redirects; each later element is wrapped by the previous (sudo, env, xargs, ...). Elements are argv suffixes. */
export function unwrap(argv: string[]): string[][] {
  const chain: string[][] = [];
  let i = 0;
  for (let n = 0; n < MAX_WRAP; n++) {
    while (i < argv.length && (isRedirectOp(argv[i]) || isAssignment(argv[i]))) {
      i += isRedirectOp(argv[i]) ? 2 : 1;
    }
    if (i >= argv.length) break;
    chain.push(argv.slice(i));
    const spec = WRAPPERS.get(baseName(argv[i]));
    if (spec === undefined) break;
    i = skipWrapper(argv, i + 1, spec);
  }
  return chain;
}

const FD_TARGET = /^(\d+|-)$/;
const OPT_VALUE = /^--?[^=]+=([\s\S]*)$/;
const looksLikePath = (t: string): boolean =>
  t.includes("/") || t.includes("\\") || /^[A-Za-z]:/.test(t) || /^[~.$%]/.test(t);

/** Tokens that look like paths (contain / or \, start with ~ . $ %, or drive letter), incl. `--opt=/path` values and redirect targets (not `2>&1`). */
export function pathArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (isRedirectOp(t)) {
      const target = argv[++i];
      if (target !== undefined && !(/&$/.test(t) && FD_TARGET.test(target))) out.push(target);
      continue;
    }
    const opt = OPT_VALUE.exec(t);
    const candidate = opt !== null ? opt[1] : t;
    if (looksLikePath(candidate)) out.push(candidate);
  }
  return out;
}
