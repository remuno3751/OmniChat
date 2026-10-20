// Review 2026-10 (docs/SECURITY-AUDIT-2026-10.md, findings Q-*): quota accounting gaps. Same setup as quota.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, sleep, type TestServer } from "./test-server.js";
import { connect, newConv, say, type Ctx } from "./test-chat-util.js";
import { startLlm, writePlugin, type Llm } from "./test-tools-util.js";

const PW = "password123";
const OWNER_KEY = "OWNER-KEY-QUOTA-REVIEW";

let s: TestServer;
let fake: Server;
let fakeBase = "";
const up = { chats: 0 };
let localTok = "";
let tokA = "", tokAlice = "";
let dbm: typeof import("./db.js");
let q: typeof import("./quota.js");
let pShared = "";
const uidOf = (u: string) => (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: string }).id;
const usedToday = (u: string) => q.usageToday(uidOf(u));
const local = (method: string, path: string, body?: unknown) => api(s.base, method, path, body, "", { "x-local-admin": localTok });
const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* stopped in after() */ },
});

before(async () => {
  const port = await freePort();
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "") !== OWNER_KEY) { res.writeHead(401).end("{}"); return; }
    if (req.method === "GET" && req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }] })); return; }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw || "{}");
    up.chats++;
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    if (body.stream) {
      // slow stream without a usage frame: 12 chunks, 80 ms apart
      res.writeHead(200, { "content-type": "text/event-stream" });
      let closed = false;
      req.on("close", () => { closed = true; });
      for (let i = 0; i < 12 && !closed; i++) {
        res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: `chunk-${i} lorem ipsum dolor sit amet ` } }] })}\n\n`);
        await sleep(80);
      }
      if (!closed) res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "SUMMARY" }, finish_reason: "stop" }], usage }));
    }
  }).listen(port, "127.0.0.1");
  fakeBase = `http://127.0.0.1:${port}/v1`;

  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  for (const [u, role] of [["adminA", "admin"], ["alice", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username: u, password: PW, role })).status, 200, u);
  }
  [tokA, tokAlice] = await Promise.all(["adminA", "alice"].map(async (u) => (await api(s.base, "POST", "/auth/login", { username: u, password: PW })).json.token as string));
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = join(s.tmp, "t.db");
  dbm = await import("./db.js");
  q = await import("./quota.js");
  pShared = randomUUID();
  assert.equal((await api(s.base, "PUT", `/providers/${pShared}`, { name: "Shared fake", kind: "openai-compatible", baseUrl: fakeBase, model: "m1", apiKey: OWNER_KEY }, tokA)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/providers/${pShared}/shared`, { shared: true }, tokA)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pShared}`, { mode: "all" }, tokA)).status, 200);
});
after(() => { s?.stop(); fake?.close(); });

test("Q-1 (checked, not a defect): ending an ephemeral chat mid-reply does not erase the tokens that were already generated", async () => {
  const c = ctxFor(tokAlice, pShared);
  const cid = `eph_${randomUUID()}`;
  assert.equal((await c.call("PUT", `/conversations/${cid}`, { ephemeral: true, providerId: pShared, model: "m1" })).status, 200);
  const cl = await connect(c);
  const aid = `eph_${randomUUID()}`;
  cl.send({ type: "send", conversationId: cid, content: "tell me a long story please", userMessageId: `eph_${randomUUID()}`, assistantMessageId: aid });
  await cl.waitMsg(aid, (m) => String(m.content).includes("chunk-2"));
  assert.equal((await c.call("DELETE", `/conversations/${cid}`)).status, 200);
  const t0 = Date.now();
  while (usedToday("alice") === 0 && Date.now() - t0 < 3000) await sleep(50);
  assert.ok(usedToday("alice") > 0, "the partial reply must be counted");
  cl.ws.close();
});

test("Q-2: /compact on a shared provider is counted and refused at the limit", async () => {
  const c = ctxFor(tokAlice, pShared);
  const conv = await newConv(c, { providerId: pShared, model: "m1" });
  const cl = await connect(c);
  const aid = randomUUID();
  cl.send({ type: "send", conversationId: conv, content: "hello there", userMessageId: randomUUID(), assistantMessageId: aid });
  assert.equal((await cl.waitMsg(aid, undefined, 10_000)).status, "done");
  cl.ws.close();
  const before = usedToday("alice");
  const r = await c.call("POST", `/conversations/${conv}/compact`, { keepTurns: 0 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.compacted, true);
  assert.equal(usedToday("alice") - before, 150, "the summary call is counted from the upstream usage");

  // two more turns so that there is something new to summarize, then the limit
  const cl2 = await connect(c);
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    cl2.send({ type: "send", conversationId: conv, content: `more ${i}`, userMessageId: randomUUID(), assistantMessageId: id });
    assert.equal((await cl2.waitMsg(id, undefined, 10_000)).status, "done");
  }
  cl2.ws.close();
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: true, dailyTokens: 1 }, tokA)).status, 200);
  const calls = up.chats;
  const r2 = await c.call("POST", `/conversations/${conv}/compact`, { keepTurns: 0 });
  assert.equal(r2.status, 429, r2.text);
  assert.equal(up.chats, calls, "nothing is sent upstream once the limit is reached");
});

test("Q-3: a sequential compare is held to the limit again before each target, not only at the start", async () => {
  // reset: the limit is lower than one reply (150); today's usage is whatever the earlier tests left
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: true, dailyTokens: 0, monthlyTokens: 0 }, tokA)).status, 200);
  await local("PUT", `/local-admin/quotas/users/${uidOf("alice")}`, { dailyTokens: usedToday("alice") + 1, monthlyTokens: null });
  const c = ctxFor(tokAlice, pShared);
  const cl = await connect(c);
  const compareId = randomUUID();
  const target = { providerId: pShared, model: "m1" };
  cl.send({ type: "compare", compareId, prompt: "hi", sequential: true, targets: [target, target, target] });
  await cl.waitFrame((f) => f.type === "compare_complete" && f.compareId === compareId, 20_000);
  const done = cl.frames.filter((f) => f.type === "compare_done" && f.compareId === compareId).sort((a, b) => a.index - b.index);
  assert.equal(done.length, 3);
  assert.equal(done[0].status, "done");
  // one token of room: the first target starts, every later one is over the limit
  assert.ok(done.slice(1).every((d) => d.status === "error" && /limit/.test(String(d.error))), JSON.stringify(done.map((d) => [d.status, d.error])));
  cl.ws.close();
});

test("Q-4: every upstream round of a tool turn is counted, not only the last one", async () => {
  const llm: Llm = await startLlm();
  try {
    writePlugin(s.tmp, "echo-plugin", {
      "plugin.json": JSON.stringify({ id: "echo-plugin", name: "Echo", version: "1", description: "d", main: "index.mjs",
        tools: [{ name: "echo", description: "echo", parameters: { type: "object", properties: {} }, permissions: [] }] }),
      "index.mjs": "export const tools = { echo: async () => 'echoed' };",
    });
    assert.equal((await api(s.base, "POST", "/tools/reload", {}, tokA)).status, 200);
    const pTool = randomUUID();
    assert.equal((await api(s.base, "PUT", `/providers/${pTool}`, { name: "Shared tools", kind: "openai-compatible", baseUrl: llm.base, model: "llm-1" }, tokA)).status, 200);
    assert.equal((await api(s.base, "PUT", `/admin/providers/${pTool}/shared`, { shared: true }, tokA)).status, 200);
    assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pTool}`, { mode: "all" }, tokA)).status, 200);
    assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: false }, tokA)).status, 200);
    const c = ctxFor(tokAlice, pTool);
    const conv = await newConv(c, { providerId: pTool, model: "llm-1", tools: ["echo"], searchMode: "off" });
    const start = llm.bodies.length;
    // three rounds: two tool rounds and the answer; the fake upstream reports 7 + 3 tokens for each
    llm.script = (_b, n) => (n - start < 2 ? { calls: [{ id: `c${n}`, name: "echo", args: {} }] } : { text: ["done"] });
    const cl = await connect(c);
    const before = usedToday("alice");
    const t = await say(c, cl, conv, "go");
    assert.equal(t.asst.status, "done");
    assert.equal(llm.bodies.length - start, 3);
    assert.equal(usedToday("alice") - before, 30, "three upstream calls of 10 tokens");
    cl.ws.close();
  } finally { llm.close(); }
});
