/* eslint-disable @typescript-eslint/no-explicit-any */
// /compact (POST /conversations/:id/compact): persisted summary, used by later turns, originals kept, refusals, ephemeral.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { connect, newConv, say, sleep, type Ctx, type Client } from "./test-chat-util.js";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { buildContext, SUMMARY_LABEL } from "./prompts.js";

/* A fake OpenAI-compatible backend. Non-stream requests are summaries ("SUMMARY n", or failing on demand);
   stream requests echo the last user message. Every request body is recorded. */
interface Fake { port: number; bodies: any[]; slowMs: number; summaryFail: boolean; summaries: number; close(): void }

async function startFake(): Promise<Fake> {
  const port = await freePort();
  const fk: Fake = { port, bodies: [], slowMs: 0, summaryFail: false, summaries: 0, close: () => undefined };
  const srv: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* not json */ }
    if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    fk.bodies.push(body);
    const msgs: any[] = body.messages ?? [];
    if (!body.stream) {
      if (fk.summaryFail) { res.writeHead(500, { "content-type": "text/plain" }).end("boom"); return; }
      fk.summaries++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `SUMMARY ${fk.summaries}` } }] }));
      return;
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    for (const p of [`R:${lastUser}`, "-end"]) {
      send({ id: "x", choices: [{ index: 0, delta: { content: p } }] });
      if (fk.slowMs) await sleep(fk.slowMs);
      if (closed) return;
    }
    send({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, timings: { predicted_ms: 1 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", r));
  fk.close = () => { srv.closeAllConnections(); srv.close(); };
  return fk;
}

let s: TestServer;
let fk: Fake;
let c: Ctx;
let cl: Client;

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  fk = await startFake();
  const reg = await api(s.base, "POST", "/auth/register", { username: "compactor", password: "password123" });
  const token = reg.json.token as string;
  const provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${fk.port}/v1`, model: "fake-model" }, token);
  c = { s, token, provId, be: null as any, call: (m: string, p: string, b?: unknown, t: string = token) => api(s.base, m, p, b, t), stop() { /* after() */ } } as unknown as Ctx;
  cl = await connect({ s, token } as any, token);
});
after(() => { cl?.ws.close(); fk?.close(); s?.stop(); });

const chatBodies = () => fk.bodies.filter((b) => b.stream);
const summaryBodies = () => fk.bodies.filter((b) => !b.stream && JSON.stringify(b.messages ?? []).includes("Summarize this conversation"));
const lastChat = () => chatBodies().at(-1);
const systemOf = (body: any): string => (body?.messages?.[0]?.role === "system" ? String(body.messages[0].content) : "");
const compact = (id: string, body?: unknown, token = c.token) => c.call("POST", `/conversations/${id}/compact`, body ?? {}, token);
const contextOf = async (id: string) => (await c.call("GET", `/conversations/${id}/context`)).json;

/** Four user turns with distinct markers (alpha .. delta). */
async function fourTurns(conv: string, tag: string): Promise<void> {
  for (const w of ["alpha", "beta", "gamma", "delta"]) await say(c, cl, conv, `${w}-${tag} question`);
}

test("too short: nothing to summarize is a 200 with compacted:false", async () => {
  const conv = await newConv(c);
  await say(c, cl, conv, "only one");
  const r = await compact(conv);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, compacted: false, reason: "too_short" });
  assert.equal(summaryBodies().length, 0, "no summarizer call");
});

test("compact stores a summary, returns the shapes, keeps every original message and reports usage", async () => {
  const conv = await newConv(c);
  await fourTurns(conv, "A");
  const before = (await contextOf(conv));
  assert.equal(before.summaryTokens, undefined, "no summary yet");

  const r = await compact(conv, { instructions: "  focus on DELTA-FOCUS  " });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.compacted, true);
  assert.equal(typeof r.json.tokensBefore, "number");
  assert.equal(typeof r.json.tokensAfter, "number");
  assert.equal(r.json.summarizedMessages, 4, "u1 a1 u2 a2 (last 2 turns kept by default)");
  assert.equal(r.json.keptMessages, 4, "u3 a3 u4 a4");
  assert.equal(r.json.summaryTokens > 0, true);
  assert.equal(typeof r.json.estimated, "boolean");

  const sum = summaryBodies().at(-1);
  assert.ok(sum, "summarizer request sent");
  assert.ok(JSON.stringify(sum).includes("Additional focus from the user: focus on DELTA-FOCUS"), "instructions reach the summarizer");
  assert.ok(JSON.stringify(sum).includes("alpha-A question"), "the cut turns are summarized");
  assert.ok(!JSON.stringify(sum).includes("delta-A question"), "the kept turns are not summarized");

  // originals are never touched
  const sync = (await c.call("GET", "/sync?since=0")).json;
  const stored = sync.messages.filter((m: any) => m.conversationId === conv);
  assert.equal(stored.length, 8);

  const after = await contextOf(conv);
  assert.ok(after.summaryTokens > 0, "context usage reports the summary");
  assert.ok(after.used.system >= after.summaryTokens, "summary counted inside the system part");
});

test("the next turn sends the summary in the system message and drops the summarized turns", async () => {
  const conv = await newConv(c);
  await fourTurns(conv, "B");
  await compact(conv);
  const summaryText = `SUMMARY ${fk.summaries}`;
  await say(c, cl, conv, "epsilon-B question");
  const body = lastChat();
  const sys = systemOf(body);
  assert.ok(sys.includes(`${SUMMARY_LABEL}\n${summaryText}`), `system: ${sys.slice(-200)}`);
  const all = JSON.stringify(body.messages);
  assert.ok(!all.includes("alpha-B question"), "first old user message is not sent");
  assert.ok(!all.includes("beta-B question"), "summarized turn is not sent");
  assert.ok(all.includes("gamma-B question") && all.includes("delta-B question"), "last kept turns are sent");
  assert.ok(all.includes("epsilon-B question"), "the new message is sent");
});

test("a second compact folds the previous summary into the new one", async () => {
  const conv = await newConv(c);
  await fourTurns(conv, "C");
  await compact(conv);
  const firstSummary = `SUMMARY ${fk.summaries}`;
  await say(c, cl, conv, "epsilon-C question");
  const r = await compact(conv);
  assert.equal(r.json.compacted, true, JSON.stringify(r.json));
  const sum = summaryBodies().at(-1);
  assert.ok(JSON.stringify(sum).includes(`Previous summary:\\n${firstSummary}`), "previous summary is passed as Previous summary:");
  const secondSummary = `SUMMARY ${fk.summaries}`;
  await say(c, cl, conv, "zeta-C question");
  const sys = systemOf(lastChat());
  assert.ok(sys.includes(`${SUMMARY_LABEL}\n${secondSummary}`));
  assert.ok(!sys.includes(firstSummary), "the older summary is replaced");
});

test("409 while a reply is being generated", async () => {
  const conv = await newConv(c);
  await fourTurns(conv, "D");
  fk.slowMs = 400;
  try {
    const a = randomUUID();
    cl.send({ type: "send", conversationId: conv, content: "slow-D question", userMessageId: randomUUID(), assistantMessageId: a });
    await cl.waitMsg(a, (m) => m.status === "streaming");
    const r = await compact(conv);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, "A reply is being generated");
    await cl.waitMsg(a);
  } finally {
    fk.slowMs = 0;
  }
});

test("refusals: unknown id, other user, bad body, code chat, failed summary", async () => {
  assert.equal((await compact(randomUUID())).status, 404);
  const summariesBefore = summaryBodies().length;

  const conv = await newConv(c);
  await fourTurns(conv, "E");
  const other = await api(s.base, "POST", "/auth/register", { username: "intruder", password: "password123" });
  assert.equal(other.status, 200, other.text);
  const r404 = await compact(conv, {}, other.json.token as string);
  assert.equal(r404.status, 404);
  assert.equal(r404.json.error, "Conversation not found");

  assert.equal((await compact(conv, { keepTurns: 21 })).status, 400);
  assert.equal((await compact(conv, { keepTurns: -1 })).status, 400);
  assert.equal((await compact(conv, { keepTurns: 1.5 })).status, 400);
  assert.equal((await compact(conv, { keepTurns: "2" })).status, 400);
  assert.equal((await compact(conv, { instructions: "x".repeat(2001) })).status, 400);
  assert.equal((await compact(conv, { instructions: 7 })).status, 400);
  assert.equal(summaryBodies().length, summariesBefore, "refused calls never reach the summarizer");

  const code = await newConv(c, { mode: "code" });
  assert.equal((await compact(code)).status, 400);

  fk.summaryFail = true;
  try {
    const failed = await compact(conv);
    assert.equal(failed.status, 502, failed.text);
    assert.equal(failed.json.error, "Summarization failed");
  } finally {
    fk.summaryFail = false;
  }
  assert.equal((await contextOf(conv)).summaryTokens, undefined, "a failed summary stores nothing");
});

test("ephemeral chat: compact works, the next turn uses the summary, unknown ephemeral id is 410", async () => {
  const cid = `eph_${randomUUID()}`;
  const put = await c.call("PUT", `/conversations/${cid}`, { ephemeral: true, providerId: c.provId, model: "fake-model" });
  assert.equal(put.status, 200, put.text);
  const sayEph = async (text: string) => {
    const u = `eph_${randomUUID()}`, a = `eph_${randomUUID()}`;
    cl.send({ type: "send", conversationId: cid, content: text, userMessageId: u, assistantMessageId: a });
    return cl.waitMsg(a);
  };
  for (const w of ["alpha", "beta", "gamma", "delta"]) await sayEph(`${w}-EPH question`);

  const r = await compact(cid, { keepTurns: 1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.compacted, true, JSON.stringify(r.json));
  assert.equal(r.json.summarizedMessages, 6, "u1 a1 u2 a2 u3 a3 kept only u4 a4");

  const summary = `SUMMARY ${fk.summaries}`;
  await sayEph("epsilon-EPH question");
  assert.ok(systemOf(lastChat()).includes(`${SUMMARY_LABEL}\n${summary}`));
  assert.ok(!JSON.stringify(lastChat().messages).includes("alpha-EPH"));

  // the persistent sync never sees ephemeral chats or their summaries
  const sync = (await c.call("GET", "/sync?since=0")).json;
  assert.ok(!sync.conversations.some((x: any) => x.id === cid));

  const gone = await compact(`eph_${randomUUID()}`);
  assert.equal(gone.status, 410);
  assert.equal(gone.json.error, "Ephemeral chat no longer exists");
});

test("compaction is invisible to a conversation without one (buildContext unchanged)", () => {
  const conv = { id: randomUUID(), project_id: null, system_prompt: null, system_mode: "append" };
  const built = buildContext({ userId: "nobody", conv, leafId: null, model: "m", providerKind: "openai-compatible" });
  assert.equal(built.compactedTokens, undefined);
  assert.ok(!(built.system ?? "").includes(SUMMARY_LABEL));
});
