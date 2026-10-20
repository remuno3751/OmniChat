import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { startServer, api, type TestServer } from "./test-server.js";
import { markdownToPptx, markdownToDocx } from "./artifacts.js";

/* Slide shapes: pptx / docx output and POST /artifacts/convert/preview (docs/design/SLIDE-SHAPES.md). */

const SHAPES_MD = [
  "## システム構成",
  "",
  "- 利用者はアプリを使います",
  "",
  "```shapes",
  "bg: \"#f8fafc\"",
  "body: top",
  "notes: 説明メモ",
  "elements:",
  "  - {type: roundRect, id: app, x: 5, y: 40, w: 25, h: 22, fill: \"#3b82f6\", color: \"#ffffff\", text: \"アプリ\"}",
  "  - {type: cylinder, id: db, x: 72, y: 38, w: 22, h: 26, fill: \"#f59e0b\", text: \"DB\"}",
  "  - {type: arrow, from: app, to: db, label: \"HTTPS\"}",
  "  - {type: chart, kind: column, title: \"売上\", categories: [1月, 2月], series: [{name: \"A\", values: [3, 4]}, {name: \"B\", values: [1, 2]}], x: 10, y: 65, w: 40, h: 30}",
  "```",
  "",
  "## 本文だけ",
  "",
  "- 箇条書き",
].join("\n");

const zipOf = async (buf: Buffer) => JSZip.loadAsync(buf);
const readEntry = async (zip: JSZip, name: string) => {
  const f = zip.file(name);
  assert.ok(f, `${name} exists`);
  return f.async("string");
};

test("markdownToPptx draws the shapes, the arrow, the chart and the notes", async () => {
  const zip = await zipOf(await markdownToPptx(SHAPES_MD, "Deck"));
  const slide1 = await readEntry(zip, "ppt/slides/slide1.xml");
  assert.match(slide1, /<p:sp>/);
  assert.match(slide1, /prstGeom prst="roundRect"/);
  assert.match(slide1, /prstGeom prst="can"/, "cylinder maps to can");
  assert.match(slide1, /prstGeom prst="line"/);
  assert.match(slide1, /<a:tailEnd type="triangle"/, "arrow head on the end side");
  assert.match(slide1, /<p:bg>/, "background");
  assert.match(slide1, /<a:t>HTTPS<\/a:t>/, "arrow label");
  assert.match(slide1, /<a:t>アプリ<\/a:t>/);
  const charts = zip.file(/^ppt\/charts\/chart\d+\.xml$/).map((f) => f.name);
  assert.ok(charts.length >= 1, "a chart part exists");
  assert.match(await readEntry(zip, charts[0]), /<c:barChart>/);
  const notes = zip.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/).map((f) => f.name);
  assert.ok(notes.length >= 1, "a notes part exists");
  assert.match(await readEntry(zip, notes[0]), /説明メモ/);
});

test("markdownToPptx keeps the body position of a slide without shapes", async () => {
  const zip = await zipOf(await markdownToPptx(SHAPES_MD, "Deck"));
  const slide2 = await readEntry(zip, "ppt/slides/slide2.xml");
  assert.doesNotMatch(slide2, /prstGeom prst="roundRect"/);
  // body text box at x 0.6 in, y 1.5 in, the same as before shapes existed
  assert.match(slide2, /<a:off x="548640" y="1371600"\/>/);
  assert.match(slide2, /<a:ext cx="11064240"/, "12.1 in wide");
});

test("markdownToPptx without shapes still produces the old layout", async () => {
  const zip = await zipOf(await markdownToPptx("## One\n- a\n", "Deck"));
  const s1 = await readEntry(zip, "ppt/slides/slide1.xml");
  assert.equal((s1.match(/<p:sp>/g) ?? []).length, 2, "title and body only");
  assert.match(s1, /<a:off x="548640" y="1371600"\/>/);
});

test("markdownToPptx falls back to code for a shapes block that does not parse", async () => {
  const zip = await zipOf(await markdownToPptx("## Bad\n\n```shapes\nelements: [\n```\n", "Deck"));
  const s1 = await readEntry(zip, "ppt/slides/slide1.xml");
  assert.match(s1, /elements: \[/, "the raw YAML is shown as text");
  assert.equal((s1.match(/<p:sp>/g) ?? []).length, 2, "title and body only, no extra shapes");
});

test("markdownToDocx puts a (図) stand-in with the element texts", async () => {
  const buf = await markdownToDocx(SHAPES_MD, "Doc");
  const xml = await readEntry(await zipOf(buf), "word/document.xml");
  assert.match(xml, />\(図\)</);
  assert.match(xml, />アプリ</);
  assert.match(xml, />HTTPS</);
  assert.match(xml, /グラフ: 売上/);
  assert.doesNotMatch(xml, /elements:/, "the YAML itself is not shown");
});

/* ---- HTTP: POST /artifacts/convert/preview ---- */

let srv: TestServer;
let token = "";
before(async () => {
  srv = await startServer();
  token = (await api(srv.base, "POST", "/auth/register", { username: "shapes", password: "password123" })).json.token as string;
});
after(() => { srv?.stop(); });

const preview = (body: unknown, tok: string | null = token) => fetch(`${srv.base}/artifacts/convert/preview`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
  body: JSON.stringify(body),
});

test("POST /artifacts/convert/preview returns slides with the parsed shapes spec", async () => {
  const r = await preview({ type: "pptx", title: "Deck", markdown: SHAPES_MD });
  assert.equal(r.status, 200);
  const j = (await r.json()) as { slides: { title: string; blocks: any[] }[] };
  assert.equal(j.slides.length, 2);
  assert.equal(j.slides[0].title, "システム構成");
  const sh = j.slides[0].blocks.find((b) => b.kind === "shapes");
  assert.ok(sh, "shapes block");
  assert.equal(sh.spec.bg, "#f8fafc");
  assert.equal(sh.spec.notes, "説明メモ");
  assert.deepEqual(sh.spec.elements.map((e: any) => e.type), ["roundRect", "cylinder", "arrow", "chart"]);
  assert.equal(sh.spec.elements[3].kind, "column");
});

test("POST /artifacts/convert/preview: a broken shapes block comes back as code with no spec", async () => {
  const r = await preview({ type: "pptx", markdown: "## A\n\n```shapes\nelements: [\n```\n" });
  const j = (await r.json()) as { slides: { blocks: any[] }[] };
  const b = j.slides[0].blocks[0];
  assert.equal(b.kind, "code");
});

test("POST /artifacts/convert/preview without auth is 401, and bad input is 400 or 413", async () => {
  assert.equal((await preview({ type: "pptx", markdown: "## A" }, null)).status, 401);
  const bad = await preview({ type: "csv", markdown: "x" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /type must be docx, pptx or xlsx/);
  assert.equal((await preview({ type: "pptx", markdown: 5 })).status, 400);
  const big = await preview({ type: "pptx", markdown: "x".repeat(1_000_001) });
  assert.equal(big.status, 413);
});
