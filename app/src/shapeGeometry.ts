import type { Block, Shape, ShapeArrow, ShapeBox, ShapeBoxType, ShapeChart, ShapesSpec } from './docModel';

/*
 * Geometry of slide shapes (docs/design/SLIDE-SHAPES.md), shared by the slide preview and its tests.
 * Pure functions only (no React Native), so they run under node --test.
 *
 * Drawing space: a 1600 x 900 box, which is the 16:9 slide. Spec positions are percent of the slide, so a
 * percent value p maps to p * 16 horizontally and p * 9 vertically. 1 pt = 2.5 units (the slide is 640 pt wide,
 * which is how the preview scales text too).
 *
 * arrowSegment is the same code as server/src/shapes.ts (keep them identical; the tests pin the values).
 */

export const VIEW_W = 1600;
export const VIEW_H = 900;
export const VIEWBOX = `0 0 ${VIEW_W} ${VIEW_H}`;
/** Units per point. */
export const PT = 2.5;
export const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#ec4899'];
export const DEFAULT_FILL = '#e5e7eb';
export const INK = '#1f2937';
export const GRID = '#e5e7eb';
export const AXIS = '#9ca3af';

/** Region of the slide in percent. */
export interface Box { x: number; y: number; w: number; h: number }

/** Where the body text of a slide goes, in percent (the title is always the top 14%). */
export const TITLE_REGION: Box = { x: 4, y: 0, w: 92, h: 14 };
const BODY_REGIONS: Record<ShapesSpec['body'], Box | null> = {
  top: { x: 4, y: 16, w: 92, h: 22 },
  left: { x: 4, y: 16, w: 41, h: 78 },
  right: { x: 55, y: 16, w: 41, h: 78 },
  none: null,
};

export function bodyRegion(body: ShapesSpec['body']): Box | null {
  return BODY_REGIONS[body];
}

/** Percent box -> drawing units. */
export function toUnits(b: Box): Box {
  return { x: (b.x * VIEW_W) / 100, y: (b.y * VIEW_H) / 100, w: (b.w * VIEW_W) / 100, h: (b.h * VIEW_H) / 100 };
}

/* ---- which slides carry shapes ---- */

/** True when the markdown has a ```shapes fence (the only case where the server preview is needed). */
export function hasShapesBlock(markdown: string): boolean {
  return /^[ \t]*(?:```|~~~)[ \t]*shapes(?:[ \t]|$)/m.test(markdown);
}

export function slideHasShapes(blocks: Block[]): boolean {
  return blocks.some((b) => b.kind === 'shapes' && b.spec !== undefined);
}

/** The spec of every ```shapes block that parsed, in document order (the preview of a docx needs them this way). */
export function specsInOrder(slides: { blocks: Block[] }[]): ShapesSpec[] {
  const out: ShapesSpec[] = [];
  for (const s of slides) for (const b of s.blocks) if (b.kind === 'shapes' && b.spec) out.push(b.spec);
  return out;
}

/** Puts specs back on the shapes blocks of a parsed document, in order. Blocks without a spec stay without one. */
export function attachSpecs(blocks: Block[], specs: ShapesSpec[]): Block[] {
  let i = 0;
  return blocks.map((b) => {
    if (b.kind !== 'shapes') return b;
    const spec = specs[i++];
    return spec ? { kind: 'shapes', raw: b.raw, spec } : b;
  });
}

/** Plain texts of a spec, for the docx alternative (box texts, chart titles, arrow labels). */
export function shapeTexts(spec: ShapesSpec): string[] {
  const out: string[] = [];
  for (const e of spec.elements) {
    if (e.type === 'chart') {
      if (e.title) out.push(e.title);
    } else if (e.type === 'arrow') {
      if (e.label) out.push(e.label);
    } else if (e.type !== 'line' && e.text) {
      out.push(e.text);
    }
  }
  return out;
}

/** FNV-1a hash of the title and markdown, with the length: the key of the preview cache. */
export function previewKey(type: string, title: string, markdown: string): string {
  const s = `${type}\u0000${title}\u0000${markdown}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

/* ---- arrows ---- */

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

/** The boxes of a spec by id (lines, arrows and charts are not boxes). */
export function boxMap(elements: Shape[]): Map<string, ShapeBox> {
  const m = new Map<string, ShapeBox>();
  for (const s of elements) if (s.type !== 'line' && s.type !== 'arrow' && s.type !== 'chart' && s.id !== undefined) m.set(s.id, s);
  return m;
}

/** Arrowhead triangle at the tip (x2, y2), in units. `len` is the length of the head, `half` its half width. */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, len: number, half: number): [number, number][] {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy);
  if (d === 0) return [];
  const ux = dx / d, uy = dy / d;
  const bx = x2 - ux * len, by = y2 - uy * len; // where the head meets the shaft
  return [[x2, y2], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
}

/** SVG stroke-dasharray for a dash style, scaled by the stroke width (units). */
export function dashArray(dash: 'solid' | 'dash' | 'dot' | undefined, width: number): string | undefined {
  if (dash === 'dash') return `${4 * width} ${3 * width}`;
  if (dash === 'dot') return `${width} ${2.5 * width}`;
  return undefined;
}

/* ---- outlines (drawing units) ---- */

const f2 = (n: number): number => Math.round(n * 100) / 100;
type P = [number, number];
const poly = (pts: P[]): string => `${pts.map((p, i) => `${i ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])}`).join(' ')} Z`;
const ellipsePath = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${f2(cx - rx)} ${f2(cy)} A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(cx + rx)} ${f2(cy)} A${f2(rx)} ${f2(ry)} 0 1 0 ${f2(cx - rx)} ${f2(cy)} Z`;
function roundRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const R = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${f2(x + R)} ${f2(y)}`, `L${f2(x + w - R)} ${f2(y)}`, `Q${f2(x + w)} ${f2(y)} ${f2(x + w)} ${f2(y + R)}`,
    `L${f2(x + w)} ${f2(y + h - R)}`, `Q${f2(x + w)} ${f2(y + h)} ${f2(x + w - R)} ${f2(y + h)}`,
    `L${f2(x + R)} ${f2(y + h)}`, `Q${f2(x)} ${f2(y + h)} ${f2(x)} ${f2(y + h - R)}`,
    `L${f2(x)} ${f2(y + R)}`, `Q${f2(x)} ${f2(y)} ${f2(x + R)} ${f2(y)} Z`,
  ].join(' ');
}

/** Right arrow in local coordinates (u along, v across, both 0..1), mapped to the box by `map`. */
const ARROW_RIGHT: P[] = [[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]];

function arrowShape(type: 'rightArrow' | 'leftArrow' | 'upArrow' | 'downArrow', b: Box): string {
  const pts = ARROW_RIGHT.map(([u, v]): P => {
    switch (type) {
      case 'rightArrow': return [b.x + u * b.w, b.y + v * b.h];
      case 'leftArrow': return [b.x + (1 - u) * b.w, b.y + v * b.h];
      case 'upArrow': return [b.x + v * b.w, b.y + (1 - u) * b.h];
      default: return [b.x + v * b.w, b.y + u * b.h];
    }
  });
  return poly(pts);
}

/** SVG path (drawing units) of a shape box. null for `text` (no outline). */
export function shapeOutline(type: ShapeBoxType, box: Box): string | null {
  const { x, y, w, h } = box;
  const cx = x + w / 2, cy = y + h / 2;
  switch (type) {
    case 'rect': return poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
    case 'roundRect': return roundRectPath(x, y, w, h, Math.min(w, h) * 0.15);
    case 'ellipse': return ellipsePath(cx, cy, w / 2, h / 2);
    case 'diamond': return poly([[cx, y], [x + w, cy], [cx, y + h], [x, cy]]);
    case 'triangle': return poly([[cx, y], [x + w, y + h], [x, y + h]]);
    case 'parallelogram': return poly([[x + w * 0.2, y], [x + w, y], [x + w * 0.8, y + h], [x, y + h]]);
    case 'hexagon': return poly([[x + w * 0.25, y], [x + w * 0.75, y], [x + w, cy], [x + w * 0.75, y + h], [x + w * 0.25, y + h], [x, cy]]);
    case 'pentagon': return poly([[cx, y], [x + w, y + h * 0.38], [x + w * 0.82, y + h], [x + w * 0.18, y + h], [x, y + h * 0.38]]);
    case 'chevron': return poly([[x, y], [x + w * 0.75, y], [x + w, cy], [x + w * 0.75, y + h], [x, y + h], [x + w * 0.25, cy]]);
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': return arrowShape(type, box);
    case 'cylinder': {
      const ry = Math.min(h * 0.12, w / 2);
      const body = `M${f2(x)} ${f2(y + ry)} A${f2(w / 2)} ${f2(ry)} 0 0 0 ${f2(x + w)} ${f2(y + ry)} L${f2(x + w)} ${f2(y + h - ry)} A${f2(w / 2)} ${f2(ry)} 0 0 1 ${f2(x)} ${f2(y + h - ry)} Z`;
      return `${body} ${ellipsePath(cx, y + ry, w / 2, ry)}`;
    }
    case 'star': {
      const R = Math.min(w, h) / 2, r = R * 0.45;
      const pts: P[] = [];
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rad = k % 2 === 0 ? R : r;
        pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
      }
      return poly(pts);
    }
    case 'cloud':
      return [
        ellipsePath(cx, y + h * 0.6, w * 0.5, h * 0.4),
        ellipsePath(x + w * 0.28, y + h * 0.45, w * 0.22, h * 0.3),
        ellipsePath(x + w * 0.55, y + h * 0.35, w * 0.25, h * 0.35),
        ellipsePath(x + w * 0.8, y + h * 0.5, w * 0.18, h * 0.28),
      ].join(' ');
    case 'callout':
      return `${roundRectPath(x, y, w, h * 0.8, Math.min(w, h) * 0.12)} ${poly([[x + w * 0.15, y + h * 0.8], [x + w * 0.35, y + h * 0.8], [x + w * 0.12, y + h]])}`;
    case 'text': return null;
  }
}

/* ---- charts ---- */

export type Prim =
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill: string; opacity?: number }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number }
  | { k: 'path'; d: string; fill: string; opacity?: number; stroke?: string; width?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill: string }
  | { k: 'text'; x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; fill: string; bold?: boolean };

/** Round tick values from a range: a step of 1, 2 or 5 times a power of ten, covering [min, max] (min <= 0 <= max is typical). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.2;
  const rough = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let i = 0; start + i * step <= end + step / 1000 && ticks.length < 60; i++) {
    ticks.push(+(Math.round((start + i * step) / step) * step).toPrecision(12));
  }
  return ticks;
}

/** Tick label text: integers as they are, others to two decimals. */
export function formatTick(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(2));
}

const polar = (cx: number, cy: number, r: number, a: number): P => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/** Arc commands from angle a0 to a1 (radians, clockwise on screen when increasing). Full circles are split in two. */
function arcCmd(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const span = Math.abs(a1 - a0);
  if (span >= 2 * Math.PI - 1e-6) {
    const m = a0 + (a1 - a0) / 2;
    return `${arcCmd(cx, cy, r, a0, m)} ${arcCmd(cx, cy, r, m, a1)}`;
  }
  const large = span > Math.PI ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  const [px, py] = polar(cx, cy, r, a1);
  return `A${f2(r)} ${f2(r)} 0 ${large} ${sweep} ${f2(px)} ${f2(py)}`;
}

/** Pie or doughnut slices, starting at 12 o'clock and going clockwise. Negative and empty values are skipped. */
function pieSlices(cx: number, cy: number, R: number, ri: number, values: number[]): Prim[] {
  const vals = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = vals.reduce((s, v) => s + v, 0);
  const out: Prim[] = [];
  if (total <= 0) return out;
  let a = -Math.PI / 2;
  vals.forEach((v, i) => {
    if (v <= 0) return;
    const a1 = a + (v / total) * 2 * Math.PI;
    const fill = PALETTE[i % PALETTE.length];
    const d = ri <= 0
      ? `M${f2(cx)} ${f2(cy)} L${f2(polar(cx, cy, R, a)[0])} ${f2(polar(cx, cy, R, a)[1])} ${arcCmd(cx, cy, R, a, a1)} Z`
      : `M${f2(polar(cx, cy, R, a)[0])} ${f2(polar(cx, cy, R, a)[1])} ${arcCmd(cx, cy, R, a, a1)} L${f2(polar(cx, cy, ri, a1)[0])} ${f2(polar(cx, cy, ri, a1)[1])} ${arcCmd(cx, cy, ri, a1, a)} Z`;
    out.push({ k: 'path', d, fill, stroke: '#ffffff', width: 1.5 * PT });
    a = a1;
  });
  return out;
}

/** Legend entries: swatch color and label. Pie-like charts list their categories, the others their series. */
export function legendEntries(c: ShapeChart): { name: string; color: string }[] {
  if (c.kind === 'pie' || c.kind === 'doughnut') {
    const vals = (c.series[0]?.values ?? []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
    const total = vals.reduce((s, v) => s + v, 0);
    return c.categories.map((name, i) => ({
      name: total > 0 ? `${name} ${Math.round(((vals[i] ?? 0) / total) * 100)}%` : name,
      color: PALETTE[i % PALETTE.length],
    }));
  }
  return c.series.length >= 2 ? c.series.map((s, i) => ({ name: s.name, color: PALETTE[i % PALETTE.length] })) : [];
}

/**
 * Drawing primitives of a chart, in units of the whole slide. The chart's own box (percent) is laid out as
 * title (top), plot, category labels, and a legend at the bottom when there is one.
 */
export function chartPrimitives(c: ShapeChart): Prim[] {
  const b = toUnits(c);
  const out: Prim[] = [];
  const titleH = c.title ? b.h * 0.13 : 0;
  const legend = legendEntries(c);
  const legendH = legend.length ? b.h * 0.1 : 0;
  const top = b.y + titleH;
  const bottom = b.y + b.h - legendH;
  const fsTick = 11 * PT, fsLabel = 12 * PT;
  if (c.title) out.push({ k: 'text', x: b.x + b.w / 2, y: b.y + titleH * 0.7, text: c.title, size: 16 * PT, anchor: 'middle', fill: INK, bold: true });

  if (c.kind === 'pie' || c.kind === 'doughnut') {
    const R = (Math.min(b.w, bottom - top) / 2) * 0.9;
    const cx = b.x + b.w / 2, cy = (top + bottom) / 2;
    out.push(...pieSlices(cx, cy, R, c.kind === 'doughnut' ? R * 0.55 : 0, c.series[0]?.values ?? []));
  } else {
    const cats = c.categories;
    const n = Math.max(1, cats.length);
    const isBar = c.kind === 'bar';
    const vals = c.series.flatMap((s) => s.values.filter((v) => Number.isFinite(v)));
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 5);
    const tMin = ticks[0], tMax = ticks[ticks.length - 1];
    const span = tMax - tMin || 1;
    // plot rectangle (inside the labels)
    const px0 = isBar ? b.x + b.w * 0.2 : b.x + b.w * 0.1;
    const px1 = b.x + b.w * 0.97;
    const py0 = top + b.h * 0.02;
    const py1 = bottom - b.h * 0.1;
    const pw = px1 - px0, ph = py1 - py0;
    const vx = (v: number): number => px0 + ((v - tMin) / span) * pw;
    const vy = (v: number): number => py1 - ((v - tMin) / span) * ph;
    const band = isBar ? ph / n : pw / n;
    const bandStart = (i: number): number => (isBar ? py0 : px0) + i * band;

    for (const t of ticks) {
      if (isBar) {
        out.push({ k: 'line', x1: vx(t), y1: py0, x2: vx(t), y2: py1, stroke: GRID, width: 1 * PT });
        out.push({ k: 'text', x: vx(t), y: py1 + fsTick * 1.4, text: formatTick(t), size: fsTick, anchor: 'middle', fill: INK });
      } else {
        out.push({ k: 'line', x1: px0, y1: vy(t), x2: px1, y2: vy(t), stroke: GRID, width: 1 * PT });
        out.push({ k: 'text', x: px0 - fsTick * 0.5, y: vy(t) + fsTick * 0.35, text: formatTick(t), size: fsTick, anchor: 'end', fill: INK });
      }
    }
    // category labels
    cats.forEach((name, i) => {
      if (isBar) out.push({ k: 'text', x: px0 - fsLabel * 0.5, y: bandStart(i) + band / 2 + fsLabel * 0.35, text: name, size: fsLabel, anchor: 'end', fill: INK });
      else out.push({ k: 'text', x: bandStart(i) + band / 2, y: py1 + fsLabel * 1.5, text: name, size: fsLabel, anchor: 'middle', fill: INK });
    });
    // axis at zero
    if (isBar) out.push({ k: 'line', x1: vx(0), y1: py0, x2: vx(0), y2: py1, stroke: AXIS, width: 1.5 * PT });
    else out.push({ k: 'line', x1: px0, y1: vy(0), x2: px1, y2: vy(0), stroke: AXIS, width: 1.5 * PT });

    if (c.kind === 'bar' || c.kind === 'column') {
      const s = Math.max(1, c.series.length);
      const group = band * 0.7, barW = group / s;
      c.series.forEach((ser, j) => {
        ser.values.forEach((v0, i) => {
          if (i >= n) return;
          const v = Number.isFinite(v0) ? v0 : 0;
          const fill = PALETTE[j % PALETTE.length];
          if (isBar) {
            const x = Math.min(vx(0), vx(v)), w = Math.abs(vx(v) - vx(0));
            const y = bandStart(i) + band * 0.15 + j * barW;
            if (w > 0) out.push({ k: 'rect', x, y, w, h: barW, fill });
          } else {
            const x = bandStart(i) + band * 0.15 + j * barW;
            const y = Math.min(vy(0), vy(v)), h = Math.abs(vy(v) - vy(0));
            if (h > 0) out.push({ k: 'rect', x, y, w: barW, h, fill });
          }
        });
      });
    } else {
      // line and area: points at the middle of each category band
      c.series.forEach((ser, j) => {
        const pts: P[] = [];
        ser.values.forEach((v0, i) => {
          if (i >= n) return;
          const v = Number.isFinite(v0) ? v0 : 0;
          pts.push([bandStart(i) + band / 2, vy(v)]);
        });
        if (!pts.length) return;
        const color = PALETTE[j % PALETTE.length];
        const line = pts.map((p, k) => `${k ? 'L' : 'M'}${f2(p[0])} ${f2(p[1])}`).join(' ');
        if (c.kind === 'area') {
          const last = pts[pts.length - 1], first = pts[0];
          out.push({ k: 'path', d: `${line} L${f2(last[0])} ${f2(vy(0))} L${f2(first[0])} ${f2(vy(0))} Z`, fill: color, opacity: 0.3 });
        }
        out.push({ k: 'path', d: line, fill: 'none', stroke: color, width: 2.5 * PT });
        for (const p of pts) out.push({ k: 'circle', cx: p[0], cy: p[1], r: 2 * PT, fill: color });
      });
    }
  }

  // legend along the bottom
  if (legend.length) {
    const ly = b.y + b.h - legendH / 2;
    const itemW = (e: { name: string }) => 34 + e.name.length * fsTick * 0.62 + 30;
    let x = b.x + (b.w - legend.reduce((s, e) => s + itemW(e), 0)) / 2;
    for (const e of legend) {
      out.push({ k: 'rect', x, y: ly - 9 * PT, w: 9 * PT, h: 9 * PT, fill: e.color });
      out.push({ k: 'text', x: x + 14 * PT, y: ly + fsTick * 0.35, text: e.name, size: fsTick, anchor: 'start', fill: INK });
      x += itemW(e);
    }
  }
  return out;
}
