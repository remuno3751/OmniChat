import { parse } from "yaml";
import type { Block, ChartKind, Shape, ShapeArrow, ShapeBox, ShapeBoxType, ShapesSpec } from "./docmodel.js";

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
    const r = rectOf(e);
    if (!kind || !r) return null;
    const categories = Array.isArray(e.categories)
      ? e.categories.slice(0, SHAPES_LIMITS.categories).map((c) => str(c) ?? "")
      : [];
    const series = parseSeries(e.series, kind, categories);
    if (!categories.length || !series.length) return null;
    return clean({ type: "chart" as const, kind, title: str(e.title, 200), categories, series, ...r });
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
    if (!isObj(doc) || !Array.isArray(doc.elements)) return null;
    const elements: Shape[] = [];
    const seen = new Set<string>();
    let charts = 0;
    for (const item of doc.elements) {
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
    return clean({
      bg: parseColor(doc.bg, false),
      body,
      notes: str(doc.notes, SHAPES_LIMITS.notes),
      elements: kept,
    }) as ShapesSpec;
  } catch {
    return null;
  }
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
