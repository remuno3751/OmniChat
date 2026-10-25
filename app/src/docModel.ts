// SHARED with server/src/docmodel.ts and app/src/docModel.ts - keep byte-identical

export interface Run { text: string; bold?: boolean; italics?: boolean; code?: boolean }
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullet"; level: number; text: string }
  | { kind: "ordered"; n: string; text: string }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "shapes"; raw: string; spec?: ShapesSpec };

/* Slide shapes (docs/design/SLIDE-SHAPES.md). `raw` is the YAML of a ```shapes block; `spec` is filled by server/src/shapes.ts. */
export type ShapeBoxType = "rect" | "roundRect" | "ellipse" | "diamond" | "triangle" | "parallelogram" | "hexagon" | "pentagon" | "chevron" | "rightArrow" | "leftArrow" | "upArrow" | "downArrow" | "cylinder" | "star" | "cloud" | "callout" | "text";
export type ShapeDash = "solid" | "dash" | "dot";
export interface ShapeBox {
  type: ShapeBoxType; id?: string; x: number; y: number; w: number; h: number;
  fill?: string; line?: string; lineWidth?: number; text?: string; color?: string; size?: number;
  bold?: boolean; italic?: boolean; align?: "left" | "center" | "right"; valign?: "top" | "middle" | "bottom";
  rotate?: number; opacity?: number;
}
export interface ShapeLine { type: "line"; x1: number; y1: number; x2: number; y2: number; color?: string; width?: number; dash?: ShapeDash; head?: "none" | "end" | "both" }
export interface ShapeArrow { type: "arrow"; from?: string; to?: string; x1?: number; y1?: number; x2?: number; y2?: number; label?: string; color?: string; width?: number; dash?: ShapeDash }
export type ChartKind = "bar" | "column" | "line" | "pie" | "doughnut" | "area";
export interface ShapeChart { type: "chart"; kind: ChartKind; title?: string; categories: string[]; series: { name: string; values: number[] }[]; x: number; y: number; w: number; h: number }
export type Shape = ShapeBox | ShapeLine | ShapeArrow | ShapeChart;
export type SlideLayout = "cover" | "section" | "cards" | "twoCol" | "quote";
export interface SlideBox { x: number; y: number; w: number; h: number }
/* layout / accent are what the author wrote; ink, titleBox and bodyBox are filled by parseShapes from them (decoration goes into elements). */
export interface ShapesSpec {
  bg?: string; body: "top" | "left" | "right" | "none"; notes?: string; elements: Shape[];
  layout?: SlideLayout; accent?: string;
  /** text color of the title and the body: set by parseShapes (light on a dark bg) */
  ink?: string;
  /** title placement in percent + size (pt) + align; absent = the default top-left title */
  titleBox?: SlideBox & { size: number; align: "left" | "center" | "right" };
  /** body placement in percent; absent = derived from `body` */
  bodyBox?: SlideBox;
}

export type CodeTokKind = "plain" | "comment" | "string" | "keyword" | "number";
export interface CodeTok { text: string; kind: CodeTokKind }
/* Common keywords of PHP, JS/TS, Python, Java, Go, Rust and SQL (compared in lower case). */
const CODE_KEYWORDS: ReadonlySet<string> = new Set([
  // JS / TS
  "var", "let", "const", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "new", "class", "extends", "import", "export", "from", "default", "try", "catch", "finally", "throw", "async", "await",
  "typeof", "instanceof", "interface", "type", "enum", "implements", "null", "undefined", "true", "false", "this", "super",
  "yield", "void",
  // PHP
  "echo", "isset", "foreach", "namespace", "use", "public", "private", "protected", "static", "abstract", "final", "elseif",
  "endif", "as", "require", "include", "global", "array", "match", "fn",
  // Python
  "def", "elif", "pass", "lambda", "with", "is", "not", "and", "or", "none", "nonlocal", "raise", "assert", "del", "yield",
  "except", "in",
  // Java / C#-like
  "package", "throws", "int", "long", "double", "float", "boolean", "char", "byte", "short", "synchronized", "volatile",
  // Go
  "func", "go", "defer", "chan", "map", "range", "select", "struct", "fallthrough", "goto",
  // Rust
  "fn", "let", "mut", "impl", "trait", "pub", "mod", "crate", "loop", "where", "move", "ref", "self", "unsafe", "dyn", "else",
  // SQL
  "insert", "into", "update", "delete", "create", "alter", "drop", "join", "inner", "outer", "having", "like", "between",
  "distinct", "union", "exists", "select", "where",
]);

/** One line of code -> colored pieces. Stateless and language-agnostic: the texts concatenate back to `line` exactly. */
export function codeTokens(line: string): CodeTok[] {
  const out: CodeTok[] = [];
  const push = (text: string, kind: CodeTokKind): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  const n = line.length;
  const atStart = (i: number) => i === 0 || /\s/.test(line[i - 1]);
  let i = 0;
  while (i < n) {
    const c = line[i];
    // line comments: // anywhere, # and -- only at the start of a word (so `a#b` is not a comment)
    if (line.startsWith("//", i) || ((c === "#" || line.startsWith("--", i)) && atStart(i))) {
      push(line.slice(i), "comment");
      break;
    }
    // block comment, on one line only
    if (line.startsWith("/*", i)) {
      const end = line.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      push(line.slice(i, stop), "comment");
      i = stop;
      continue;
    }
    // strings with backslash escapes; an unclosed string runs to the end of the line
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        const d = line[j];
        if (d === "\\") { j += 2; continue; }
        j++;
        if (d === c) break;
      }
      j = Math.min(j, n);
      push(line.slice(i, j), "string");
      i = j;
      continue;
    }
    const prev = i === 0 ? "" : line[i - 1];
    const inWord = /[A-Za-z0-9_$]/.test(prev);
    // numbers: not part of an identifier
    if (!inWord && (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(line[i + 1] ?? "")))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(line.slice(i));
      if (m) {
        push(m[0], "number");
        i += m[0].length;
        continue;
      }
    }
    // identifiers and keywords
    if (/[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(i))![0];
      push(word, CODE_KEYWORDS.has(word.toLowerCase()) ? "keyword" : "plain");
      i += word.length;
      continue;
    }
    push(c, "plain");
    i++;
  }
  return out;
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)/g;

/** Bold / italic / inline code runs; links become "text (url)". */
export function inlineRuns(text: string): Run[] {
  const clean = text.replace(/!?\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, t: string, u: string) => (t ? `${t} (${u})` : u));
  const out: Run[] = [];
  let last = 0;
  for (const m of clean.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: clean.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith("`")) out.push({ text: tok.slice(1, -1), code: true });
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push({ text: tok.slice(2, -2), bold: true });
    else out.push({ text: tok.slice(1, -1), italics: true });
    last = idx + tok.length;
  }
  if (last < clean.length) out.push({ text: clean.slice(last) });
  return out.length ? out : [{ text: "" }];
}

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
};
const isSeparator = (line: string): boolean =>
  line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

/** Line-based block parser for the subset described in section 4 (headings, paragraphs, lists, tables, code, quotes). */
export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i])) code.push(lines[i++]);
      if (fence[2] === "shapes") blocks.push({ kind: "shapes", raw: code.join("\n") });
      else blocks.push({ kind: "code", lines: code });
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); blocks.push({ kind: "heading", level: h[1].length, text: h[2] }); continue; }
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush();
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (b) { flush(); blocks.push({ kind: "bullet", level: Math.min(2, Math.floor(b[1].length / 2)), text: b[2] }); continue; }
    const o = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (o) { flush(); blocks.push({ kind: "ordered", n: o[1], text: o[2] }); continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { flush(); blocks.push({ kind: "para", text: q[1] }); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export interface Slide { title: string; blocks: Block[] }

/** Each heading of level 1 or 2 starts a slide; text before the first one goes on a slide titled `title`. */
export function toSlides(blocks: Block[], title: string): Slide[] {
  const slides: Slide[] = [];
  let cur: Slide | null = null;
  for (const b of blocks) {
    if (b.kind === "heading" && b.level <= 2) {
      cur = { title: b.text, blocks: [] };
      slides.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title, blocks: [] };
      slides.push(cur);
    }
    cur.blocks.push(
      b.kind === "heading" ? { kind: "para", text: `**${b.text}**` }
      : b.kind === "shapes" && !b.spec ? { kind: "code", lines: b.raw.split("\n") }
      : b,
    );
  }
  if (!slides.length) slides.push({ title, blocks: [] });
  return slides.slice(0, 200);
}
