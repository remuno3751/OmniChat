import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShapes, applyLayout, inkFor, arrowLabelBox, INK_DARK, INK_LIGHT } from "./shapes.js";
import { codeTokens, type CodeTok, type ShapeBox } from "./docmodel.js";
import { markdownToPptx } from "./artifacts.js";

/* Slide layouts (cover, section, cards, twoCol, quote), the ink, the accent underline, code tokens and arrow labels. */

const sig = (toks: CodeTok[]) => toks.filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`);

test("parseShapes: cover fills in the background, the title / body boxes and the decoration", () => {
  const spec = parseShapes("layout: cover\nelements: []");
  assert.ok(spec);
  assert.equal(spec.layout, "cover");
  assert.equal(spec.accent, "#3b82f6", "accent defaults when a layout is given");
  assert.equal(spec.bg, "#0f172a");
  assert.equal(spec.ink, INK_LIGHT, "dark background gives light ink");
  assert.deepEqual(spec.titleBox, { x: 8, y: 28, w: 84, h: 24, size: 44, align: "left" });
  assert.deepEqual(spec.bodyBox, { x: 8, y: 58, w: 84, h: 28 });
  const decor = spec.elements as ShapeBox[];
  assert.equal(decor.length, 2);
  assert.deepEqual([decor[0].type, decor[0].x, decor[0].y, decor[0].w, decor[0].h, decor[0].fill], ["rect", 0, 0, 2.2, 100, "#3b82f6"]);
  assert.deepEqual([decor[1].x, decor[1].y, decor[1].w, decor[1].h], [8, 54, 14, 1]);
});

test("parseShapes: decoration is prepended and does not count toward the element limit", () => {
  const boxes = Array.from({ length: 60 }, (_, i) => `  - {type: rect, id: b${i}, x: 1, y: 1, w: 5, h: 5}`).join("\n");
  const spec = parseShapes(`layout: cover\nelements:\n${boxes}`);
  assert.ok(spec);
  assert.equal(spec.elements.length, 62);
  assert.equal(spec.elements[2].type, "rect");
  assert.equal((spec.elements[2] as ShapeBox).id, "b0", "the author's elements follow the decoration");
});

test("parseShapes: section defaults the background to the accent and adds the faint circle", () => {
  const spec = parseShapes("layout: section\naccent: green\nelements: []");
  assert.ok(spec);
  assert.equal(spec.bg, "#10b981");
  assert.equal(spec.accent, "#10b981");
  assert.equal(spec.ink, INK_LIGHT, "the green is dark enough for light ink");
  assert.deepEqual(spec.titleBox, { x: 8, y: 36, w: 84, h: 28, size: 40, align: "left" });
  assert.deepEqual(spec.bodyBox, { x: 8, y: 66, w: 84, h: 20 });
  const circle = spec.elements[0] as ShapeBox;
  assert.deepEqual([circle.type, circle.x, circle.y, circle.w, circle.h, circle.fill, circle.opacity], ["ellipse", 70, -20, 50, 90, "#ffffff", 0.08]);
});

test("parseShapes: twoCol gives the body a left column and a panel on the right", () => {
  const spec = parseShapes("layout: twoCol\nelements: []");
  assert.ok(spec);
  assert.deepEqual(spec.bodyBox, { x: 4, y: 18, w: 44, h: 72 });
  assert.equal(spec.bg, undefined, "no background default for twoCol");
  assert.equal(spec.ink, INK_DARK);
  const types = spec.elements.map((e) => e.type);
  assert.deepEqual(types, ["rect", "roundRect"]);
  assert.equal((spec.elements[1] as ShapeBox).x, 52);
});

test("parseShapes: cards has no boxes and quote adds the big quote mark", () => {
  const cards = parseShapes("layout: cards\nelements: []");
  assert.ok(cards);
  assert.equal(cards.titleBox, undefined);
  assert.equal(cards.bodyBox, undefined);
  assert.equal(cards.elements.length, 1, "only the underline");

  const quote = parseShapes("layout: quote\nelements: []");
  assert.ok(quote);
  assert.deepEqual(quote.bodyBox, { x: 12, y: 30, w: 80, h: 50 });
  const mark = quote.elements[0] as ShapeBox;
  assert.deepEqual([mark.type, mark.text, mark.size, mark.bold, mark.color], ["text", "“", 120, true, "#3b82f6"]);
});

test("parseShapes: accent alone draws only the underline; neither gives no decoration", () => {
  const under = parseShapes("accent: red\nelements: []");
  assert.ok(under);
  assert.equal(under.layout, undefined);
  assert.equal(under.elements.length, 1);
  assert.deepEqual([under.elements[0].type, (under.elements[0] as ShapeBox).fill], ["rect", "#ef4444"]);

  const plain = parseShapes("elements: []");
  assert.ok(plain);
  assert.equal(plain.accent, undefined);
  assert.equal(plain.elements.length, 0);
  assert.equal(plain.ink, INK_DARK);
});

test("inkFor: dark backgrounds get light ink, light ones dark ink", () => {
  assert.equal(inkFor("#000000"), INK_LIGHT);
  assert.equal(inkFor("#0f172a"), INK_LIGHT);
  assert.equal(inkFor("#ffffff"), INK_DARK);
  assert.equal(inkFor("#fef3c7"), INK_DARK);
  assert.equal(inkFor("not a color"), INK_DARK);
});

test("parseShapes: an explicit dark bg flips the ink, and applyLayout keeps an author bg on cover", () => {
  const spec = parseShapes('bg: "#111"\nelements: []');
  assert.ok(spec);
  assert.equal(spec.ink, INK_LIGHT);
  const cover = parseShapes('layout: cover\nbg: "#ffffff"\nelements: []');
  assert.ok(cover);
  assert.equal(cover.bg, "#ffffff");
  assert.equal(cover.ink, INK_DARK);
  // applyLayout is exported and usable on its own: a quote spec gets its two decoration elements
  assert.equal(applyLayout({ body: "top", layout: "quote", accent: "#000000", elements: [] }).elements.length, 2);
});

test("codeTokens: the tokens concatenate back to the input", () => {
  const lines = [
    'const x = "a\\"b" // done',
    "def f(n): return 0x1F + 3.5e2  # note",
    "SELECT name FROM t WHERE id = 'x' -- trailing",
    "int main() { /* block */ return 1_000; }",
    "echo `tpl ${a}` . 'unclosed",
    "a#b and  \tTabあ",
    "",
  ];
  for (const line of lines) assert.equal(codeTokens(line).map((t) => t.text).join(""), line);
});

test("codeTokens: kinds for keywords, strings, numbers and comments", () => {
  assert.deepEqual(sig(codeTokens('const x = "a\\"b" // done')), ["keyword:const", 'string:"a\\"b"', "comment:// done"]);
  assert.deepEqual(sig(codeTokens("def f(n): return 0x1F + 3.5e2  # note")), ["keyword:def", "keyword:return", "number:0x1F", "number:3.5e2", "comment:# note"]);
  assert.deepEqual(sig(codeTokens("SELECT name FROM t WHERE id = 'x' -- trailing")), ["keyword:SELECT", "keyword:FROM", "keyword:WHERE", "string:'x'", "comment:-- trailing"]);
  assert.deepEqual(sig(codeTokens("int main() { /* block */ return 1_000; }")), ["keyword:int", "comment:/* block */", "keyword:return", "number:1_000"]);
  assert.deepEqual(sig(codeTokens("echo `tpl` . 'unclosed")), ["keyword:echo", "string:`tpl`", "string:'unclosed"]);
});

test("codeTokens: # and -- inside a word are not comments; numbers inside identifiers are not numbers", () => {
  assert.deepEqual(sig(codeTokens("a#b")), []);
  assert.deepEqual(sig(codeTokens("var1 + x2")), [], "var1 is an identifier, not the keyword var, and 1 is not a number");
  assert.deepEqual(sig(codeTokens("let v = a--b")), ["keyword:let"]);
  assert.deepEqual(sig(codeTokens("")), []);
});

test("arrowLabelBox: above a mostly horizontal segment, right of a vertical one, inside the slide", () => {
  const h = arrowLabelBox({ x1: 10, y1: 50, x2: 60, y2: 50 }, "HTTPS", 12);
  assert.ok(h.y + h.h <= 50, "the label sits above the line");
  assert.ok(Math.abs(h.x + h.w / 2 - 35) < 0.01, "centered on the segment");

  const v = arrowLabelBox({ x1: 50, y1: 10, x2: 50, y2: 60 }, "DB", 12);
  assert.ok(v.x >= 50, "the label is to the right of the line");
  assert.ok(v.y < 60 && v.y + v.h > 10, "beside the segment");

  const edge = arrowLabelBox({ x1: 98, y1: 1, x2: 99, y2: 1 }, "A very long label here", 12);
  assert.ok(edge.x >= 0 && edge.x + edge.w <= 100, "clamped inside the slide horizontally");
  assert.ok(edge.y >= 0 && edge.y + edge.h <= 100, "clamped inside the slide vertically");

  const cjk = arrowLabelBox({ x1: 0, y1: 50, x2: 50, y2: 50 }, "あいう", 12);
  const latin = arrowLabelBox({ x1: 0, y1: 50, x2: 50, y2: 50 }, "abc", 12);
  assert.ok(cjk.w > latin.w, "CJK characters take more width");
});

test("markdownToPptx: a cover slide, a card, code and an arrow label produce a zip", async () => {
  const md = [
    "# Cover",
    "",
    "```shapes",
    "layout: cover",
    "accent: \"#10b981\"",
    "```",
    "",
    "## Structure",
    "",
    "- item one",
    "",
    "```shapes",
    "layout: twoCol",
    "elements:",
    "  - {type: roundRect, id: a, x: 54, y: 30, w: 15, h: 10, text: \"App\"}",
    "  - {type: roundRect, id: b, x: 75, y: 30, w: 15, h: 10, text: \"DB\"}",
    "  - {type: arrow, from: a, to: b, label: \"HTTPS\"}",
    "```",
    "",
    "```ts",
    "const x: number = 42 // answer",
    "```",
    "",
    "## Plain",
    "",
    "- only bullets",
  ].join("\n");
  const buf = await markdownToPptx(md, "deck");
  assert.ok(buf.length > 1000);
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK", "a zip (pptx) file");
});

test("markdownToPptx: a blank artifact still gives a valid pptx", async () => {
  const buf = await markdownToPptx("", "empty");
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
});
