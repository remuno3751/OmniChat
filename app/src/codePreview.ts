// Pure helpers for the Code-run HTML/CSS/JS preview. No I/O; the caller supplies the change lists.
import type { FileChange } from './protocol';
import { en as CP_EN, ja as CP_JA } from './i18n/codePreviewStrings';

/** `dataUrl`: binary files (images, fonts) fetched from the PC; they have no text content. */
export interface VirtualFile { content: string; stale: boolean; dataUrl?: string }
export type VirtualFs = Map<string, VirtualFile>;
export interface ChangeRun { messageId: string; changes: FileChange[] }

const MAX_FILE_CHARS = 1024 * 1024;

/** `\` -> `/`, drop `.` segments and leading `./`. Null when the path climbs above the root. */
export function normalizePath(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

interface Line { op: ' ' | '-' | '+'; text: string; eol?: boolean }
export interface Hunk { oldStart: number; oldCount: number; lines: Line[] }
export interface ParsedPatch { hunks: Hunk[]; oldPath?: string }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Unified diff for one file. Without any @@ header, the + lines are taken as the whole file. */
export function parsePatch(patch: string): ParsedPatch {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oR = 0;
  let nR = 0;
  let oldPath: string | undefined;
  let sawHunk = false;
  for (const ln of patch.split('\n')) {
    const m = HUNK_RE.exec(ln);
    if (m) {
      cur = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], lines: [] };
      hunks.push(cur);
      oR = cur.oldCount;
      nR = m[4] === undefined ? 1 : +m[4];
      sawHunk = true;
      continue;
    }
    if (!cur) {
      const r = /^rename from (.+)$/.exec(ln);
      if (r) oldPath = r[1];
      const a = /^--- a\/(.+)$/.exec(ln);
      if (a && !oldPath) oldPath = a[1];
      continue;
    }
    if (ln.startsWith('\\')) {
      const last = cur.lines[cur.lines.length - 1];
      if (last) last.eol = false;
      continue;
    }
    if (oR <= 0 && nR <= 0) continue;
    const c = ln[0];
    if (c === ' ' || ln === '') { oR--; nR--; cur.lines.push({ op: ' ', text: ln.slice(1) }); }
    else if (c === '-') { oR--; cur.lines.push({ op: '-', text: ln.slice(1) }); }
    else if (c === '+') { nR--; cur.lines.push({ op: '+', text: ln.slice(1) }); }
  }
  if (!sawHunk) {
    // No headers at all: treat every + line (not the +++ header) as file content.
    const lines: Line[] = [];
    for (const ln of patch.split('\n')) {
      if (ln.startsWith('\\')) { const last = lines[lines.length - 1]; if (last) last.eol = false; }
      else if (ln.startsWith('+') && !ln.startsWith('+++ ')) lines.push({ op: '+', text: ln.slice(1) });
    }
    if (lines.length) hunks.push({ oldStart: 0, oldCount: 0, lines });
  }
  return { hunks, oldPath };
}

function splitContent(s: string): { lines: string[]; nl: boolean } {
  if (s === '') return { lines: [], nl: true };
  const parts = s.split('\n');
  const nl = parts[parts.length - 1] === '';
  if (nl) parts.pop();
  return { lines: parts, nl };
}

function joinContent(lines: string[], nl: boolean): string {
  if (!lines.length) return '';
  return lines.join('\n') + (nl ? '\n' : '');
}

/** Applies hunks to known content. Null when a context or removed line does not match. */
export function applyPatch(content: string, hunks: Hunk[]): string | null {
  const old = splitContent(content);
  const out: string[] = [];
  let idx = 0;
  let lastSrc: 'nl' | 'nonl' | null = null;
  for (const h of hunks) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    if (start < idx || start > old.lines.length) return null;
    while (idx < start) out.push(old.lines[idx++]);
    lastSrc = null;
    for (const l of h.lines) {
      if (l.op === '-') {
        if (old.lines[idx] !== l.text) return null;
        idx++;
        continue;
      }
      if (l.op === ' ') {
        if (old.lines[idx] !== l.text) return null;
        idx++;
      }
      out.push(l.text);
      lastSrc = l.eol === false ? 'nonl' : 'nl';
    }
  }
  const tail = old.lines.length - idx;
  while (idx < old.lines.length) out.push(old.lines[idx++]);
  const nl = tail > 0 || lastSrc === null ? old.nl : lastSrc === 'nl';
  return joinContent(out, nl);
}

function keep(fs: VirtualFs, path: string, v: VirtualFile): void {
  if (v.content.length > MAX_FILE_CHARS || v.content.includes('\u0000')) fs.delete(path);
  else fs.set(path, v);
}

const ARROW_RE = /\s(?:->|=>)\s/;

/** Rebuilds the latest content of every file from the runs (oldest first). */
export function buildVirtualFs(runs: ChangeRun[]): VirtualFs {
  const fs: VirtualFs = new Map();
  for (const run of runs) {
    for (const c of run.changes ?? []) {
      const parsed = c.patch != null ? parsePatch(c.patch) : null;
      if (c.status === 'deleted') {
        const p = normalizePath(c.path);
        if (p) fs.delete(p);
        continue;
      }
      if (c.status === 'renamed') {
        const arrow = ARROW_RE.exec(c.path);
        const newP = normalizePath(arrow ? c.path.slice(arrow.index + arrow[0].length) : c.path);
        const oldRaw = arrow ? c.path.slice(0, arrow.index) : parsed?.oldPath;
        const oldP = oldRaw ? normalizePath(oldRaw) : null;
        if (!newP) continue;
        const prev = oldP ? fs.get(oldP) : undefined;
        if (oldP) fs.delete(oldP);
        if (!prev) { keep(fs, newP, { content: '', stale: true }); continue; }
        const content = parsed && parsed.hunks.length ? applyPatch(prev.content, parsed.hunks) : prev.content;
        keep(fs, newP, content == null ? { content: prev.content, stale: true } : { content, stale: prev.stale });
        continue;
      }
      const p = normalizePath(c.path);
      if (!p) continue;
      if (c.status === 'added') {
        const content = parsed ? applyPatch('', parsed.hunks) : null;
        keep(fs, p, content == null ? { content: '', stale: true } : { content, stale: false });
        continue;
      }
      // modified
      const prev = fs.get(p);
      if (!parsed || !prev) {
        keep(fs, p, { content: prev?.content ?? '', stale: true });
        continue;
      }
      const content = applyPatch(prev.content, parsed.hunks);
      keep(fs, p, content == null ? { content: prev.content, stale: true } : { content, stale: prev.stale });
    }
  }
  return fs;
}

/** Entry candidates: .html / .htm, index.html first, the rest in path order. */
export function listPreviewEntries(fs: VirtualFs): string[] {
  const list = [...fs.keys()].filter((p) => /\.html?$/i.test(p)).sort();
  const i = list.indexOf('index.html');
  if (i > 0) { list.splice(i, 1); list.unshift('index.html'); }
  return list;
}

// ---- assembling the preview document ----

export interface AssembleOpts { entry: string; runScripts: boolean; allowExternal: boolean; lang?: 'ja' | 'en' }
export interface AssembleResult { html: string; warnings: string[]; used: string[] }

const CSP_OFF = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:; media-src data:";
const CSP_ON = "default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; font-src data: https:; connect-src https:; media-src data: https:";

export function cspMetaTag(allowExternal: boolean): string {
  return `<meta http-equiv="Content-Security-Policy" content="${allowExternal ? CSP_ON : CSP_OFF}">`;
}

function injectHead(html: string, meta: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + meta + html.slice(at);
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length;
    return html.slice(0, at) + `<head>${meta}</head>` + html.slice(at);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return html.slice(0, at) + `<head>${meta}</head>` + html.slice(at);
}

/** UTF-8 then base64, without TextEncoder/btoa (not guaranteed on every RN runtime). */
export function toBase64(s: string): string {
  const bytes: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += A[b0 >> 2] + A[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? A[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? A[b2 & 63] : '=';
  }
  return out;
}

function getAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i');
  if (re.test(tag)) return tag.replace(re, (_m, s: string) => `${s}${name}="${value}"`);
  return tag.replace(/>$/, ` ${name}="${value}">`);
}

const escScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');
const escStyle = (s: string) => s.replace(/<\/style/gi, '<\\/style');
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

/** Static `import` / `export` statement check for module scripts. */
export function usesImport(js: string): boolean {
  return /(^|[\s;}])import\s*(\{|\*|['"]|[A-Za-z_$][\w$]*\s*(from|,))/.test(js);
}

function fmt(lang: 'ja' | 'en', key: string, vars?: Record<string, string>): string {
  let s = (lang === 'en' ? CP_EN : CP_JA)[key] ?? key;
  for (const k of Object.keys(vars ?? {})) s = s.split(`{${k}}`).join(vars![k]);
  return s;
}

/** Builds one self-contained HTML document from the entry file and the virtual FS. */
export function assemblePreview(fs: VirtualFs, opts: AssembleOpts): AssembleResult {
  const lang = opts.lang ?? 'ja';
  const warnings: string[] = [];
  const used = new Set<string>();
  const warn = (key: string, vars: Record<string, string>) => {
    const m = fmt(lang, key, vars);
    if (!warnings.includes(m)) warnings.push(m);
  };
  const entry = normalizePath(opts.entry) ?? '';
  const entryFile = fs.get(entry);
  if (!entryFile) return { html: '', warnings: [fmt(lang, 'code.preview.warn.noEntry')], used: [] };
  used.add(entry);
  const entryDir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';

  type Ref = { type: 'skip' } | { type: 'outside' } | { type: 'local'; path: string };
  const classify = (ref: string, baseDir: string): Ref => {
    const clean = ref.trim().split(/[?#]/)[0];
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return { type: 'skip' };
    const joined = clean.startsWith('/') ? clean : baseDir ? `${baseDir}/${clean}` : clean;
    const p = normalizePath(joined);
    return p === null ? { type: 'outside' } : { type: 'local', path: p };
  };
  const dataUrlFor = (path: string): string | null => {
    const f = fs.get(path);
    if (!f) return null;
    if (f.dataUrl) return f.dataUrl;
    const c = f.content.trim();
    if (/^data:/i.test(c)) return c;
    if (/\.svg$/i.test(path)) return `data:image/svg+xml;base64,${toBase64(f.content)}`;
    return null;
  };

  const cssRewrite = (css: string, baseDir: string): string =>
    css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m: string, _q: string, ref: string) => {
      const r = classify(ref, baseDir);
      if (r.type === 'skip') return m;
      if (r.type === 'outside') { warn('code.preview.warn.outside', { ref }); return m; }
      const du = dataUrlFor(r.path);
      if (!du) { warn('code.preview.warn.unresolved', { ref }); return m; }
      used.add(r.path);
      return `url("${du}")`;
    });

  const TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>|<style\b([^>]*)>([\s\S]*?)<\/style\s*>|<(link|img|source)\b[^>]*>/gi;
  const body = entryFile.content.replace(TAG_RE, (match: string, sAttrs?: string, sBody?: string, stAttrs?: string, stBody?: string) => {
    if (sAttrs !== undefined) {
      if (!opts.runScripts) return '';
      const src = getAttr(sAttrs, 'src');
      const type = (getAttr(sAttrs, 'type') ?? '').trim().toLowerCase();
      if (!JS_TYPES.has(type)) return match;
      const isModule = type === 'module';
      const inline = sBody ?? '';
      if (src === null) {
        if (isModule && usesImport(inline)) {
          warn('code.preview.warn.moduleImport', { path: entry });
          return `<script type="text/plain">${inline}</script>`;
        }
        return match;
      }
      const r = classify(src, entryDir);
      if (r.type === 'skip') return match;
      if (r.type === 'outside') { warn('code.preview.warn.outside', { ref: src }); return match; }
      const f = fs.get(r.path);
      if (!f) { warn('code.preview.warn.unresolved', { ref: src }); return match; }
      used.add(r.path);
      if (isModule && usesImport(f.content)) {
        warn('code.preview.warn.moduleImport', { path: r.path });
        return `<script type="text/plain">${escScript(f.content)}</script>`;
      }
      return `<script${isModule ? ' type="module"' : ''}>${escScript(f.content)}</script>`;
    }
    if (stAttrs !== undefined) {
      return `<style${stAttrs}>${escStyle(cssRewrite(stBody ?? '', entryDir))}</style>`;
    }
    const tag = match;
    const name = (/^<(\w+)/.exec(tag)?.[1] ?? '').toLowerCase();
    if (name === 'link') {
      const rel = (getAttr(tag, 'rel') ?? '').toLowerCase();
      const href = getAttr(tag, 'href');
      if (!/\bstylesheet\b/.test(rel) || href === null) return tag;
      const r = classify(href, entryDir);
      if (r.type === 'skip') return tag;
      if (r.type === 'outside') { warn('code.preview.warn.outside', { ref: href }); return tag; }
      const f = fs.get(r.path);
      if (!f) { warn('code.preview.warn.unresolved', { ref: href }); return tag; }
      used.add(r.path);
      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
      return `<style>${escStyle(cssRewrite(f.content, dir))}</style>`;
    }
    // img / source
    const src = getAttr(tag, 'src');
    if (src === null) return tag;
    const r = classify(src, entryDir);
    if (r.type === 'skip') return tag;
    if (r.type === 'outside') { warn('code.preview.warn.outside', { ref: src }); return tag; }
    const du = dataUrlFor(r.path);
    if (!du) { warn('code.preview.warn.unresolved', { ref: src }); return tag; }
    used.add(r.path);
    return setAttr(tag, 'src', du);
  });

  const html = injectHead(body, cspMetaTag(opts.allowExternal));
  for (const p of used) {
    if (fs.get(p)?.stale) warn('code.preview.warn.stale', { path: p });
  }
  return { html, warnings, used: [...used] };
}
