import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToSlides } from "./artifacts.js";

const spec = (md: string, i: number) => (markdownToSlides(md, "Deck")[i].blocks.find((b) => b.kind === "shapes") as any)?.spec;

test("autoDesign: the first slide becomes a cover, an empty slide a section, a lone short paragraph a quote", () => {
  const md = "## Title\nsub\n\n## Chapter\n\n## Message\n\nSimple is best.\n";
  assert.equal(spec(md, 0).layout, "cover");
  assert.equal(spec(md, 1).layout, "section");
  assert.equal(spec(md, 2).layout, "quote");
});

test("autoDesign: 2-4 short bullets become cards and leave the body", () => {
  const slides = markdownToSlides("## Cover\n\n## Points\n- one\n- two\n- three\n", "Deck");
  const s = slides[1];
  assert.equal(s.blocks.filter((b) => b.kind === "bullet").length, 0);
  const sp = (s.blocks.find((b) => b.kind === "shapes") as any).spec;
  assert.equal(sp.layout, "cards");
  assert.equal(sp.body, "none");
  assert.equal(sp.elements.filter((e: any) => e.type === "roundRect").length, 3);
});

test("autoDesign: long bullet lists keep their text and get the frame; a slide with its own shapes is untouched", () => {
  const many = "## A\n\n## B\n" + Array.from({ length: 6 }, (_, i) => `- point number ${i} with some more words`).join("\n") + "\n";
  const sp = spec(many, 1);
  assert.equal(sp.bg, "#f8fafc");
  assert.equal(markdownToSlides(many, "Deck")[1].blocks.filter((b) => b.kind === "bullet").length, 6);
  const own = markdownToSlides("## A\n\n## B\n- x\n\n```shapes\nbg: \"#112233\"\nelements: []\n```\n", "Deck")[1];
  assert.equal(own.blocks.filter((b) => b.kind === "shapes").length, 1);
  assert.equal((own.blocks.find((b) => b.kind === "shapes") as any).spec.bg, "#112233");
});
