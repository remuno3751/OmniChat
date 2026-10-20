import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShapes, attachShapes, arrowSegment, SHAPES_LIMITS } from "./shapes.js";
import { parseMarkdown, toSlides, type ShapeBox, type ShapeArrow } from "./docmodel.js";

/* Slide shapes: YAML of a ```shapes block -> validated ShapesSpec (docs/design/SLIDE-SHAPES.md). */

const SAMPLE = `
body: top
bg: "#fff"
notes: 発表メモ
elements:
  - {type: roundRect, id: app, x: 5, y: 40, w: 25, h: 22, fill: "#3b82f6", color: "#ffffff", text: "アプリ"}
  - {type: cylinder, id: db, x: 72, y: 38, w: 22, h: 26, fill: blue, text: "DB"}
  - {type: arrow, from: app, to: db, label: "HTTPS"}
  - {type: line, x1: 0, y1: 0, x2: 50, y2: 50, dash: dot, head: both}
  - {type: text, x: 5, y: 80, w: 90, h: 10, text: "保存", size: 14, align: center}
  - {type: chart, kind: bar, title: "売上", categories: [1月, 2月], series: [{name: "A", values: [3, 4]}, {name: "B", values: [1, "x"]}], x: 10, y: 10, w: 40, h: 30}
  - {type: image, src: "attachment:1", x: 1, y: 1, w: 1, h: 1}
  - {type: nonsense, x: 1, y: 1, w: 1, h: 1}
`;

test("parseShapes: a normal block gives the spec with each element kind", () => {
  const spec = parseShapes(SAMPLE);
  assert.ok(spec);
  assert.equal(spec.body, "top");
  assert.equal(spec.bg, "#ffffff");
  assert.equal(spec.notes, "発表メモ");
  assert.deepEqual(spec.elements.map((e) => e.type), ["roundRect", "cylinder", "arrow", "line", "text", "chart"]);
  const [app, db, arrow, line, , chart] = spec.elements as [ShapeBox, ShapeBox, ShapeArrow, any, ShapeBox, any];
  assert.equal(app.fill, "#3b82f6");
  assert.equal(db.fill, "#3b82f6", "names map to hex");
  assert.deepEqual([arrow.from, arrow.to, arrow.label], ["app", "db", "HTTPS"]);
  assert.equal(line.head, "both");
  assert.equal(chart.kind, "bar");
  assert.deepEqual(chart.series, [{ name: "A", values: [3, 4] }, { name: "B", values: [1, 0] }], "non-numbers become 0");
});

test("parseShapes: limits clamp coordinates and cut elements to 60 and charts to 4", () => {
  const boxes = Array.from({ length: 61 }, (_, i) => `  - {type: rect, id: b${i}, x: 150, y: -5, w: 10, h: 10}`).join("\n");
  const spec = parseShapes(`elements:\n${boxes}\n`);
  assert.ok(spec);
  assert.equal(spec.elements.length, SHAPES_LIMITS.elements);
  const first = spec.elements[0] as ShapeBox;
  assert.equal(first.x, 100);
  assert.equal(first.y, 0);
  const chart = `  - {type: chart, kind: pie, categories: [a], series: [{name: s, values: [1]}], x: 1, y: 1, w: 10, h: 10}`;
  const charts = parseShapes(`elements:\n${Array.from({ length: 6 }, () => chart).join("\n")}\n`);
  assert.equal(charts!.elements.length, 4);
});

test("parseShapes: categories and series are cut to 50 and 8", () => {
  const cats = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const series = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, values: cats.map(() => 1) }));
  const spec = parseShapes(`elements:\n  - {type: chart, kind: line, categories: ${JSON.stringify(cats)}, series: ${JSON.stringify(series)}, x: 0, y: 0, w: 50, h: 50}\n`);
  const c = spec!.elements[0] as any;
  assert.equal(c.categories.length, 50);
  assert.equal(c.series.length, 8);
  assert.equal(c.series[0].values.length, 50);
});

test("parseShapes: long text is cut to 500 characters", () => {
  const spec = parseShapes(`elements:\n  - {type: text, x: 0, y: 0, w: 10, h: 10, text: "${"あ".repeat(600)}"}\n`);
  assert.equal((spec!.elements[0] as ShapeBox).text!.length, 500);
});

test("parseShapes: broken YAML, a non-object, an oversized block and an alias bomb give null", () => {
  assert.equal(parseShapes("elements: [unclosed"), null, "broken YAML");
  assert.equal(parseShapes("- a\n- b\n"), null, "array");
  assert.equal(parseShapes("just text"), null, "plain string");
  assert.equal(parseShapes("elements: 3"), null, "elements not an array");
  assert.equal(parseShapes(`notes: "${"x".repeat(SHAPES_LIMITS.rawBytes)}"\nelements: []\n`), null, "too big");
  const aliases = ["a: &a [1, 2, 3]", ...Array.from({ length: 25 }, (_, i) => `k${i}: *a`)].join("\n");
  assert.equal(parseShapes(`elements: []\n${aliases}\n`), null, "alias bomb");
});

test("parseShapes: bad colors and unknown keys are dropped, not the element", () => {
  const spec = parseShapes(`
bg: "url(http://x)"
elements:
  - {type: rect, x: 1, y: 1, w: 5, h: 5, fill: "red; drop", line: "url(...)", color: "javascript:alert(1)", onclick: 1}
  - {type: rect, x: 1, y: 1, w: 5, h: 5, fill: "none", line: "#abc"}
`);
  assert.ok(spec);
  assert.equal(spec.bg, undefined);
  const [a, b] = spec.elements as ShapeBox[];
  assert.deepEqual(a, { type: "rect", x: 1, y: 1, w: 5, h: 5 });
  assert.deepEqual(b, { type: "rect", x: 1, y: 1, w: 5, h: 5, fill: "none", line: "#aabbcc" });
});

test("parseShapes: an arrow to a missing id is dropped and the rest is kept", () => {
  const spec = parseShapes(`elements:
  - {type: rect, id: a, x: 0, y: 0, w: 10, h: 10}
  - {type: arrow, from: a, to: ghost}
  - {type: arrow, x1: 0, y1: 0, x2: 9, y2: 9}
`);
  assert.equal(spec!.elements.length, 2);
});

test("arrowSegment joins the facing sides of two boxes", () => {
  const spec = parseShapes(`elements:
  - {type: rect, id: a, x: 10, y: 40, w: 20, h: 20}
  - {type: rect, id: b, x: 60, y: 40, w: 20, h: 20}
  - {type: arrow, from: a, to: b}
`)!;
  const boxes = new Map<string, ShapeBox>();
  for (const e of spec.elements) if (e.type === "rect") boxes.set(e.id!, e);
  assert.deepEqual(arrowSegment(spec.elements[2] as ShapeArrow, boxes), { x1: 30, y1: 50, x2: 60, y2: 50 });
});

test("parseMarkdown keeps a shapes fence as a shapes block; without spec it falls back to code", () => {
  const md = "## 図\n\n- 本文\n\n```shapes\nelements: []\n```\n\n```js\nlet x = 1;\n```\n";
  const blocks = parseMarkdown(md);
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "bullet", "shapes", "code"]);
  const raw = blocks[2] as { raw: string };
  assert.equal(raw.raw, "elements: []");
  const slides = toSlides(blocks, "t");
  assert.equal(slides[0].blocks[1].kind, "code", "no spec: code fallback");
  const slidesOk = toSlides(attachShapes(blocks), "t");
  assert.equal(slidesOk[0].blocks[1].kind, "shapes", "with spec: stays a shapes block");
});

test("attachShapes leaves a broken block without spec", () => {
  const [b] = attachShapes(parseMarkdown("```shapes\nelements: [\n```\n"));
  assert.equal(b.kind, "shapes");
  assert.equal((b as any).spec, undefined);
});
