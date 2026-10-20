/*
 * Small hand-written tokenizer for code blocks. Not a parser: it only colors keywords, strings,
 * numbers, comments, call sites and type-like names across common languages.
 * Invariant: concatenating every token's text reproduces the input exactly. Never throws.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'number' | 'comment' | 'fn' | 'type';
export interface Token { text: string; kind: TokenKind }

const KEYWORDS = new Set<string>([
  // JS / TS
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'keyof', 'let', 'namespace', 'new', 'null',
  'of', 'package', 'private', 'protected', 'public', 'readonly', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
  // Python
  'and', 'assert', 'def', 'del', 'elif', 'except', 'False', 'global', 'is', 'lambda', 'None', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'True', 'self',
  // shell
  'echo', 'esac', 'fi', 'local', 'readonly', 'then', 'done', 'until',
  // SQL (also matched when written in uppercase)
  'select', 'insert', 'update', 'into', 'values', 'create', 'table', 'alter', 'drop', 'index', 'view', 'join',
  'left', 'right', 'inner', 'outer', 'cross', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'union',
  'all', 'distinct', 'case', 'when', 'end', 'between', 'exists', 'like', 'primary', 'key', 'foreign', 'references',
  'unique', 'returning', 'begin', 'commit', 'rollback', 'where',
  // C / C++ / Java / C#
  'auto', 'boolean', 'byte', 'char', 'double', 'extern', 'float', 'goto', 'inline', 'int', 'long', 'register',
  'short', 'signed', 'sizeof', 'struct', 'template', 'typedef', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'volatile', 'override', 'final', 'synchronized', 'throws',
  // Go
  'chan', 'defer', 'fallthrough', 'func', 'go', 'range',
  // Rust
  'crate', 'dyn', 'fn', 'impl', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'Self', 'trait', 'unsafe', 'use',
]);

const HASH_LANGS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'r', 'make', 'makefile', 'dockerfile', 'pl', 'perl', 'ps1', 'powershell']);
const DASH_LANGS = new Set(['sql', 'lua', 'hs', 'haskell']);
const CSS_LANGS = new Set(['css', 'scss', 'less']);
const MARKUP_LANGS = new Set(['html', 'xml', 'svg', 'vue']);
const NO_COMMENT_LANGS = new Set(['json', 'text', 'txt', 'plain', 'plaintext']);

interface Rules {
  line: string[];
  /** a `--` marker only starts a comment when followed by whitespace (generic languages) */
  dashNeedsSpace: boolean;
  block: boolean;
  html: boolean;
}

function rulesFor(lang: string): Rules {
  const l = (lang || '').trim().toLowerCase();
  if (NO_COMMENT_LANGS.has(l)) return { line: [], dashNeedsSpace: false, block: false, html: false };
  if (HASH_LANGS.has(l)) return { line: ['#'], dashNeedsSpace: false, block: false, html: false };
  if (DASH_LANGS.has(l)) return { line: ['--'], dashNeedsSpace: false, block: l === 'sql', html: false };
  if (CSS_LANGS.has(l)) return { line: [], dashNeedsSpace: false, block: true, html: false };
  if (MARKUP_LANGS.has(l)) return { line: [], dashNeedsSpace: false, block: false, html: true };
  return { line: ['//', '#', '--'], dashNeedsSpace: true, block: true, html: false };
}

/** End index of a comment starting at i, or i when there is none. */
function commentEnd(src: string, i: number, r: Rules): number {
  const n = src.length;
  if (r.block && src.startsWith('/*', i)) {
    const e = src.indexOf('*/', i + 2);
    return e < 0 ? n : e + 2;
  }
  if (r.html && src.startsWith('<!--', i)) {
    const e = src.indexOf('-->', i + 4);
    return e < 0 ? n : e + 3;
  }
  for (const m of r.line) {
    if (!src.startsWith(m, i)) continue;
    if (m === '--' && r.dashNeedsSpace) {
      const nx = src[i + 2];
      if (nx !== undefined && !/\s/.test(nx)) continue;
    }
    const e = src.indexOf('\n', i);
    return e < 0 ? n : e;
  }
  return i;
}

/** End index (exclusive) of a string literal starting at i. Single and double quotes stop at end of line. */
function stringEnd(src: string, i: number): number {
  const n = src.length;
  const q = src[i];
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === q) return j + 1;
    if (ch === '\n' && q !== '`') return j;
    j++;
  }
  return n;
}

const NUM_RE = /0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[a-zA-Z]*/y;
const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

export function tokenize(code: string, lang: string): Token[] {
  const src = typeof code === 'string' ? code : String(code ?? '');
  const out: Token[] = [];
  let plain = '';
  const push = (kind: TokenKind, text: string) => {
    if (!text) return;
    if (kind === 'plain') { plain += text; return; }
    if (plain) { out.push({ text: plain, kind: 'plain' }); plain = ''; }
    out.push({ text, kind });
  };

  const rules = rulesFor(lang);
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];

    const ce = commentEnd(src, i, rules);
    if (ce > i) { push('comment', src.slice(i, ce)); i = ce; continue; }

    if (c === '"' || c === "'" || c === '`') {
      const e = stringEnd(src, i);
      push('string', src.slice(i, e));
      i = e;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      let kind: TokenKind;
      if (KEYWORDS.has(word) || (word === word.toUpperCase() && KEYWORDS.has(word.toLowerCase()))) kind = 'keyword';
      else if (src[j] === '(') kind = 'fn';
      else if (/^[A-Z]/.test(word)) kind = 'type';
      else kind = 'plain';
      push(kind, word);
      i = j;
      continue;
    }

    if (c >= '0' && c <= '9') {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      if (m && m.index === i && m[0].length > 0) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }

    push('plain', c);
    i++;
  }
  if (plain) out.push({ text: plain, kind: 'plain' });
  return out;
}
