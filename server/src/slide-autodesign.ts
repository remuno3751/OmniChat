import type { Block, Shape, ShapeBox, ShapesSpec, Slide, SlideLayout } from "./docmodel.js";
import { DEFAULT_ACCENT, finishSpec } from "./shapes.js";

/* Slides the AI wrote as plain text (no ```shapes block) get a design here, so a deck is never a stack of bare bullet lists:
 * a cover, section dividers, quotes, cards for a few short points, and an accent bar / light background for the rest.
 * Slides that carry a valid shapes block are left alone (the author designed them). */

/** A bullet this short (characters) can sit on a card. */
const CARD_TEXT_MAX = 40;
const CARDS_MIN = 2;
const CARDS_MAX = 4;
const QUOTE_MAX = 160;
const PAGE_BG = "#f8fafc";

const hasSpec = (s: Slide): boolean => s.blocks.some((b) => b.kind === "shapes" && !!b.spec);
const plain = (t: string): string => t.replace(/\*\*|__|`/g, "");

/** The deck's accent: the first one an author gave on any slide, else the default. */
function deckAccent(slides: Slide[]): string {
  for (const s of slides) for (const b of s.blocks) if (b.kind === "shapes" && b.spec?.accent) return b.spec.accent;
  return DEFAULT_ACCENT;
}

/** Cards in a row for 2-4 short points: a numbered badge on top, the text in a white card. */
function cardShapes(texts: string[], accent: string): Shape[] {
  const n = texts.length;
  const gap = 3;
  const w = (88 - gap * (n - 1)) / n;
  const out: Shape[] = [];
  texts.forEach((text, i) => {
    const x = 6 + i * (w + gap);
    out.push({ type: "roundRect", x, y: 30, w, h: 50, fill: "#ffffff", line: accent, lineWidth: 1.5, text: plain(text), size: 22, color: "#1f2937", align: "center", valign: "middle" });
    out.push({ type: "ellipse", x: x + w / 2 - 4, y: 24, w: 8, h: 12, fill: accent, text: String(i + 1), size: 20, bold: true, color: "#ffffff", align: "center", valign: "middle" });
  });
  return out;
}

/** The side bar and footer line every content slide shares. */
function frame(accent: string): ShapeBox[] {
  return [
    { type: "rect", x: 0, y: 0, w: 1.2, h: 100, fill: accent },
    { type: "rect", x: 6, y: 96, w: 88, h: 0.25, fill: accent, opacity: 0.35 },
  ];
}

function designOne(sl: Slide, index: number, accent: string, flip: boolean): { blocks: Block[]; spec: ShapesSpec } {
  const bullets = sl.blocks.filter((b): b is Extract<Block, { kind: "bullet" }> => b.kind === "bullet");
  const others = sl.blocks.filter((b) => b.kind !== "bullet");
  const paras = sl.blocks.filter((b): b is Extract<Block, { kind: "para" }> => b.kind === "para");
  const heavy = sl.blocks.some((b) => b.kind === "table" || b.kind === "code" || b.kind === "ordered");
  const base = (layout: SlideLayout | undefined, extra: Partial<ShapesSpec> = {}): ShapesSpec =>
    finishSpec({ body: "top", elements: [], accent, ...(layout ? { layout } : {}), ...extra });

  if (index === 0 && !heavy && bullets.length + paras.length <= 3) return { blocks: sl.blocks, spec: base("cover") };
  if (!heavy && sl.blocks.length === 0) return { blocks: sl.blocks, spec: base("section") };
  if (!heavy && !bullets.length && paras.length === 1 && plain(paras[0].text).length <= QUOTE_MAX) return { blocks: sl.blocks, spec: base("quote") };
  if (!heavy && bullets.length >= CARDS_MIN && bullets.length <= CARDS_MAX && bullets.every((b) => b.level === 0 && plain(b.text).length <= CARD_TEXT_MAX)) {
    // the bullets moved onto the cards; the rest of the text (if any) stays as the body
    return { blocks: others, spec: base("cards", { bg: PAGE_BG, body: "none", elements: [...frame(accent), ...cardShapes(bullets.map((b) => b.text), accent)] }) };
  }
  // Longer text: a left column with the accent panel on the right on every other slide, else the plain frame.
  if (!heavy && flip && bullets.length >= 2) {
    const no = String(index + 1).padStart(2, "0");
    const numeral: ShapeBox = { type: "text", x: 52, y: 18, w: 44, h: 72, text: no, size: 110, bold: true, color: accent, align: "center", valign: "middle" };
    return { blocks: sl.blocks, spec: base("twoCol", { bg: PAGE_BG, elements: [...frame(accent), numeral] }) };
  }
  return { blocks: sl.blocks, spec: base(undefined, { bg: PAGE_BG, elements: frame(accent) }) };
}

/** Adds a designed ```shapes block (spec only) to every slide that has none. */
export function autoDesign(slides: Slide[]): Slide[] {
  const accent = deckAccent(slides);
  let flip = false;
  return slides.map((sl, i) => {
    if (hasSpec(sl)) return sl;
    const { blocks, spec } = designOne(sl, i, accent, flip);
    flip = !flip;
    return { title: sl.title, blocks: [...blocks, { kind: "shapes", raw: "", spec }] };
  });
}
