import type { Block, Shape, ShapeBox, ShapesSpec, Slide, SlideBox } from "./docmodel.js";
import { applyLayout } from "./shapes.js";

/* Repairs for slides whose ```shapes block the AI wrote itself: the AI often repeats the slide title as a text box
 * and places shapes on top of the body text. The title text is dropped, and the body moves to free space. */

const norm = (t: string): string => t.replace(/\s+/g, "").replace(/\*\*|__|`/g, "").toLowerCase();
const hasText = (e: Shape): e is ShapeBox => e.type !== "line" && e.type !== "arrow" && e.type !== "chart" && !!e.text;
/** The body text's default boxes in percent (same as the previews use). */
const BODY_BOX = { top: { x: 4, y: 16, w: 92, h: 22 }, left: { x: 4, y: 16, w: 41, h: 78 }, right: { x: 55, y: 16, w: 41, h: 78 } } as const;
const COL_L: SlideBox = { x: 4, y: 18, w: 42, h: 72 };
const COL_R: SlideBox = { x: 54, y: 18, w: 42, h: 72 };
const BAND_T: SlideBox = { x: 4, y: 16, w: 92, h: 30 };
const BAND_B: SlideBox = { x: 4, y: 52, w: 92, h: 40 };

const overlap = (a: SlideBox, b: SlideBox): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
const free = (r: SlideBox, boxes: SlideBox[]): boolean => boxes.every((b) => overlap(r, b) < 0.05 * Math.min(r.w * r.h, b.w * b.h));

/** Boxes of the content the AI placed: text boxes and charts (thin bars and tinted panels are decoration). */
const contentBoxes = (spec: ShapesSpec): SlideBox[] =>
  spec.elements.filter((e): e is ShapeBox | Extract<Shape, { type: "chart" }> => e.type === "chart" || hasText(e)).map((e) => ({ x: e.x, y: e.y, w: e.w, h: e.h }));

/** The title band the slide's own title is drawn in (percent), when no layout moved it. */
const TITLE_BAND: SlideBox = { x: 4, y: 0, w: 92, h: 15 };
const TOP = 16;

/** A text box the AI used as its own slide title: big or bold, wide, near the top. */
const titleLike = (e: Shape): boolean => hasText(e) && e.type === "text" && !e.fill && e.y < 18 && e.w >= 50 && ((e.size ?? 18) >= 24 || !!e.bold) && !String(e.text).includes(String.fromCharCode(10));

/** Moves a drawn element down by the shared remap y' = TOP + y * k (lines and arrows by coordinates too). */
function remapY(e: Shape, k: number): Shape {
  const f = (y: number) => TOP + y * k;
  if (e.type === "line") return { ...e, y1: f(e.y1), y2: f(e.y2) };
  if (e.type === "arrow") return e.y1 === undefined || e.y2 === undefined ? e : { ...e, y1: f(e.y1), y2: f(e.y2) };
  return { ...e, y: f(e.y), h: e.h * k };
}

function fixSpec(sl: Slide, spec: ShapesSpec): ShapesSpec {
  const title = norm(sl.title);
  // layout decoration comes first in elements; the rest is what the AI placed
  const decorN = spec.layout || spec.accent !== undefined ? applyLayout({ body: spec.body, elements: [], layout: spec.layout, accent: spec.accent }).elements.length : 0;
  const decor = spec.elements.slice(0, decorN);
  let mine = spec.elements.slice(decorN).filter((e) => !(hasText(e) && title.length > 0 && norm(e.text!) === title) && !titleLike(e));
  let titleBox = spec.titleBox;
  const hits = (r: SlideBox) => mine.some((e) => (e.type === "chart" || hasText(e)) && overlap(r, e) > 0.05 * Math.min(r.w * r.h, e.w * e.h));
  // the layout's own title place (cover, section, quote) is dropped when the AI's boxes sit there
  if (titleBox && hits(titleBox)) titleBox = undefined;
  if (!titleBox && mine.some((e) => e.type !== "line" && e.type !== "arrow" && e.y < TITLE_BAND.h - 1)) {
    mine = mine.map((e) => remapY(e, (100 - TOP - 2) / 100));
  }
  let out: ShapesSpec = { ...spec, elements: [...decor, ...mine], titleBox };
  const bodyBlocks = sl.blocks.filter((b: Block) => b.kind === "bullet" || b.kind === "ordered" || b.kind === "para" || b.kind === "table");
  if (!bodyBlocks.length || out.body === "none" || (mine.length === 0 && (out.layout === "cover" || out.layout === "section" || out.layout === "quote"))) return out;
  const region: SlideBox = out.bodyBox ?? BODY_BOX[out.body];
  const content = contentBoxes(out);
  if (free(region, content)) return out;
  // the author's shapes sit on the body: look for a free column or band, trying the roomier side first
  const candidates = [COL_L, COL_R, BAND_T, BAND_B];
  const pick = candidates.find((c) => free(c, content));
  if (pick) return { ...out, bodyBox: pick };
  // nowhere to go: the text stays reachable as speaker notes instead of printing over the shapes
  const text = bodyBlocks.map((b) => (b.kind === "table" ? b.rows.map((r) => r.join(" | ")).join("\n") : "text" in b ? b.text : "")).join("\n");
  return { ...out, body: "none", bodyBox: undefined, notes: [out.notes, text].filter(Boolean).join("\n") };
}

/** Applies the repairs to every slide that carries a parsed shapes block (the first one with a layout, or the first). */
export function fixSlides(slides: Slide[]): Slide[] {
  return slides.map((sl) => {
    const i = sl.blocks.findIndex((b) => b.kind === "shapes" && !!b.spec);
    if (i < 0) return sl;
    const blk = sl.blocks[i] as Extract<Block, { kind: "shapes" }>;
    const blocks = sl.blocks.slice();
    blocks[i] = { ...blk, spec: fixSpec(sl, blk.spec!) };
    return { ...sl, blocks };
  });
}
