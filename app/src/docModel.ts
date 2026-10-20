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
export interface ShapesSpec { bg?: string; body: "top" | "left" | "right" | "none"; notes?: string; elements: Shape[] }

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
