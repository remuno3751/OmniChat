/*
 * Pure Markdown parser (blocks + inline) for chat messages. No React / React Native imports, so the VS Code
 * extension's webview bundles this very file. Rendering lives in Markdown.tsx (app) and the extension's own renderer.
 */

export type Align = 'left' | 'center' | 'right';

export type Inline =
  | string
  | { type: 'code'; text: string }
  | { type: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { type: 'link'; url: string; children: Inline[] }
  | { type: 'image'; url: string; alt: string };

export type Block =
  | { k: 'p'; text: string }
  | { k: 'raw'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'code'; lang: string; info?: string; body: string }
  | { k: 'quote'; children: Block[] }
  | { k: 'list'; ordered: boolean; start: number; items: { task: boolean | null; children: Block[] }[] }
  | { k: 'table'; align: Align[]; head: string[]; rows: string[][] }
  | { k: 'hr' }
  | { k: 'img'; url: string; alt: string };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>[ ]?(.*)$/;
const ITEM_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const IMG_LINE_RE = /^ {0,3}!\[([^\]]*)\]\((\S+?)(?:[ \t]+"[^"]*")?\)[ \t]*$/;
const DELIM_RE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const IMG_INLINE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/y;
const LINK_RE = /\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/y;
const URL_RE = /https?:\/\/[^\s<>]+/iy;

function leadingSpaces(s: string): number {
  return s.length - s.replace(/^ +/, '').length;
}

/** Splits a table row on unescaped pipes. */
function splitRow(s: string): string[] {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === '\\' && t[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  return i + 1 < lines.length && lines[i].includes('|') && DELIM_RE.test(lines[i + 1])
    && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function isBlockStart(l: string): boolean {
  return FENCE_RE.test(l) || HEADING_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || ITEM_RE.test(l) || IMG_LINE_RE.test(l);
}

/** Block-level parser. Each branch consumes at least one line, so the loop always advances. */
export function parseBlocks(lines: string[], streaming: boolean): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m: RegExpExecArray | null;

    m = FENCE_RE.exec(line);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      const fence = m[1];
      const lang = (m[2].trim().split(/\s+/)[0] || '').toLowerCase();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const c = CLOSE_FENCE_RE.exec(lines[j]);
        if (c && c[1][0] === fence[0] && c[1].length >= fence.length) { closed = true; break; }
        body.push(lines[j]);
      }
      if (!closed && streaming) out.push({ k: 'raw', text: lines.slice(i).join('\n') });
      else out.push({ k: 'code', lang, info: m[2].trim(), body: body.join('\n') });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    m = HEADING_RE.exec(line);
    if (m) {
      out.push({ k: 'h', level: m[1].length, text: (m[2] || '').replace(/[ \t]+#+$/, '').trim() });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { out.push({ k: 'hr' }); i++; continue; }

    m = IMG_LINE_RE.exec(line);
    if (m && /^https?:\/\//i.test(m[2])) { out.push({ k: 'img', alt: m[1], url: m[2] }); i++; continue; }

    if (QUOTE_RE.test(line)) {
      const q: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        q.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1]);
        i++;
      }
      out.push({ k: 'quote', children: parseBlocks(q, streaming) });
      continue;
    }

    m = ITEM_RE.exec(line);
    if (m) {
      const baseIndent = m[1].length;
      const ordered = /\d/.test(m[2]);
      const start = ordered ? parseInt(m[2], 10) : 1;
      const groups: { first: string; ci: number; rest: string[] }[] = [];
      const sameListItem = (l: string) => {
        const im = ITEM_RE.exec(l);
        return !!im && im[1].length <= baseIndent && /\d/.test(im[2]) === ordered && !HR_RE.test(l);
      };
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        const im = ITEM_RE.exec(l);
        if (im && im[1].length <= baseIndent) {
          if (!sameListItem(l)) break;
          groups.push({ first: im[3], ci: l.length - im[3].length, rest: [] });
          j++;
          continue;
        }
        if (!groups.length) break;
        const g = groups[groups.length - 1];
        if (!l.trim()) {
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && (leadingSpaces(lines[k]) > baseIndent || sameListItem(lines[k]))) {
            g.rest.push('');
            j++;
            continue;
          }
          break;
        }
        const ind = leadingSpaces(l);
        if (ind > baseIndent) { g.rest.push(l.slice(Math.min(ind, g.ci))); j++; continue; }
        if (!isBlockStart(l)) { g.rest.push(l); j++; continue; } // lazy continuation of the item text
        break;
      }
      const items = groups.map((g) => {
        let text = g.first;
        let task: boolean | null = null;
        const tm = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(text);
        if (tm) { task = tm[1] !== ' '; text = tm[2]; }
        return { task, children: parseBlocks([text, ...g.rest], streaming) };
      });
      out.push({ k: 'list', ordered, start, items });
      i = j;
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]);
      const align: Align[] = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : 'left';
      });
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        const cells = splitRow(lines[j]);
        rows.push(head.map((_, k) => cells[k] ?? ''));
        j++;
      }
      out.push({ k: 'table', align, head, rows });
      i = j;
      continue;
    }

    // paragraph: consecutive lines until a blank line or another block starts
    const para: string[] = [line.replace(/^[ \t]+/, '')];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !isBlockStart(lines[j]) && !isTableStart(lines, j)) {
      para.push(lines[j].replace(/^[ \t]+/, ''));
      j++;
    }
    out.push({ k: 'p', text: para.join('\n') });
    i = j;
  }
  return out;
}

function findClose(s: string, delim: string, from: number): number {
  let k = from;
  while ((k = s.indexOf(delim, k)) >= 0) {
    if (k > from) {
      const prev = s[k - 1];
      const next = s[k + delim.length];
      const ok = !/\s/.test(prev)
        && !(delim.length === 1 && (next === delim || prev === delim))
        && !(delim[0] === '_' && next !== undefined && /[\p{L}\p{N}]/u.test(next));
      if (ok) return k;
    }
    k += 1;
  }
  return -1;
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/** Inline parser: code spans, escapes, images, links, bare URLs, bold, italic, strike. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  // A closer search that failed from position p also fails from any later position, so remember the failure
  // (keeps unmatched openers like "*a *a *a ..." linear instead of quadratic).
  const noClose = new Map<string, number>();
  const noFence = new Set<number>();
  let i = 0;
  while (i < s.length) {
    const c = s[i];

    if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) {
      buf += s[i + 1];
      i += 2;
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (s[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let k = i + run;
      let found = -1;
      while (!noFence.has(run) && (k = s.indexOf(fence, k)) >= 0) {
        if (s[k + run] !== '`' && s[k - 1] !== '`') { found = k; break; }
        k += 1;
      }
      if (found < 0) noFence.add(run);
      if (found >= 0) {
        flush();
        let code = s.slice(i + run, found);
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out.push({ type: 'code', text: code });
        i = found + run;
        continue;
      }
      buf += fence;
      i += run;
      continue;
    }

    if (c === '!' && s[i + 1] === '[') {
      IMG_INLINE_RE.lastIndex = i;
      const m = IMG_INLINE_RE.exec(s);
      if (m && /^https?:\/\//i.test(m[2])) {
        flush();
        out.push({ type: 'image', alt: m[1], url: m[2] });
        i = IMG_INLINE_RE.lastIndex;
        continue;
      }
    }

    if (c === '[') {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(s);
      if (m) {
        flush();
        out.push({ type: 'link', url: m[2], children: parseInline(m[1]) });
        i = LINK_RE.lastIndex;
        continue;
      }
    }

    if ((c === 'h' || c === 'H') && (i === 0 || !isWordChar(s[i - 1]))) {
      URL_RE.lastIndex = i;
      const m = URL_RE.exec(s);
      if (m) {
        const url = m[0].replace(/[.,;:!?'"]+$/, '');
        flush();
        out.push({ type: 'link', url, children: [url] });
        i += url.length;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const dbl = s[i + 1] === c;
      if (c === '~' && !dbl) { buf += c; i++; continue; }
      const delim = dbl ? c + c : c;
      const start = i + delim.length;
      const canOpen = start < s.length && !/\s/.test(s[start]) && !(c === '_' && isWordChar(s[i - 1]));
      if (canOpen) {
        const failedAt = noClose.get(delim);
        const close = failedAt !== undefined && start >= failedAt ? -1 : findClose(s, delim, start);
        if (close < 0 && (failedAt === undefined || start < failedAt)) noClose.set(delim, start);
        if (close > start) {
          flush();
          const type = c === '~' ? 'strike' : dbl ? 'bold' : 'italic';
          out.push({ type, children: parseInline(s.slice(start, close)) });
          i = close + delim.length;
          continue;
        }
      }
      buf += delim;
      i += delim.length;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}
