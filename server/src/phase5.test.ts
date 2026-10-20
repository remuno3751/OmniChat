import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { setup, connect, newConv, say, syncAll, type Ctx } from "./test-chat-util.js";
import { startServer, api } from "./test-server.js";
import { inlineRuns, parseMarkdown, toSlides, fileStem, markdownToDocx, markdownToPptx } from "./artifacts.js";
import { RICH_CONTENT_NOTE, buildContext } from "./prompts.js";
import { enforceContext, type Measured } from "./context.js";
import type { Settings } from "./projects.js";

/* Phase 5 (PROTOCOL-v3-phase5.md) server part: pinned chats, automatic compression, default context, convert, system note. */

let c: Ctx;
before(async () => { c = await setup(); });
after(() => { c?.stop(); });

const json = (res: any, code: number, o: unknown) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };

/* ---------------- markdown subset (pure) ---------------- */

test("inlineRuns splits bold, italic, code and links", () => {
  const runs = inlineRuns("a **b** *c* `d` [e](https://x.y)");
  assert.deepEqual(runs.map((r) => r.text), ["a ", "b", " ", "c", " ", "d", " e (https://x.y)"]);
  assert.equal(runs[1].bold, true);
  assert.equal(runs[3].italics, true);
  assert.equal(runs[5].code, true);
});

test("parseMarkdown recognises headings, lists, tables, code and rules", () => {
  const blocks = parseMarkdown("# Title\n\nIntro line\nsecond\n\n- one\n  - two\n1. first\n\n| A | B |\n|---|:-:|\n| 1 | 2 |\n\n```\ncode\n```\n---\n");
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "para", "bullet", "bullet", "ordered", "table", "code"]);
  assert.equal((blocks[3] as any).level, 1);
  assert.deepEqual((blocks[5] as any).rows, [["A", "B"], ["1", "2"]]);
  assert.deepEqual((blocks[6] as any).lines, ["code"]);
});

test("toSlides starts a slide at each level 1 or 2 heading", () => {
  const slides = toSlides(parseMarkdown("pre\n\n## One\n- a\n\n### sub\n\n# Two\n"), "Deck");
  assert.deepEqual(slides.map((s) => s.title), ["Deck", "One", "Two"]);
  assert.equal(slides[1].blocks.length, 2);
  assert.deepEqual(toSlides([], "Empty").map((s) => s.title), ["Empty"]);
});

test("fileStem strips path and control characters", () => {
  assert.equal(fileStem("../etc/pa\u0001ss:wd", "x"), ".. etc pa ss wd");
  assert.equal(fileStem("   ", "document"), "document");
  assert.equal(fileStem(undefined, "presentation"), "presentation");
});

/* ---------------- default / compression policy (pure, enforceContext) ---------------- */

function fake(total: number, limit: number, hist: number[], settingsPatch: Partial<Settings>, backendUrl: string | null) {
  const history = hist.map((_, i) => ({ id: `m${i}`, role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", content: "x".repeat(10) }));
  const built = {
    messages: history.map((h) => ({ role: h.role, content: h.content })),
    system: null, history, params: {}, effort: { requested: null, resolved: null, sentAs: null },
  };
  const usage = {
    limit, limitSource: "override" as const, total, used: { system: 0, history: total, attachments: 0, tools: 0, input: 0 },
    reasoning: 0, lastReasoning: 0, estimated: true, reserve: 100, fits: total + 100 <= limit, headId: "m-last",
  };
  const m = {
    usage, built, sysTok: 0, hist, model: "fake", backendLimit: null,
    prov: backendUrl ? { id: "p", kind: "openai-compatible", base_url: backendUrl, api_key: "" } : { id: "p", kind: "local" },
  } as unknown as Measured;
  const settings = {
    contextOverflow: "truncate", contextCompressAt: 80, contextCompressTarget: 50, defaultContextLength: null, ...settingsPatch,
  } as unknown as Settings;
  return { m, settings };
}

test("compression is off when contextCompressAt is null and the prompt only fits", async () => {
  const { m, settings } = fake(500, 1000, [100, 100, 100, 100], { contextCompressAt: null }, null);
  const r = await enforceContext(m, settings);
  assert.equal(r.action, null);
  assert.equal(r.overflow, false);
});

test("reaching contextCompressAt compresses the oldest pairs down to the target", async () => {
  // 850 of 1000 tokens = 85% >= 80%: drop pairs until the kept history plus the note fits 50% (500).
  const { m, settings } = fake(850, 1000, [200, 200, 200, 200], {}, null);
  const r = await enforceContext(m, settings);
  assert.ok(r.action, "action expected");
  assert.equal(r.action!.mode, "compress");
  assert.equal(r.action!.droppedMessages, 3, "the newest message is never dropped");
  assert.equal(r.action!.summarized, false);
  assert.equal(r.action!.fellBack, true, "no summary backend -> plain truncation");
  assert.ok(r.action!.totalAfter <= 500, `totalAfter ${r.action!.totalAfter}`);
  assert.equal(r.messages.at(-1)!.content, "x".repeat(10), "newest message kept");
});

test("compression with a working summary inserts one summary note and keeps the newest turn", async () => {
  const summary = await listenJson((req, res) => json(res, 200, { choices: [{ message: { content: "SUMMARY OF EARLIER" } }] }));
  try {
    const { m, settings } = fake(850, 1000, [200, 200, 200, 200], {}, `http://127.0.0.1:${summary.port}/v1`);
    const r = await enforceContext(m, settings);
    assert.equal(r.action!.mode, "compress");
    assert.equal(r.action!.summarized, true);
    assert.equal(r.action!.fellBack, undefined);
    const note = r.messages.find((x) => x.role === "system");
    assert.ok(note && note.content.includes("[Summary of the earlier conversation]\nSUMMARY OF EARLIER"));
    assert.equal(r.messages.length, 2, "summary note + the newest message");
  } finally { summary.close(); }
});

test("stop mode never compresses, it only reports overflow", async () => {
  const quiet = fake(850, 1000, [200, 200, 200, 200], { contextOverflow: "stop" }, null);
  assert.equal((await enforceContext(quiet.m, quiet.settings)).action, null);
  const over = fake(960, 1000, [200, 200, 200, 200], { contextOverflow: "stop" }, null);
  assert.equal((await enforceContext(over.m, over.settings)).overflow, true);
});

test("the date block and the rich-content note are switched off together (OMNICHAT_INJECT_DATE=0)", () => {
  const prev = process.env.OMNICHAT_INJECT_DATE;
  try {
    process.env.OMNICHAT_INJECT_DATE = "0";
    const conv = { id: randomUUID(), project_id: null, system_prompt: null, system_mode: "append" };
    const off = buildContext({ userId: "nobody", conv, leafId: null, model: "m", providerKind: "openai-compatible" });
    assert.equal(off.system, null);
    assert.equal(off.messages.length, 0);
    process.env.OMNICHAT_INJECT_DATE = "1";
    const on = buildContext({ userId: "nobody", conv, leafId: null, model: "m", providerKind: "openai-compatible" });
    assert.match(on.messages[0].content as string, /Current date and time/);
    assert.ok((on.messages[0].content as string).includes(RICH_CONTENT_NOTE));
  } finally {
    if (prev === undefined) delete process.env.OMNICHAT_INJECT_DATE; else process.env.OMNICHAT_INJECT_DATE = prev;
  }
});

/* ---------------- HTTP: pinned chats ---------------- */

test("PUT /conversations pins and unpins; pinnedAt is stamped once and synced", async () => {
  const id = await newConv(c);
  let r = await c.call("GET", "/sync?since=0");
  const created = r.json.conversations.find((x: any) => x.id === id);
  assert.equal(created.pinned, false);
  assert.equal(created.pinnedAt, null);

  r = await c.call("PUT", `/conversations/${id}`, { pinned: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.pinned, true);
  const first = r.json.pinnedAt;
  assert.equal(typeof first, "number");

  await new Promise((res) => setTimeout(res, 15));
  r = await c.call("PUT", `/conversations/${id}`, { pinned: true });
  assert.equal(r.json.pinnedAt, first, "re-pinning keeps its place");

  r = await c.call("PUT", `/conversations/${id}`, { pinned: false });
  assert.equal(r.json.pinned, false);
  assert.equal(r.json.pinnedAt, null);

  r = await c.call("PUT", `/conversations/${id}`, { pinned: "yes" });
  assert.equal(r.status, 400);

  const sync = await syncAll(c, 0);
  const row = sync.conversations.find((x: any) => x.id === id);
  assert.equal(row.pinned, false);
});

test("a pin change bumps seq so other devices pick it up", async () => {
  const id = await newConv(c);
  const before = (await syncAll(c, 0)).seq;
  await c.call("PUT", `/conversations/${id}`, { pinned: true });
  const after = await syncAll(c, before);
  const row = after.conversations.find((x: any) => x.id === id);
  assert.equal(row?.pinned, true);
});

test("pinning does not move updatedAt (sidebar order stays by activity)", async () => {
  const id = await newConv(c);
  const a = (await c.call("PUT", `/conversations/${id}`, {})).json.updatedAt;
  await new Promise((res) => setTimeout(res, 15));
  const b = (await c.call("PUT", `/conversations/${id}`, { pinned: true })).json.updatedAt;
  assert.equal(b, a);
});

/* ---------------- HTTP: settings ---------------- */

test("settings carry the compression and default-context keys with defaults and validation", async () => {
  const fresh = await startServer();
  try {
    const reg = await api(fresh.base, "POST", "/auth/register", { username: "p5user", password: "password123" });
    const tok = reg.json.token as string;
    let s = (await api(fresh.base, "GET", "/settings", undefined, tok)).json;
    assert.equal(s.contextCompressAt, 80);
    assert.equal(s.contextCompressTarget, 50);
    assert.equal(s.defaultContextLength, null);

    const put = (body: unknown) => api(fresh.base, "PUT", "/settings", body, tok);
    assert.equal((await put({ contextCompressAt: 49 })).status, 400);
    assert.equal((await put({ contextCompressAt: 96 })).status, 400);
    assert.equal((await put({ contextCompressAt: 80.5 })).status, 400);
    assert.equal((await put({ contextCompressTarget: 81 })).status, 400);
    assert.equal((await put({ contextCompressTarget: null })).status, 400);
    assert.equal((await put({ defaultContextLength: 255 })).status, 400);
    assert.equal((await put({ defaultContextLength: 10_000_001 })).status, 400);

    s = (await put({ contextCompressAt: 95, contextCompressTarget: 20, defaultContextLength: 32768 })).json;
    assert.equal(s.contextCompressAt, 95);
    assert.equal(s.contextCompressTarget, 20);
    assert.equal(s.defaultContextLength, 32768);

    s = (await put({ contextCompressAt: null })).json;
    assert.equal(s.contextCompressAt, null, "null turns compression off");
    assert.equal(s.contextCompressTarget, 20, "other keys are kept");

    s = (await put({ defaultContextLength: null })).json;
    assert.equal(s.defaultContextLength, null);
  } finally { fresh.stop(); }
});

test("config export and import carry the compression and default-context keys", async () => {
  const fresh = await startServer();
  try {
    const reg = await api(fresh.base, "POST", "/auth/register", { username: "cfguser", password: "password123" });
    const tok = reg.json.token as string;
    await api(fresh.base, "PUT", "/settings", { contextCompressAt: 70, contextCompressTarget: 40, defaultContextLength: 8192 }, tok);
    const exp = await api(fresh.base, "GET", "/config/export?format=json", undefined, tok);
    const doc = JSON.parse(exp.text);
    assert.equal(doc.settings.contextCompressAt, 70);
    assert.equal(doc.settings.contextCompressTarget, 40);
    assert.equal(doc.settings.defaultContextLength, 8192);

    await api(fresh.base, "PUT", "/settings", { contextCompressAt: 90, contextCompressTarget: 60, defaultContextLength: 4096 }, tok);
    const imp = await api(fresh.base, "POST", "/config/import", { format: "json", content: exp.text, mode: "merge" }, tok);
    assert.equal(imp.status, 200, imp.text);
    const s = (await api(fresh.base, "GET", "/settings", undefined, tok)).json;
    assert.equal(s.contextCompressAt, 70);
    assert.equal(s.contextCompressTarget, 40);
    assert.equal(s.defaultContextLength, 8192);
  } finally { fresh.stop(); }
});

test("defaultContextLength is the assumed limit when the backend reports none; contextLimits still wins", async () => {
  const id = await newConv(c);
  await c.call("PUT", "/settings", { defaultContextLength: 4096 });
  let u = (await c.call("GET", `/conversations/${id}/context`)).json;
  assert.equal(u.limit, 4096);
  assert.equal(u.limitSource, "default");

  await c.call("PUT", "/settings", { contextLimits: { [`${c.provId}::fake-model`]: 3000 } });
  u = (await c.call("GET", `/conversations/${id}/context`)).json;
  assert.equal(u.limit, 3000);
  assert.equal(u.limitSource, "override");

  await c.call("PUT", "/settings", { contextLimits: null, defaultContextLength: null });
});

/* ---------------- HTTP: compression end to end ---------------- */

/* A backend that reports prompt tokens from the request size (so the context accounting sees real growth) and answers summaries. */
async function sizedBackend(): Promise<{ port: number; close(): void }> {
  return listenJson(async (req, res, body) => {
    if (!String(req.url).endsWith("/chat/completions")) return json(res, 404, {});
    if (!body.stream) return json(res, 200, { choices: [{ message: { content: "SUMMARY OF EARLIER" } }] });
    const msgs: any[] = body.messages ?? [];
    const promptTokens = Math.ceil(msgs.reduce((n, m) => n + String(m.content).length, 0) / 4);
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: `R:${String(lastUser).slice(0, 20)}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 2, total_tokens: promptTokens + 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}

test("a send that reaches the compression threshold reports mode compress and keeps every stored message", async () => {
  const be = await sizedBackend();
  const fresh = await startServer();
  const tok = (await api(fresh.base, "POST", "/auth/register", { username: "cmpuser", password: "password123" })).json.token as string;
  const cl = await connect({ s: fresh, token: tok } as any, tok);
  try {
    const pid = randomUUID();
    await api(fresh.base, "PUT", `/providers/${pid}`, { name: "sized", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${be.port}/v1`, model: "fake-model" }, tok);
    const put = await api(fresh.base, "PUT", "/settings", { contextOverflow: "truncate", contextCompressAt: 80, contextCompressTarget: 50, defaultContextLength: 2000, params: { maxTokens: 100 } }, tok);
    assert.equal(put.status, 200, put.text);
    const conv = randomUUID();
    await api(fresh.base, "PUT", `/conversations/${conv}`, { providerId: pid, model: "fake-model" }, tok);
    let last: any = null;
    for (let i = 0; i < 6; i++) last = await say({} as Ctx, cl, conv, `turn ${i} ` + "lorem ipsum dolor ".repeat(60));
    const rec = (await api(fresh.base, "GET", `/messages/${last.assistantMessageId}/debug`, undefined, tok)).json;
    assert.equal(rec.final.contextAction?.mode, "compress", JSON.stringify(rec.final.contextAction));
    assert.equal(rec.final.contextAction.summarized, true);
    assert.ok(rec.final.contextAction.droppedMessages >= 2);
    assert.ok(rec.final.messages.length < 12, "the request is shorter than the stored chat");
    assert.equal(rec.final.messages[0].role, "system", "the summary note travels as a system message");
    const stored = (await syncAll({ call: (m: string, p: string) => api(fresh.base, m, p, undefined, tok) } as any, 0)).messages.filter((m: any) => m.conversationId === conv);
    assert.equal(stored.length, 12, "original messages are never deleted");
  } finally {
    cl.ws.close();
    fresh.stop();
    be.close();
  }
});

test("the rich-content note reaches the model when the date block is on", async () => {
  const on = await setup({ OMNICHAT_INJECT_DATE: "1" });
  const cl = await connect(on);
  try {
    const conv = await newConv(on);
    await say(on, cl, conv, "hello");
    const sys = on.be.bodies.at(-1).messages[0].content as string;
    assert.ok(sys.includes("Current date and time"));
    assert.ok(sys.includes("```chart"));
    assert.ok(sys.includes("```artifact"));
  } finally { cl.ws.close(); on.stop(); }
});

/* ---------------- default load context ---------------- */

async function listenJson(handler: (req: any, res: any, body: any) => void): Promise<{ port: number; close(): void; calls: string[] }> {
  const calls: string[] = [];
  const srv: Server = createHttp((req, res) => {
    let raw = "";
    req.on("data", (x) => (raw += x));
    req.on("end", () => {
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* */ }
      calls.push(`${req.method} ${req.url}`);
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as any).port, close: () => { srv.closeAllConnections(); srv.close(); }, calls };
}

test("a model load without contextLength uses defaultContextLength; an explicit value wins", async () => {
  const loads: any[] = [];
  const lm = await listenJson((req, res, body) => {
    if (req.url === "/v1/models") return json(res, 200, { data: [{ id: "chat-a" }] });
    if (req.url === "/api/v0/models") return json(res, 200, { data: [{ id: "chat-a", type: "llm", state: "not-loaded", max_context_length: 8192 }] });
    if (req.url === "/api/v1/models") return json(res, 200, { models: [{ key: "chat-a", loaded_instances: [] }] });
    if (req.url === "/api/v1/models/load") { loads.push(body); return json(res, 200, { status: "loaded" }); }
    json(res, 404, {});
  });
  const fresh = await startServer({ OMNICHAT_LOCAL_PROBES: "[]", OMNICHAT_MODEL_POLL_MS: "60000" });
  try {
    const tok = (await api(fresh.base, "POST", "/auth/register", { username: "ldtest", password: "password123" })).json.token as string;
    const pid = randomUUID();
    await api(fresh.base, "PUT", `/providers/${pid}`, { name: "lm", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${lm.port}/v1`, model: "x" }, tok);
    await api(fresh.base, "PUT", "/settings", { defaultContextLength: 4096 }, tok);
    let r = await api(fresh.base, "POST", `/providers/${pid}/models/load`, { model: "chat-a" }, tok);
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.stringify(loads.at(-1)).includes("4096"), true, JSON.stringify(loads.at(-1)));

    r = await api(fresh.base, "POST", `/providers/${pid}/models/load`, { model: "chat-a", contextLength: 8192 }, tok);
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.stringify(loads.at(-1)).includes("8192"), true);
    assert.equal(JSON.stringify(loads.at(-1)).includes("4096"), false);
  } finally { fresh.stop(); lm.close(); }
});

/* ---------------- POST /artifacts/convert ---------------- */

const MD = "# Report\n\nIntro with **bold** and *italic* and `code`.\n\n## Section\n\n- one\n- two\n\n1. first\n2. second\n\n| Name | Score |\n|---|---|\n| Ann | 9 |\n\n```\nlet x = 1;\n```\n";

test("POST /artifacts/convert returns a valid .docx", async () => {
  const r = await fetch(`${c.s.base}/artifacts/convert`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
    body: JSON.stringify({ type: "docx", title: "Meeting notes", markdown: MD }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(r.headers.get("content-disposition"), "attachment; filename*=UTF-8''Meeting%20notes.docx");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString("hex"), "504b0304", "zip signature");
  const names = buf.toString("latin1");
  assert.ok(names.includes("word/document.xml"));
  assert.ok(names.includes("[Content_Types].xml"));
});

test("POST /artifacts/convert returns a valid .pptx with one slide per heading", async () => {
  const r = await fetch(`${c.s.base}/artifacts/convert`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` },
    body: JSON.stringify({ type: "pptx", title: "Deck", markdown: "Intro\n\n## Agenda\n- a\n- b\n\n## Numbers\n\n| x | y |\n|---|---|\n| 1 | 2 |\n" }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString("hex"), "504b0304");
  const text = buf.toString("latin1");
  for (const p of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml"]) assert.ok(text.includes(p), p);
  assert.ok(!text.includes("ppt/slides/slide4.xml"), "Deck intro + Agenda + Numbers = 3 slides");
});

test("POST /artifacts/convert rejects bad input", async () => {
  const post = (body: unknown, tok = c.token) => fetch(`${c.s.base}/artifacts/convert`, {
    method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post({ type: "csv", markdown: "x" })).status, 400);
  assert.equal((await post({ type: "docx" })).status, 400);
  assert.equal((await post({ type: "docx", markdown: "x", title: 5 })).status, 400);
  assert.equal((await post({ type: "docx", markdown: "x".repeat(1_000_001) })).status, 413);
  assert.equal((await post({ type: "docx", markdown: "x" }, "")).status, 401);
});

