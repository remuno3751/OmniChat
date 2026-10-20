import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer, api, openWs, sleep, type TestServer } from "./test-server.js";
import { startFake, type Fake, type FakeCfg } from "./test-fake.js";
import { randomUUID } from "node:crypto";
import { estimateTokens, MSG_OVERHEAD } from "./tokens.js";
import { classifyAddress, classifyRoute } from "./route.js";

let s: TestServer;
let token: string;
const fakes: Fake[] = [];
const call = (method: string, path: string, body?: unknown, tok = token, extra: Record<string, string> = {}) => api(s.base, method, path, body, tok, extra);

before(async () => {
  s = await startServer({ TRUST_PROXY: "1", ALLOW_REGISTRATION: "1", OMNICHAT_CONTEXT_TTL_MS: "0" });
  token = (await api(s.base, "POST", "/auth/register", { username: "tester", password: "password123" })).json.token;
});
after(() => { s?.stop(); for (const f of fakes) f.close(); });

async function prov(cfg: FakeCfg, name = "P"): Promise<{ id: string; fake: Fake }> {
  const fake = await startFake(cfg);
  fakes.push(fake);
  const id = randomUUID();
  const r = await call("PUT", `/providers/${id}`, { name, kind: "openai-compatible", baseUrl: fake.base, model: "m" });
  assert.equal(r.status, 200);
  return { id, fake };
}
const conv = async (providerId: string, body: Record<string, unknown> = {}) => {
  const id = randomUUID();
  assert.equal((await call("PUT", `/conversations/${id}`, { providerId, ...body })).status, 200);
  return id;
};

interface Client { ws: WebSocket; frames: any[]; send(o: unknown): void; waitFrame(p: (f: any) => boolean, ms?: number): Promise<any>; msg(id: string): any; waitMsg(id: string, p?: (m: any) => boolean, ms?: number): Promise<any> }
async function client(headers: Record<string, string> = {}, tok = token): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${tok}`, { headers });
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
  const waitFrame = async (p: (f: any) => boolean, ms = 8000) => {
    const t = Date.now();
    for (;;) {
      const f = frames.find(p);
      if (f) return f;
      if (Date.now() - t > ms) throw new Error("timeout waiting for frame");
      await sleep(10);
    }
  };
  const msg = (id: string) => { let m: any; for (const f of frames) if (f.type === "upsert") for (const x of f.messages ?? []) if (x.id === id) m = x; return m; };
  const waitMsg = async (id: string, p: (m: any) => boolean = (m) => m.status !== "streaming", ms = 8000) => {
    const t = Date.now();
    for (;;) {
      const m = msg(id);
      if (m && p(m)) return m;
      if (Date.now() - t > ms) throw new Error(`timeout waiting for message ${id}: ${JSON.stringify(m)}`);
      await sleep(10);
    }
  };
  await waitFrame((f) => f.type === "snapshot");
  return { ws, frames, send: (o) => ws.send(JSON.stringify(o)), waitFrame, msg, waitMsg };
}
async function say(cl: Client, conversationId: string, content: string, extra: Record<string, unknown> = {}) {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId, content, userMessageId, assistantMessageId, ...extra });
  const asst = await cl.waitMsg(assistantMessageId);
  return { userMessageId, assistantMessageId, asst };
}
const ctxOf = async (id: string, body?: unknown) =>
  (body === undefined ? await call("GET", `/conversations/${id}/context`) : await call("POST", `/conversations/${id}/context`, body));
const setLimit = (provId: string, n: number | null) => call("PUT", "/settings", { contextLimits: n === null ? null : { [`${provId}::m`]: n } });

/* ---------------- 1. reasoning lane ---------------- */

test("reasoning lane: deltas carry kind, message.reasoning persisted, sync and snapshot include it", async () => {
  const { id: p, fake } = await prov({ reasoning: ["think ", "harder"], text: ["answer"], delayMs: 120 });
  const c = await conv(p);
  const cl = await client();
  const um = randomUUID(), am = randomUUID();
  cl.send({ type: "send", conversationId: c, content: "q", userMessageId: um, assistantMessageId: am });
  // mid-stream: another device connects and gets reasoning in the snapshot
  await cl.waitFrame((f) => f.type === "delta" && f.messageId === am && f.kind === "reasoning");
  await sleep(50);
  const cl2 = await client();
  const snap = cl2.frames.find((f) => f.type === "snapshot");
  const entry = snap.messages.find((m: any) => m.id === am);
  assert.ok(entry, "streaming message in snapshot");
  assert.ok(typeof entry.reasoning === "string" && entry.reasoning.startsWith("think"), JSON.stringify(entry));
  assert.equal(entry.status, "streaming");

  const done = await cl.waitMsg(am);
  assert.equal(done.status, "done");
  assert.equal(done.content, "answer");
  assert.equal(done.reasoning, "think harder");
  const d = cl.frames.filter((f) => f.type === "delta" && f.messageId === am);
  assert.deepEqual(d.filter((f) => f.kind === "reasoning").map((f) => f.text), ["think ", "harder"]);
  assert.deepEqual(d.filter((f) => f.kind !== "reasoning").map((f) => f.text), ["answer"]);
  assert.ok(d.every((f) => f.kind === undefined || f.kind === "reasoning"), "text deltas keep default kind");
  // the request never contained the reasoning
  assert.ok(JSON.stringify(fake.bodies[0]).indexOf("think") < 0);

  const sync = (await call("GET", "/sync?since=0")).json;
  const sm = sync.messages.find((m: any) => m.id === am);
  assert.equal(sm.reasoning, "think harder");
  assert.equal(sm.content, "answer");
  assert.equal(sync.messages.find((m: any) => m.id === um).reasoning, null);

  // reasoning is not re-sent as history on the next turn
  await say(cl, c, "again");
  assert.deepEqual(fake.bodies[1].messages.map((m: any) => m.content), ["q", "answer", "again"]);
  cl.ws.close(); cl2.ws.close();
});

test("reasoning alias field and empty reasoning", async () => {
  const { id: p } = await prov({ reasoning: ["alias-think"], reasoningAlias: true, text: ["ok"] });
  const { id: p2 } = await prov({ text: ["plain"] });
  const cl = await client();
  const a = await say(cl, await conv(p), "x");
  assert.equal(a.asst.reasoning, "alias-think");
  const b = await say(cl, await conv(p2), "x");
  assert.equal(b.asst.reasoning, null);
  cl.ws.close();
});

/* ---------------- 2. tokens and context ---------------- */

test("tokens: CJK-aware estimate", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("你好世界你好"), 4); // 6 / 1.5
  assert.equal(estimateTokens("ひらがなカタカナ"), Math.ceil(8 / 1.5));
  assert.equal(estimateTokens("한국어"), 2);
  assert.ok(estimateTokens("日本語のテキスト and english") > estimateTokens("and english"));
  assert.equal(MSG_OVERHEAD, 4);
});

test("context: estimate, draft, limit unknown, owner check", async () => {
  const { id: p } = await prov({ usage: null });
  await call("PUT", "/settings", { systemPrompt: "SYS", params: { maxTokens: 50 }, contextOverflow: "truncate", contextLimits: null });
  const c = await conv(p);
  const cl = await client();
  await say(cl, c, "x".repeat(40));
  const u = (await ctxOf(c)).json;
  const sys = estimateTokens("SYS") + MSG_OVERHEAD;
  const hist = estimateTokens("x".repeat(40)) + MSG_OVERHEAD + estimateTokens("R:" + "x".repeat(40) + "-end") + MSG_OVERHEAD;
  assert.equal(u.limit, null);
  assert.equal(u.limitSource, "unknown");
  assert.equal(u.fits, true);
  assert.equal(u.estimated, true);
  assert.equal(u.reserve, 50);
  assert.deepEqual(u.used, { system: sys, history: hist, attachments: 0, tools: 0, input: 0 });
  assert.equal(u.total, sys + hist);
  assert.equal(typeof u.headId, "string");
  assert.equal(u.reasoning, 0);

  const d = (await ctxOf(c, { draft: "y".repeat(80) })).json;
  assert.equal(d.used.input, estimateTokens("y".repeat(80)) + MSG_OVERHEAD);
  assert.equal(d.total, u.total + d.used.input);
  // does not touch the model
  const { fake } = { fake: fakes[fakes.length - 1] };
  assert.equal(fake.bodies.length, 1);

  // other users get 404
  const other = (await api(s.base, "POST", "/auth/register", { username: "other", password: "password123" })).json.token;
  assert.equal((await api(s.base, "GET", `/conversations/${c}/context`, undefined, other)).status, 404);
  assert.equal((await api(s.base, "POST", `/conversations/${c}/context`, {}, other)).status, 404);
  assert.equal((await api(s.base, "GET", `/conversations/${c}/context`)).status, 401);
  cl.ws.close();
});

test("context: calibration by the last exact usage", async () => {
  const { id: p } = await prov({ usage: { prompt_tokens: 50, completion_tokens: 9 }, text: ["hi"] });
  await call("PUT", "/settings", { systemPrompt: null, params: null });
  const c = await conv(p);
  const cl = await client();
  await say(cl, c, "hello there");
  const u = (await ctxOf(c)).json;
  // prompt (50, exact) + the assistant reply (completion 9 + overhead)
  assert.equal(u.total, 50 + 9 + MSG_OVERHEAD);
  assert.equal(u.estimated, false);
  const d = (await ctxOf(c, { draft: "abcd" })).json;
  assert.equal(d.used.input, 1 + MSG_OVERHEAD);
  assert.equal(d.estimated, true);
  cl.ws.close();
});

test("context: llama.cpp limit via /props and exact count via /tokenize", async () => {
  const { id: p, fake } = await prov({ props: 4096, tokenize: (t) => t.length, usage: null, text: ["ok"] });
  await call("PUT", "/settings", { systemPrompt: null, params: null, contextLimits: null });
  const c = await conv(p);
  let u = (await ctxOf(c, { draft: "12345" })).json;
  assert.equal(u.limit, 4096);
  assert.equal(u.limitSource, "backend");
  assert.equal(u.used.input, 5 + MSG_OVERHEAD);
  assert.equal(u.estimated, false);
  assert.deepEqual(fake.tokenizeCalls, ["12345"]);
  const cl = await client();
  await say(cl, c, "abcdefghij");
  u = (await ctxOf(c)).json;
  assert.equal(u.estimated, false);
  assert.equal(u.limit, 4096);
  assert.ok(u.total > 0 && u.fits);
  cl.ws.close();
});

test("context: limit sources LM Studio, Ollama, generic, override", async () => {
  const lm = await prov({ lm: [{ id: "m", type: "llm", state: "loaded", quantization: "Q4_K_M", max_context_length: 32768, loaded_context_length: 8192 }] });
  const lmIdle = await prov({ lm: [{ id: "m", type: "llm", state: "not-loaded", max_context_length: 32768 }] });
  const ol = await prov({ ollama: { ps: [{ name: "m", context_length: 2048 }], tags: [{ name: "m" }] } });
  const olIdle = await prov({ ollama: { ps: [], tags: [{ name: "m" }], show: { model_info: { "llama.context_length": 131072 } } } });
  const gen = await prov({});
  await call("PUT", "/settings", { contextLimits: null });
  const lim = async (id: string) => (await ctxOf(await conv(id))).json;
  assert.deepEqual([(await lim(lm.id)).limit, (await lim(lm.id)).limitSource], [8192, "backend"]);
  assert.equal((await lim(lmIdle.id)).limit, 32768);
  assert.equal((await lim(ol.id)).limit, 2048);
  assert.equal((await lim(olIdle.id)).limit, 131072);
  const g = await lim(gen.id);
  assert.deepEqual([g.limit, g.limitSource, g.fits], [null, "unknown", true]);

  // override wins; synced; validated
  const put = await call("PUT", "/settings", { contextLimits: { [`${lm.id}::m`]: 1234 } });
  assert.deepEqual(put.json.contextLimits, { [`${lm.id}::m`]: 1234 });
  const o = await lim(lm.id);
  assert.deepEqual([o.limit, o.limitSource], [1234, "override"]);
  assert.equal((await lim(ol.id)).limitSource, "backend");
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.deepEqual(sync.settings.contextLimits, { [`${lm.id}::m`]: 1234 });
  assert.equal(sync.settings.contextOverflow, "truncate");
  // per-request model override with another model keeps the override only for the keyed model
  const other = (await ctxOf(await conv(lm.id), { model: "zzz" })).json;
  assert.equal(other.limitSource, "unknown");

  assert.equal((await call("PUT", "/settings", { contextOverflow: "nope" })).status, 400);
  assert.equal((await call("PUT", "/settings", { contextLimits: [1] })).status, 400);
  assert.equal((await call("PUT", "/settings", { contextLimits: { a: -3 } })).status, 400);
  assert.equal((await call("PUT", "/settings", { contextLimits: { a: 1.5 } })).status, 400);
  assert.equal((await call("PUT", "/settings", { contextOverflow: "summarize" })).json.contextOverflow, "summarize");
  assert.equal((await call("PUT", "/settings", { contextOverflow: "truncate", contextLimits: null })).json.contextLimits, null);
});

/* ---------------- overflow behaviours ---------------- */

const SYSP = "SYS";
async function history(cl: Client, c: string, n: number) {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) ids.push((await say(cl, c, `t${i}`.padEnd(80, "x"))).assistantMessageId);
  return ids;
}
const debugOf = async (id: string) => (await call("GET", `/messages/${id}/debug`)).json;

test("overflow truncate: drops oldest pairs, keeps system and newest user, records contextAction", async () => {
  const { id: p, fake } = await prov({ usage: null });
  // contextCompressAt null: these cases test the overflow-only path (phase 5 compression is covered in phase5.test.ts)
  await call("PUT", "/settings", { systemPrompt: SYSP, params: { maxTokens: 20 }, contextOverflow: "truncate", contextLimits: null, contextCompressAt: null });
  const c = await conv(p);
  const cl = await client();
  await history(cl, c, 3);
  await setLimit(p, 130);
  const before = (await ctxOf(c)).json;
  assert.equal(before.fits, false);
  assert.equal(before.limit, 130);
  const t4 = "t4".padEnd(80, "x");
  const { asst } = await say(cl, c, t4);
  assert.equal(asst.status, "done");
  const sent = fake.bodies[fake.bodies.length - 1].messages;
  assert.deepEqual(sent[0], { role: "system", content: SYSP });
  assert.equal(sent[sent.length - 1].content, t4);
  assert.equal(sent[sent.length - 1].role, "user");
  assert.deepEqual(sent.map((m: any) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(sent[1].content, "t3".padEnd(80, "x"));
  const dbg = await debugOf(asst.id);
  assert.equal(dbg.final.contextAction.mode, "truncate");
  assert.equal(dbg.final.contextAction.droppedMessages, 4);
  assert.equal(dbg.final.contextAction.summarized, false);
  assert.equal(dbg.final.contextAction.limit, 130);
  assert.equal(dbg.final.messages.length, 4);
  // nothing in the stored conversation was removed
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.equal(sync.messages.filter((m: any) => m.conversationId === c).length, 8);
  // a conversation that fits has no contextAction
  await setLimit(p, 100000);
  const ok = await say(cl, c, "short");
  assert.equal((await debugOf(ok.asst.id)).final.contextAction, undefined);
  cl.ws.close();
});

test("overflow truncate: even system + newest user too big -> still sent, flagged unfit", async () => {
  const { id: p, fake } = await prov({ usage: null });
  await call("PUT", "/settings", { systemPrompt: SYSP, params: { maxTokens: 20 }, contextOverflow: "truncate", contextLimits: null });
  const c = await conv(p);
  const cl = await client();
  await history(cl, c, 2);
  await setLimit(p, 15);
  const { asst } = await say(cl, c, "n".repeat(200));
  assert.equal(asst.status, "done");
  assert.deepEqual(fake.bodies[fake.bodies.length - 1].messages.map((m: any) => m.role), ["system", "user"]);
  const a = (await debugOf(asst.id)).final.contextAction;
  assert.equal(a.unfit, true);
  cl.ws.close();
});

test("overflow stop: error frame code context_overflow, nothing persisted, no model call", async () => {
  const { id: p, fake } = await prov({ usage: null });
  await call("PUT", "/settings", { systemPrompt: SYSP, params: { maxTokens: 20 }, contextOverflow: "stop", contextLimits: null });
  const c = await conv(p);
  const cl = await client();
  await history(cl, c, 3);
  const calls = fake.bodies.length;
  await setLimit(p, 130);
  const um = randomUUID(), am = randomUUID();
  cl.send({ type: "send", conversationId: c, content: "t4".padEnd(80, "x"), userMessageId: um, assistantMessageId: am });
  const f = await cl.waitFrame((x) => x.type === "error" && x.code === "context_overflow");
  assert.equal(f.messageId, am);
  assert.match(f.message, /Context limit/);
  await sleep(150);
  assert.equal(fake.bodies.length, calls);
  assert.equal(cl.msg(am), undefined);
  assert.equal(cl.msg(um), undefined);
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.ok(!sync.messages.some((m: any) => m.id === am || m.id === um));
  // regenerate is rejected the same way
  const last = sync.messages.filter((m: any) => m.conversationId === c && m.role === "assistant").sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
  const am2 = randomUUID();
  cl.send({ type: "regenerate", conversationId: c, messageId: last.id, assistantMessageId: am2 });
  await cl.waitFrame((x) => x.type === "error" && x.code === "context_overflow" && x.messageId === am2);
  assert.equal(cl.msg(am2), undefined);
  // fits again -> works
  await setLimit(p, 100000);
  assert.equal((await say(cl, c, "fine")).asst.status, "done");
  cl.ws.close();
});

test("overflow summarize: one extra non-streamed call, cached, system-role note, fallback to truncate", async () => {
  const { id: p, fake } = await prov({ usage: null, summary: "SUMMARY-XYZ" });
  await call("PUT", "/settings", { systemPrompt: SYSP, params: { maxTokens: 20 }, contextOverflow: "summarize", contextLimits: null, contextCompressAt: null });
  const c = await conv(p);
  const cl = await client();
  const ids = await history(cl, c, 3);
  await setLimit(p, 600);
  // grow the history beyond the limit with a big message pair so some pairs get dropped but not all
  await setLimit(p, 130);
  const nonStream = () => fake.bodies.filter((b) => b.stream === false).length;
  assert.equal(nonStream(), 0);
  const { asst } = await say(cl, c, "t4".padEnd(80, "x"));
  assert.equal(asst.status, "done");
  assert.equal(nonStream(), 1);
  const sum = fake.bodies.find((b) => b.stream === false);
  assert.match(sum.messages[0].content, /<=200 words/);
  assert.match(sum.messages[1].content, /t1x/);
  const sent = fake.bodies.filter((b) => b.stream !== false).pop().messages;
  assert.equal(sent[0].role, "system");
  assert.match(sent[0].content, /^SYS/);
  assert.match(sent[0].content, /SUMMARY-XYZ/);
  assert.equal(sent[sent.length - 1].role, "user");
  assert.equal(sent[sent.length - 1].content, "t4".padEnd(80, "x"));
  const a = (await debugOf(asst.id)).final.contextAction;
  assert.equal(a.mode, "summarize");
  assert.equal(a.summarized, true);
  assert.ok(a.droppedMessages >= 2);
  // never persisted as a chat message
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.ok(!sync.messages.some((m: any) => /SUMMARY-XYZ/.test(m.content)));
  // regenerate over the same range -> cache hit, no new summary call
  const am2 = randomUUID();
  cl.send({ type: "regenerate", conversationId: c, messageId: asst.id, assistantMessageId: am2 });
  await cl.waitMsg(am2);
  assert.equal(nonStream(), 1, "cached");
  void ids;

  // failure -> truncate
  fake.cfg.summary = null;
  const c2 = await conv(p);
  await history(cl, c2, 0);
  await setLimit(p, 100000);
  await history(cl, c2, 3);
  await setLimit(p, 130);
  const r = await say(cl, c2, "t4".padEnd(80, "x"));
  assert.equal(r.asst.status, "done");
  const a2 = (await debugOf(r.asst.id)).final.contextAction;
  assert.equal(a2.summarized, false);
  assert.equal(a2.fellBack, true);
  const sent2 = fake.bodies.filter((b) => b.stream !== false).pop().messages;
  assert.equal(sent2[0].content, SYSP);
  assert.equal(sent2[sent2.length - 1].content, "t4".padEnd(80, "x"));
  cl.ws.close();
});

/* ---------------- 3. metrics ---------------- */

test("metrics: llama.cpp timings, reasoning share, context length, in sync/upsert", async () => {
  await call("PUT", "/settings", { systemPrompt: null, params: null, contextOverflow: "truncate", contextLimits: null });
  const timings = { prompt_n: 20, prompt_ms: 100, prompt_per_second: 200, predicted_n: 30, predicted_ms: 300, predicted_per_second: 100 };
  const { id: p } = await prov({ props: 4096, reasoning: ["r".repeat(40)], text: ["t".repeat(40)], usage: { prompt_tokens: 21, completion_tokens: 30 }, timings }, "llama");
  const cl = await client();
  const { asst, assistantMessageId } = await say(cl, await conv(p), "hello");
  const m = asst.metrics;
  assert.ok(m, "metrics on the finished upsert");
  assert.equal(m.source, "backend");
  assert.equal(m.prefillTps, 200);
  assert.equal(m.decodeTps, 100);
  assert.equal(m.promptTokens, 21);
  assert.equal(m.completionTokens, 30);
  assert.equal(m.reasoningTokens, 15);
  assert.equal(m.contextLength, 4096);
  assert.equal(m.providerId, p);
  assert.equal(m.model, "m");
  assert.ok(m.ttftMs >= 0 && m.totalMs >= m.ttftMs);
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.deepEqual(sync.messages.find((x: any) => x.id === assistantMessageId).metrics, m);
  assert.equal(sync.messages.find((x: any) => x.role === "user" && x.conversationId === asst.conversationId).metrics, null);
  cl.ws.close();
});

test("metrics: LM Studio stats and quantization", async () => {
  const { id: p } = await prov({
    lm: [{ id: "m", type: "llm", state: "loaded", quantization: "Q4_K_M", max_context_length: 32768, loaded_context_length: 8192 }],
    usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
    stats: { tokens_per_second: 55.5, time_to_first_token: 0.123 },
  }, "lmstudio");
  const cl = await client();
  const m = (await say(cl, await conv(p), "hi")).asst.metrics;
  assert.equal(m.source, "backend");
  assert.equal(m.decodeTps, 55.5);
  assert.equal(m.ttftMs, 123);
  assert.equal(m.prefillTps, Math.round((10 / 0.123) * 100) / 100);
  assert.equal(m.promptTokens, 10);
  assert.equal(m.completionTokens, 20);
  assert.equal(m.reasoningTokens, 5);
  assert.equal(m.quantization, "Q4_K_M");
  assert.equal(m.contextLength, 8192);
  cl.ws.close();
});

test("metrics: estimated from usage and self-measured times (ttft counts a reasoning delta)", async () => {
  const { id: p } = await prov({
    reasoning: ["thinking"], text: ["a", "b", "c"], delayMs: 60, reasonGapMs: 200, usage: { prompt_tokens: 12, completion_tokens: 24 },
  }, "plain");
  const cl = await client();
  const m = (await say(cl, await conv(p), "go")).asst.metrics;
  assert.equal(m.source, "estimated");
  assert.equal(m.promptTokens, 12);
  assert.equal(m.completionTokens, 24);
  assert.ok(m.ttftMs < 180, `ttft measured at the first reasoning delta, got ${m.ttftMs}`);
  assert.ok(m.totalMs >= 380);
  const expected = 24000 / (m.totalMs - m.ttftMs);
  assert.ok(Math.abs(m.decodeTps - expected) / expected < 0.05, `${m.decodeTps} vs ${expected}`);
  assert.ok(m.prefillTps > 0);
  assert.equal(m.contextLength, null);
  assert.equal(m.quantization, null);
  cl.ws.close();
});

test("metrics: no usage at all -> token counts estimated from text", async () => {
  const { id: p } = await prov({ text: ["x".repeat(40), "y".repeat(40)], delayMs: 30 }, "nousage");
  const cl = await client();
  const m = (await say(cl, await conv(p), "z".repeat(100))).asst.metrics;
  assert.equal(m.source, "estimated");
  assert.equal(m.completionTokens, estimateTokens("x".repeat(40) + "y".repeat(40)));
  assert.equal(m.promptTokens, estimateTokens("z".repeat(100)) + MSG_OVERHEAD);
  assert.ok(m.decodeTps > 0);
  cl.ws.close();
});

test("metrics: a stopped reply keeps metrics of the partial output", async () => {
  const { id: p } = await prov({ text: ["a", "b", "c"], delayMs: 400 }, "slow");
  const c = await conv(p);
  const cl = await client();
  const um = randomUUID(), am = randomUUID();
  cl.send({ type: "send", conversationId: c, content: "s", userMessageId: um, assistantMessageId: am });
  await sleep(100);
  cl.send({ type: "stop", messageId: am });
  const done = await cl.waitMsg(am);
  assert.equal(done.status, "stopped");
  assert.equal(done.metrics.completionTokens, 1);
  assert.equal(done.metrics.source, "estimated");
  cl.ws.close();
});

test("stats: grouping, estimated share, recent, since, series, CSV export, owner only", async () => {
  const sync = (await call("GET", "/sync?since=0")).json;
  const withMetrics = sync.messages.filter((m: any) => m.metrics);
  const st = (await call("GET", "/stats?recent=2")).json;
  assert.equal(st.overall.count, withMetrics.length);
  assert.ok(withMetrics.length >= 4);
  assert.equal(st.recent.n, 2);
  assert.ok(st.overall.avgDecodeTps > 0);
  assert.ok(st.overall.estimatedShare > 0 && st.overall.estimatedShare < 1);
  // grouped by provider/model/quantization/contextLength
  const names = st.byModel.map((g: any) => g.providerName).sort();
  assert.ok(names.includes("llama") && names.includes("lmstudio") && names.includes("plain") && names.includes("nousage"));
  const llama = st.byModel.find((g: any) => g.providerName === "llama");
  assert.deepEqual([llama.model, llama.contextLength, llama.count, llama.estimatedShare, llama.avgDecodeTps], ["m", 4096, 1, 0, 100]);
  const lm = st.byModel.find((g: any) => g.providerName === "lmstudio");
  assert.deepEqual([lm.quantization, lm.contextLength, lm.avgDecodeTps], ["Q4_K_M", 8192, 55.5]);
  const plain = st.byModel.find((g: any) => g.providerName === "plain");
  assert.equal(plain.estimatedShare, 1);
  assert.equal(st.byModel.reduce((a: number, g: any) => a + g.count, 0), st.overall.count);
  // series oldest first
  assert.equal(st.series.length, st.overall.count);
  for (let i = 1; i < st.series.length; i++) assert.ok(st.series[i].t >= st.series[i - 1].t);
  assert.deepEqual(Object.keys(st.series[0]).sort(), ["decodeTps", "model", "prefillTps", "t", "ttftMs"]);
  // since filter
  const future = (await call("GET", `/stats?since=${Date.now() + 100000}`)).json;
  assert.equal(future.overall.count, 0);
  assert.equal(future.overall.avgTtftMs, null);
  assert.deepEqual(future.byModel, []);
  // CSV
  const csv = await call("GET", "/stats/export");
  assert.equal(csv.status, 200);
  assert.match(String(csv.headers.get("content-type")), /text\/csv/);
  const lines = csv.text.trim().split("\n");
  assert.equal(lines.length, 1 + st.overall.count);
  assert.equal(lines[0], "message_id,conversation_id,provider_id,provider_kind,model,quantization,context_length,prompt_tokens,completion_tokens,reasoning_tokens,ttft_ms,total_ms,prefill_tps,decode_tps,source,created_at");
  assert.ok(lines.some((l: string) => l.includes(",Q4_K_M,8192,10,20,5,123,")));
  // owner only
  const other = (await api(s.base, "POST", "/auth/login", { username: "other", password: "password123" })).json.token;
  assert.equal((await api(s.base, "GET", "/stats", undefined, other)).json.overall.count, 0);
  assert.equal((await api(s.base, "GET", "/stats/export", undefined, other)).text.trim().split("\n").length, 1);
  assert.equal((await api(s.base, "GET", "/stats")).status, 401);
});

/* ---------------- 4. ping/pong and route ---------------- */

test("ws ping -> pong echoes t", async () => {
  const cl = await client();
  cl.send({ type: "ping", t: 1234567 });
  const pong = await cl.waitFrame((f) => f.type === "pong");
  assert.deepEqual(pong, { type: "pong", t: 1234567 });
  cl.send({ type: "ping", t: "abc" });
  await cl.waitFrame((f) => f.type === "pong" && f.t === "abc");
  cl.ws.close();
});

test("ws hello: serverTime and route (X-Forwarded-For honoured with TRUST_PROXY)", async () => {
  const cl = await client();
  const hello = cl.frames.find((f) => f.type === "hello");
  assert.equal(hello.route, "loopback");
  assert.ok(Math.abs(hello.serverTime - Date.now()) < 10_000);
  assert.equal(typeof hello.seq, "number");
  cl.ws.close();
  for (const [xff, route] of [
    ["100.64.1.2", "vpn"], ["192.168.1.5, 8.8.8.8", "lan"], ["8.8.8.8", "external"], ["10.0.0.3", "lan"], ["127.0.0.1", "external"],
  ] as const) {
    const c = await client({ "x-forwarded-for": xff });
    assert.equal(c.frames.find((f) => f.type === "hello").route, route, xff);
    c.ws.close();
  }
});

test("route classification unit", () => {
  const cases: Array<[string, string]> = [
    ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["::1", "loopback"], ["::ffff:127.0.0.1", "loopback"],
    ["10.1.2.3", "lan"], ["172.16.0.1", "lan"], ["172.31.255.1", "lan"], ["172.32.0.1", "external"], ["172.15.0.1", "external"],
    ["192.168.0.9", "lan"], ["192.169.0.9", "external"], ["fe80::1", "lan"], ["fc00::1", "lan"], ["fd12::1", "lan"],
    ["100.64.0.1", "vpn"], ["100.127.255.255", "vpn"], ["100.63.0.1", "external"], ["100.128.0.1", "external"],
    ["::ffff:192.168.1.1", "lan"], ["8.8.8.8", "external"], ["2001:db8::1", "external"], ["", "external"], ["garbage", "external"],
  ];
  for (const [a, r] of cases) assert.equal(classifyAddress(a), r, a);
  assert.equal(classifyRoute("127.0.0.1", "100.64.0.9", true), "vpn");
  assert.equal(classifyRoute("127.0.0.1", "100.64.0.9", false), "external", "forwarded loopback peer is not local");
  assert.equal(classifyRoute("127.0.0.1", undefined, true), "loopback");
  assert.equal(classifyRoute("127.0.0.1", ["8.8.8.8, 10.0.0.1"], true), "external");
});

test("route without TRUST_PROXY ignores X-Forwarded-For", async () => {
  const s2 = await startServer({});
  try {
    const tok = (await api(s2.base, "POST", "/auth/register", { username: "noproxy", password: "password123" })).json.token;
    const ws = new WebSocket(`ws://127.0.0.1:${s2.port}/ws?token=${tok}`, { headers: { "x-forwarded-for": "8.8.8.8" } });
    const frames: any[] = [];
    ws.on("message", (r) => frames.push(JSON.parse(r.toString())));
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "hello"); i++) await sleep(20);
    assert.equal(frames.find((f) => f.type === "hello").route, "external", "a loopback peer carrying X-Forwarded-For is not local");
    ws.close();
  } finally { s2.stop(); }
  void openWs;
});
