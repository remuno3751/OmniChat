import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToSlides } from "./artifacts.js";
import { parseShapes } from "./shapes.js";

const specOf = (md: string, i: number): any => (markdownToSlides(md, "Deck")[i].blocks.find((b) => b.kind === "shapes") as any)?.spec;

test("a full-slide rectangle becomes the background, and a text box repeating the title is dropped", () => {
  const md = [
    "## 情報セキュリティ入門", "```shapes", "layout: cover", "elements:",
    '  - {type: rect, x: 0, y: 0, w: 100, h: 100, fill: "#0f172a"}',
    '  - {type: text, x: 40, y: 20, w: 60, h: 60, text: "情報セキュリティ\n入門", size: 64}', "```",
  ].join("\n");
  const s = specOf(md, 0);
  assert.equal(s.bg, "#0f172a");
  assert.ok(!s.elements.some((e: any) => e.text && /入門/.test(e.text)), "no second copy of the title");
  assert.ok(!s.elements.some((e: any) => e.w >= 98 && e.h >= 98 && e.fill === "#0f172a"));
});

test("elements are kept inside the slide", () => {
  const spec = parseShapes('elements:\n  - {type: rect, x: 20, y: 40, w: 100, h: 50, fill: "#ff0000"}\n  - {type: text, x: -5, y: 95, w: 30, h: 20, text: "a"}\n')!;
  for (const e of spec.elements as any[]) {
    assert.ok(e.x >= 0 && e.y >= 0 && e.x + e.w <= 100.0001 && e.y + e.h <= 100.0001, JSON.stringify(e));
  }
});

test("body text moves to a free column when shapes sit on it, and to the notes when there is no room", () => {
  const right = [
    "## T", "", "## S", "- one", "- two", "```shapes", "elements:",
    '  - {type: roundRect, x: 52, y: 20, w: 44, h: 60, text: "card", size: 24}', "```",
  ].join("\n");
  const s = specOf(right, 1);
  assert.equal(s.bodyBox.x, 4, "the body goes to the left column");
  const full = [
    "## T", "", "## S", "- one", "- two", "```shapes", "elements:",
    '  - {type: roundRect, x: 5, y: 15, w: 90, h: 40, text: "top", size: 24}',
    '  - {type: roundRect, x: 5, y: 50, w: 90, h: 45, text: "bottom", size: 24}', "```",
  ].join("\n");
  const f = specOf(full, 1);
  assert.equal(f.body, "none");
  assert.match(f.notes, /one/);
});

test("an AI-drawn title is dropped and content that touches the title band moves below it", () => {
  const md = [
    "## 脅威", "", "## CIA", "```shapes", "layout: cards", "elements:",
    '  - {type: text, x: 4, y: 2, w: 92, h: 8, text: "守るべき3つの柱", size: 28, bold: true}',
    '  - {type: roundRect, x: 30, y: 12, w: 40, h: 16, fill: "#1d4ed8", text: "機密性", size: 20}',
    '  - {type: roundRect, x: 4, y: 60, w: 28, h: 18, fill: "#dbeafe", text: "完全性", size: 16}', "```",
  ].join("\n");
  const s = specOf(md, 1);
  const mine = s.elements.filter((e: any) => e.text);
  assert.ok(!mine.some((e: any) => /3つの柱/.test(e.text)), "the AI's own title is gone");
  for (const e of mine) assert.ok(e.y >= 15.9, `${e.text} starts below the title band (y=${e.y})`);
  assert.ok(mine.every((e: any) => e.y + e.h <= 100.01));
});

test("a cover whose own boxes sit where the layout puts the title gets the title in the top band instead", () => {
  const md = [
    "## 表紙", "```shapes", "layout: cover", "elements:",
    '  - {type: roundRect, x: 6, y: 30, w: 42, h: 16, fill: "#1e293b", text: "ねらい", size: 16}', "```",
  ].join("\n");
  const s = specOf(md, 0);
  assert.equal(s.titleBox, undefined);
});

test("a chart without a position is placed where the other boxes leave room", () => {
  const free = [
    "## T", "", "## Numbers", "```shapes", "elements:",
    '  - {type: chart, kind: column, categories: [a, b], series: [{name: s, values: [1, 2]}]}', "```",
  ].join("\n");
  const c = specOf(free, 1).elements.find((e: any) => e.type === "chart");
  assert.ok(c, "the chart is kept");
  assert.ok(c.w >= 80 && c.y >= 15.9, `whole content area (${c.x},${c.y},${c.w},${c.h})`);
  const crowded = [
    "## T", "", "## Numbers", "```shapes", "elements:",
    '  - {type: roundRect, x: 6, y: 16, w: 88, h: 30, text: "Top banner", size: 24}',
    '  - {type: chart, kind: column, categories: [a, b], series: [{name: s, values: [1, 2]}]}', "```",
  ].join("\n");
  const d = specOf(crowded, 1).elements.find((e: any) => e.type === "chart");
  assert.ok(d.y >= 46 - 0.1, `below the banner (y=${d.y})`);
});
