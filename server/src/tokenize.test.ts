import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api, type TestServer } from "./test-server.js";
import { startFake, type Fake } from "./test-fake.js";
import { estimatePieces, tokenizeText, MAX_TOKENIZE_CHARS } from "./tokenize.js";
import { randomUUID } from "node:crypto";

test("estimatePieces: pieces concatenate back to the input; CJK in 1-2 char pieces, ASCII in 4 char pieces", () => {
  const samples = ["hello world, this is a test", "日本語のテキストです。漢字とカナ", "mixed 中文 and English 123", "", "🙂🙂 emoji"];
  for (const t of samples) assert.equal(estimatePieces(t).join(""), t);
  assert.deepEqual(estimatePieces("abcdefghij"), ["abcd", "efgh", "ij"]);
  for (const p of estimatePieces("日本語のテキストです")) assert.ok(Array.from(p).length <= 2);
});

test("tokenizeText without a llama.cpp backend is an estimate", async () => {
  const r = await tokenizeText("hello world", null);
  assert.equal(r.source, "estimate");
  assert.equal(r.exact, false);
  assert.equal(r.count, r.tokens.length);
  assert.equal(r.tokens.map((t) => t.text).join(""), "hello world");
  assert.equal(r.truncated, undefined);
});

test("tokenizeText caps the text at 20 000 characters", async () => {
  const long = "a".repeat(MAX_TOKENIZE_CHARS + 500);
  const r = await tokenizeText(long, null);
  assert.equal(r.truncated, true);
  assert.equal(r.tokens.map((t) => t.text).join("").length, MAX_TOKENIZE_CHARS);
});

let s: TestServer;
let llama: Fake;
let token: string;
let provId: string;
let other: string;

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  llama = await startFake({ props: 4096, tokenize: (t) => t.length });
  token = (await api(s.base, "POST", "/auth/register", { username: "tokens", password: "password123" })).json.token;
  provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Llama", kind: "openai-compatible", baseUrl: llama.base, model: "m" }, token);
  other = randomUUID();
  await api(s.base, "PUT", `/providers/${other}`, { name: "Plain", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", model: "m" }, token);
});
after(() => { llama?.close(); s?.stop(); });

test("POST /tokenize requires auth and a string text", async () => {
  assert.equal((await api(s.base, "POST", "/tokenize", { text: "x" })).status, 401);
  assert.equal((await api(s.base, "POST", "/tokenize", { text: 5 }, token)).status, 400);
  assert.equal((await api(s.base, "POST", "/tokenize", { text: "x", providerId: randomUUID() }, token)).status, 404);
});

test("POST /tokenize uses llama.cpp /tokenize with pieces when available", async () => {
  // fake returns ids only: pieces come from /detokenize (one call per token)
  const r = await api(s.base, "POST", "/tokenize", { providerId: provId, text: "abcdef" }, token);
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "llama.cpp");
  assert.equal(r.json.exact, true);
  assert.equal(r.json.count, 6);
  assert.deepEqual(r.json.tokens.map((t: any) => t.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(r.json.tokens[0], { id: 0, text: "<0>" });
  assert.ok(llama.tokenizeCalls.includes("abcdef"));
});

test("POST /tokenize falls back to an estimate for other backends and unknown models", async () => {
  const r = await api(s.base, "POST", "/tokenize", { providerId: other, text: "hello there" }, token);
  assert.equal(r.json.source, "estimate");
  assert.equal(r.json.exact, false);
  const bare = await api(s.base, "POST", "/tokenize", { text: "一二三" }, token);
  assert.equal(bare.json.source, "estimate");
  assert.equal(bare.json.count, 2);
});
