import { parse } from "yaml";
import type { Block, ChartKind, Shape, ShapeArrow, ShapeBox, ShapeChart, ShapeBoxType, ShapesSpec, SlideBox, SlideLayout } from "./docmodel.js";

/* Slide shapes (docs/design/SLIDE-SHAPES.md): parses the YAML of a ```shapes block into a validated ShapesSpec.
 * The AI output is never trusted: unknown keys are ignored, numbers are clamped, colors are whitelisted, limits are enforced.
 * Anything broken gives null, and the caller keeps the block as a code block. */

export const SHAPES_LIMITS = {
  rawBytes: 100_000,
  elements: 60,
  charts: 4,
  series: 8,
  categories: 50,
  text: 500,
  notes: 2000,
  idLength: 64,
  yamlAliases: 20,
} as const;

const BOX_TYPES: ReadonlySet<string> = new Set<ShapeBoxType>([
  "rect", "roundRect", "ellipse", "diamond", "triangle", "parallelogram", "hexagon", "pentagon", "chevron",
  "rightArrow", "leftArrow", "upArrow", "downArrow", "cylinder", "star", "cloud", "callout", "text",
]);
const CHART_KINDS: readonly ChartKind[] = ["bar", "column", "line", "pie", "doughnut", "area"];
const DASHES = ["solid", "dash", "dot"] as const;
const ALIGNS = ["left", "center", "right"] as const;
const VALIGNS = ["top", "middle", "bottom"] as const;
const BODIES = ["top", "left", "right", "none"] as const;
const HEADS = ["none", "end", "both"] as const;
const LAYOUTS: readonly SlideLayout[] = ["cover", "section", "cards", "twoCol", "quote"];

/* Text colors on a slide (ink). A dark background flips the text to the light ink. */
export const INK_DARK = "#1f2937";
export const INK_LIGHT = "#f8fafc";
export const DEFAULT_ACCENT = "#3b82f6";

/* Named colors (the only words allowed besides #rgb / #rrggbb). */
const NAMED: Readonly<Record<string, string>> = {
  blue: "#3b82f6", green: "#10b981", red: "#ef4444", orange: "#f59e0b", yellow: "#facc15",
  purple: "#8b5cf6", gray: "#6b7280", black: "#000000", white: "#ffffff",
};

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Finite number clamped to [min, max]; anything else is undefined. */
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

/** Text: numbers are written out, control characters dropped, at most `max` characters. */
const str = (v: unknown, max: number = SHAPES_LIMITS.text): string | undefined => {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v : undefined;
  return s === undefined ? undefined : Array.from(s.replace(CONTROL, "")).slice(0, max).join("");
};

/** Element id: a non-empty string (or a number) of at most 64 characters. */
const idOf = (v: unknown): string | undefined => {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
  return s && s.length <= SHAPES_LIMITS.idLength ? s : undefined;
};

const pick = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** "#rgb" / "#rrggbb" (lower case, 6 digits out) or a color name; with allowNone also "none". */
export function parseColor(v: unknown, allowNone: boolean): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (allowNone && s === "none") return "none";
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) return NAMED[s];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return undefined;
  return m[1].length === 3 ? `#${[...m[1]].map((c) => c + c).join("")}` : `#${m[1]}`;
}

/** Drops keys whose value is undefined, so the result compares cleanly. */
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Charts whose position was left out by the AI. */
const AUTO_PLACED = new WeakSet<object>();

const rectOf = (e: Record<string, unknown>) => {
  const x = num(e.x, 0, 100), y = num(e.y, 0, 100), w = num(e.w, 0, 100), h = num(e.h, 0, 100);
  return x === undefined || y === undefined || w === undefined || h === undefined ? undefined : { x, y, w, h };
};

function parseSeries(v: unknown, kind: ChartKind, categories: string[]): { name: string; values: number[] }[] {
  if (!Array.isArray(v)) return [];
  const max = kind === "pie" || kind === "doughnut" ? 1 : SHAPES_LIMITS.series;
  const out: { name: string; values: number[] }[] = [];
  for (const s of v) {
    if (out.length >= max) break;
    if (!isObj(s)) continue;
    const raw = Array.isArray(s.values) ? s.values : [];
    const values = categories.map((_, i) => {
      const n = raw[i];
      return typeof n === "number" && Number.isFinite(n) ? n : 0;
    });
    out.push({ name: str(s.name, 100) ?? "", values });
  }
  return out;
}

function parseElement(e: unknown): Shape | null {
  if (!isObj(e)) return null;
  const type = e.type;
  if (type === "line") {
    const x1 = num(e.x1, 0, 100), y1 = num(e.y1, 0, 100), x2 = num(e.x2, 0, 100), y2 = num(e.y2, 0, 100);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;
    return clean({
      type: "line" as const, x1, y1, x2, y2,
      color: parseColor(e.color, false), width: num(e.width, 0, 20), dash: pick(e.dash, DASHES), head: pick(e.head, HEADS),
    });
  }
  if (type === "arrow") {
    const from = idOf(e.from), to = idOf(e.to);
    const x1 = num(e.x1, 0, 100), y1 = num(e.y1, 0, 100), x2 = num(e.x2, 0, 100), y2 = num(e.y2, 0, 100);
    const byId = from !== undefined && to !== undefined;
    const byCoords = x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined;
    if (!byId && !byCoords) return null;
    return clean({
      type: "arrow" as const,
      from: byId ? from : undefined, to: byId ? to : undefined,
      x1: byId ? undefined : x1, y1: byId ? undefined : y1, x2: byId ? undefined : x2, y2: byId ? undefined : y2,
      label: str(e.label, SHAPES_LIMITS.text), color: parseColor(e.color, false), width: num(e.width, 0, 20), dash: pick(e.dash, DASHES),
    }) as ShapeArrow;
  }
  if (type === "chart") {
    const kind = pick(e.kind, CHART_KINDS);
    // a chart the AI gave no position is placed later (tidyElements), where there is room
    const given = rectOf(e);
    const r = given ?? { x: 6, y: 16, w: 88, h: 78 };
    if (!kind) return null;
    const categories = Array.isArray(e.categories)
      ? e.categories.slice(0, SHAPES_LIMITS.categories).map((c) => str(c) ?? "")
      : [];
    const series = parseSeries(e.series, kind, categories);
    if (!categories.length || !series.length) return null;
    const chart = clean({ type: "chart" as const, kind, title: str(e.title, 200), categories, series, ...r }) as ShapeChart;
    if (!given) AUTO_PLACED.add(chart);
    return chart;
  }
  if (typeof type === "string" && BOX_TYPES.has(type)) {
    const r = rectOf(e);
    if (!r) return null;
    const box: ShapeBox = clean({
      type: type as ShapeBoxType,
      id: idOf(e.id),
      ...r,
      fill: parseColor(e.fill, true),
      line: parseColor(e.line, true),
      lineWidth: num(e.lineWidth, 0, 20),
      text: str(e.text),
      color: parseColor(e.color, false),
      size: num(e.size, 6, 96),
      bold: typeof e.bold === "boolean" ? e.bold : undefined,
      italic: typeof e.italic === "boolean" ? e.italic : undefined,
      align: pick(e.align, ALIGNS),
      valign: pick(e.valign, VALIGNS),
      rotate: num(e.rotate, -360, 360),
      opacity: num(e.opacity, 0, 1),
    });
    return box;
  }
  return null; // unknown type (including "image", which is reserved)
}

/** YAML of a ```shapes block -> validated spec, or null when it is broken (too big, not an object, bad YAML, alias bomb). */
export function parseShapes(raw: string): ShapesSpec | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > SHAPES_LIMITS.rawBytes) return null;
    const doc: unknown = parse(raw, { maxAliasCount: SHAPES_LIMITS.yamlAliases } as any);
    if (!isObj(doc)) return null;
    // `elements` may be left out: a block that is only a layout ("layout: cover") is valid
    if (doc.elements !== undefined && doc.elements !== null && !Array.isArray(doc.elements)) return null;
    const elements: Shape[] = [];
    const seen = new Set<string>();
    let charts = 0;
    for (const item of (doc.elements ?? []) as unknown[]) {
      if (elements.length >= SHAPES_LIMITS.elements) break;
      const s = parseElement(item);
      if (!s) continue;
      if (s.type === "chart") {
        if (charts >= SHAPES_LIMITS.charts) continue;
        charts++;
      } else if (s.type !== "line" && s.type !== "arrow" && s.id !== undefined) {
        if (seen.has(s.id)) delete s.id; // duplicate ids: the first one wins
        else seen.add(s.id);
      }
      elements.push(s);
    }
    // An arrow must point at boxes that exist in the spec; otherwise it is dropped (the rest is kept).
    const boxes = new Map<string, ShapeBox>();
    for (const s of elements) if (s.type !== "line" && s.type !== "arrow" && s.type !== "chart" && s.id !== undefined) boxes.set(s.id, s);
    const kept = elements.filter((s) => s.type !== "arrow" || s.from === undefined || (boxes.has(s.from) && s.to !== undefined && boxes.has(s.to)));
    const body = pick(doc.body, BODIES) ?? "top";
    const { elements: placed, bg: coverBg } = tidyElements(kept);
    const layout = pick(doc.layout, LAYOUTS);
    const accent = parseColor(doc.accent, false) ?? (layout ? DEFAULT_ACCENT : undefined);
    return finishSpec(clean({
      bg: parseColor(doc.bg, false) ?? coverBg,
      body,
      notes: str(doc.notes, SHAPES_LIMITS.notes),
      elements: placed,
      layout,
      accent,
    }) as ShapesSpec);
  } catch {
    return null;
  }
}

/** Where a chart without a position goes: the first of these areas the placed boxes leave free, else the whole content area. */
const CHART_SPOTS: SlideBox[] = [
  { x: 6, y: 16, w: 88, h: 78 }, { x: 6, y: 50, w: 88, h: 44 }, { x: 6, y: 16, w: 88, h: 34 },
  { x: 52, y: 16, w: 42, h: 78 }, { x: 6, y: 16, w: 42, h: 78 }, { x: 52, y: 50, w: 42, h: 44 }, { x: 6, y: 50, w: 42, h: 44 },
];
function freeSpot(placed: SlideBox[]): SlideBox {
  const hit = (a: SlideBox, b: SlideBox) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
  return CHART_SPOTS.find((c) => !placed.some((p) => hit(c, p))) ?? CHART_SPOTS[0];
}

/** Boxes the AI placed (not layout decoration): kept inside the slide, and a plain rectangle that covers the whole
 * slide becomes the background (so it cannot hide the title and the text drawn before it). */
export function tidyElements(els: Shape[]): { elements: Shape[]; bg?: string } {
  let bg: string | undefined;
  const out: Shape[] = [];
  const placed = els.filter((e): e is ShapeBox | ShapeChart => e.type !== "line" && e.type !== "arrow" && !AUTO_PLACED.has(e)).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));
  for (const e of els) {
    if (e.type === "line" || e.type === "arrow") { out.push(e); continue; }
    if (e.type === "chart" && AUTO_PLACED.has(e)) {
      const spot = freeSpot(placed);
      placed.push(spot);
      out.push({ ...e, ...spot });
      continue;
    }
    const w = Math.min(e.w, 100), h = Math.min(e.h, 100);
    const x = Math.max(0, Math.min(e.x, 100 - w)), y = Math.max(0, Math.min(e.y, 100 - h));
    const box = { ...e, x, y, w, h };
    const bare = e.type !== "chart" && !(e as ShapeBox).text && ((e as ShapeBox).opacity ?? 1) >= 0.95;
    if (bare && bg === undefined && x <= 1 && y <= 1 && w >= 98 && h >= 98 && (e as ShapeBox).fill) { bg = (e as ShapeBox).fill; continue; }
    out.push(box as Shape);
  }
  return { elements: out, bg };
}

/** Layout expansion, then the ink from the final background. */
export function finishSpec(spec: ShapesSpec): ShapesSpec {
  const laid = applyLayout(spec);
  return { ...laid, ink: inkFor(laid.bg ?? "#ffffff") };
}

/** Text color for a background: light ink when the relative luminance is below 0.5. */
export function inkFor(bg: string): string {
  const m = /^#([0-9a-f]{6})$/.exec(bg);
  if (!m) return INK_DARK;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum < 0.5 ? INK_LIGHT : INK_DARK;
}

/** Expands `spec.layout` (and `spec.accent` alone) into decoration elements, which go in front of the author's
 * elements (they do not count toward the element limit), plus a background default and the title / body boxes. */
export function applyLayout(spec: ShapesSpec): ShapesSpec {
  const accent = spec.accent ?? DEFAULT_ACCENT;
  const underline = (): ShapeBox => ({ type: "rect", x: 4, y: 14.5, w: 12, h: 0.9, fill: accent });
  const decor: Shape[] = [];
  let bg = spec.bg;
  let titleBox: ShapesSpec["titleBox"];
  let bodyBox: SlideBox | undefined;
  switch (spec.layout) {
    case "cover":
      bg = bg ?? "#0f172a";
      decor.push(
        { type: "rect", x: 0, y: 0, w: 2.2, h: 100, fill: accent },
        { type: "rect", x: 8, y: 54, w: 14, h: 1, fill: accent },
      );
      titleBox = { x: 8, y: 28, w: 84, h: 24, size: 44, align: "left" };
      bodyBox = { x: 8, y: 58, w: 84, h: 28 };
      break;
    case "section":
      bg = bg ?? accent;
      decor.push({ type: "ellipse", x: 70, y: -20, w: 50, h: 90, fill: "#ffffff", opacity: 0.08 });
      titleBox = { x: 8, y: 36, w: 84, h: 28, size: 40, align: "left" };
      bodyBox = { x: 8, y: 66, w: 84, h: 20 };
      break;
    case "cards":
      decor.push(underline());
      break;
    case "twoCol":
      decor.push(underline(), { type: "roundRect", x: 52, y: 18, w: 44, h: 72, fill: accent, opacity: 0.08 });
      bodyBox = { x: 4, y: 18, w: 44, h: 72 };
      break;
    case "quote":
      decor.push(
        { type: "text", x: 6, y: 6, w: 14, h: 26, text: "“", size: 120, bold: true, color: accent },
        { type: "rect", x: 8, y: 34, w: 0.8, h: 40, fill: accent },
      );
      titleBox = { x: 12, y: 8, w: 80, h: 12, size: 18, align: "left" };
      bodyBox = { x: 12, y: 30, w: 80, h: 50 };
      break;
    default:
      if (spec.accent !== undefined) decor.push(underline());
  }
  return clean({ ...spec, bg, elements: [...decor, ...spec.elements], titleBox, bodyBox });
}

/* Arrow labels: an estimate of the text box (percent of the slide), off the line, inside the slide. */
const CJK_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const PT_W = 0.104; // 1 pt of width in percent of a 960 pt wide slide
const PT_H = 0.185; // 1 pt of height in percent of a 540 pt tall slide

/** Box (percent) for an arrow label of `text` at `size` pt: centered above a mostly horizontal segment, right of a vertical one. */
export function arrowLabelBox(seg: Segment, text: string, size: number = 12): SlideBox {
  let pt = 0;
  for (const ch of text) pt += CJK_CHAR.test(ch) ? size * 1.0 : size * 0.55;
  const w = Math.min(100, pt * PT_W);
  const h = Math.min(100, size * 1.5 * PT_H);
  const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
  const mx = (seg.x1 + seg.x2) / 2, my = (seg.y1 + seg.y2) / 2;
  let cx = mx, cy = my;
  if (Math.abs(dx) * 16 >= Math.abs(dy) * 9) cy = my - (h / 2 + 0.5);
  else cx = mx + (w / 2 + 0.5);
  return {
    x: Math.min(100 - w, Math.max(0, cx - w / 2)),
    y: Math.min(100 - h, Math.max(0, cy - h / 2)),
    w,
    h,
  };
}

/** Fills `spec` on every ```shapes block (blocks that do not parse keep no spec and fall back to code). */
export function attachShapes(blocks: Block[]): Block[] {
  return blocks.map((b) => {
    if (b.kind !== "shapes") return b;
    const spec = parseShapes(b.raw);
    return spec ? { kind: "shapes", raw: b.raw, spec } : { kind: "shapes", raw: b.raw };
  });
}

/* ---- arrow geometry (shared by renderers) ---- */

export interface Segment { x1: number; y1: number; x2: number; y2: number }

/** Point on the side of `r` that faces the center of `o` (in 16:9 units, so the choice matches the slide). */
function sideToward(r: ShapeBox, o: ShapeBox): { x: number; y: number } {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = (o.x + o.w / 2 - cx) * 16, dy = (o.y + o.h / 2 - cy) * 9;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? r.x + r.w : r.x, y: cy };
  return { x: cx, y: dy >= 0 ? r.y + r.h : r.y };
}

/** Segment (in slide percent) of an arrow: between the facing sides of its two boxes, or its own coordinates. */
export function arrowSegment(a: ShapeArrow, boxes: ReadonlyMap<string, ShapeBox>): Segment | null {
  if (a.from !== undefined && a.to !== undefined) {
    const f = boxes.get(a.from), t = boxes.get(a.to);
    if (!f || !t) return null;
    const p = sideToward(f, t), q = sideToward(t, f);
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
  }
  if (a.x1 !== undefined && a.y1 !== undefined && a.x2 !== undefined && a.y2 !== undefined) {
    return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
  }
  return null;
}
