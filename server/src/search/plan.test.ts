import test from "node:test";
import assert from "node:assert/strict";
import { planSearch, filterRelevant, queryTerms, rawQuery } from "./plan.js";

const ok = (reply: string) => async () => reply;
const boom = async () => { throw new Error("down"); };

test("planSearch: JSON reply gives the model's query", async () => {
  const r = await planSearch(ok('{"search": true, "query": "Qwen3.6-35B-A3B llama.cpp MTP"}'), [], "Qwen3.6-35B-A3B って llama.cpp で動く？", true);
  assert.deepEqual(r, { search: true, query: "Qwen3.6-35B-A3B llama.cpp MTP", source: "model" });
});

test("planSearch: JSON wrapped in prose and a code fence still parses", async () => {
  const r = await planSearch(ok('Sure!\n```json\n{"search": true, "query": "「RTX 5090 価格」"}\n```'), [], "5090の値段", true);
  assert.equal(r.query, "RTX 5090 価格");
});

test("planSearch: decide mode can say no search; forced mode cannot", async () => {
  assert.deepEqual(await planSearch(ok('{"search": false, "query": ""}'), [], "ありがとう", true), { search: false, query: "", source: "model" });
  const f = await planSearch(ok('{"search": false, "query": "thanks"}'), [], "ありがとう", false);
  assert.equal(f.search, true);
  assert.equal(f.query, "thanks");
});

test("planSearch: failure or empty reply falls back to the user's words (and the keyword heuristic when deciding)", async () => {
  const a = await planSearch(boom, [], "今日の日経平均は？", true);
  assert.deepEqual(a, { search: true, query: "今日の日経平均は？", source: "fallback" });
  const b = await planSearch(boom, [], "ありがとう", true);
  assert.equal(b.search, false);
  const c = await planSearch(ok("{}"), [], "最新のRTXの価格", false);
  assert.equal(c.source, "fallback");
  const d = await planSearch(null, [], "x".repeat(500), false);
  assert.equal(d.query.length, 200);
});

test("planSearch: a bare one-line reply is used as the query", async () => {
  const r = await planSearch(ok("検索: llama.cpp MTP 対応モデル\n"), [], "llama.cppのMTPって？", true);
  assert.deepEqual(r, { search: true, query: "llama.cpp MTP 対応モデル", source: "model" });
});

test("planSearch: the prompt carries the recent conversation", async () => {
  let seen = "";
  await planSearch(async (_s, u) => { seen = u; return '{"search":true,"query":"q"}'; }, [{ role: "user", content: "Qwen3.6について" }, { role: "assistant", content: "はい" }], "それの量子化は？", true);
  assert.match(seen, /Qwen3\.6/);
  assert.match(seen, /それの量子化は/);
});

test("queryTerms: keeps compound model names whole and splits CJK into pairs", () => {
  const t = queryTerms("Qwen3.6-35B-A3B 量子化 how to");
  assert.ok(t.includes("qwen3.6-35b-a3b"));
  assert.ok(t.includes("量子") && t.includes("子化"));
  assert.ok(!t.includes("how") && !t.includes("to"));
});

test("filterRelevant: drops results that share nothing with the query", () => {
  const rs = [
    { title: "Qwen3.6-35B-A3B-MTP-IQ4_KS-GGUF", url: "https://huggingface.co/x/y" },
    { title: "Wordで書いたものをmanabaで提出したい", url: "https://detail.chiebukuro.yahoo.co.jp/qa/1" },
    { title: "Release notes", url: "https://github.com/ggml-org/llama.cpp/releases", snippet: "llama.cpp b1234 adds MTP support" },
    { title: "圧縮フォルダー（.zip）のパスワードの解除方法", url: "https://detail.chiebukuro.yahoo.co.jp/qa/2" },
  ];
  const { kept, dropped } = filterRelevant("Qwen3.6-35B-A3B llama.cpp MTP", rs);
  assert.equal(dropped, 2);
  assert.deepEqual(kept.map((r) => r.url), ["https://huggingface.co/x/y", "https://github.com/ggml-org/llama.cpp/releases"]);
});

test("filterRelevant: a query with no usable terms keeps everything", () => {
  const rs = [{ title: "a", url: "https://a.example" }];
  assert.deepEqual(filterRelevant("の は", rs), { kept: rs, dropped: 0 });
});

test("rawQuery collapses whitespace and caps at 200", () => {
  assert.equal(rawQuery("  a \n\n b  "), "a b");
});
