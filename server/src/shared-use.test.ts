// Shared providers in use (docs/design/SHARED-PROVIDERS.md, docs/PROTOCOL-v7-shared-providers.md).
// One server, tests run in order. A fake upstream (node:http) requires the owner's key and records every key it gets.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { connect, newConv, type Client, type Ctx } from "./test-chat-util.js";

const PW = "password123";
const OWNER_KEY = "OWNER-KEY-SHARED-USE-4242";
const CAROL_KEY = "CAROL-KEY-PRIVATE-5151";

let s: TestServer;
let fake: Server;
let fakeBase = "";
const up = { keys: [] as string[], chats: [] as any[] };
let localTok = "";
let tokA = "", tokAlice = "", tokBob = "", tokCarol = "";
let dbm: typeof import("./db.js");
let sp: typeof import("./shared-providers.js");
let pShared = "", pPrivate = "", pCarol = "", pBob = "";
const uidOf = (u: string) => (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: string }).id;

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* shared server, stopped in after() */ },
});
const sendFrame = (cl: Client, conversationId: string, model?: string) => {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId, content: "hi", userMessageId, assistantMessageId });
  return assistantMessageId;
};
const upstreamCalls = () => up.chats.length;
const dbMessages = (conversationId: string) =>
  (dbm.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversationId) as { n: number }).n;

before(async () => {
  // fake upstream: requires a known key, lists m1 and m2, streams a reply
  const port = await freePort();
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const auth = String(req.headers.authorization ?? "");
    const key = auth.replace(/^Bearer\s+/, "");
    up.keys.push(key);
    if (key !== OWNER_KEY && key !== CAROL_KEY) { res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}'); return; }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw || "{}");
    up.chats.push({ key, body });
    const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: `R:${last}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `R:${last}` }, finish_reason: "stop" }] }));
    }
  }).listen(port, "127.0.0.1");
  fakeBase = `http://127.0.0.1:${port}/v1`;

  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  for (const [u, role] of [["adminA", "admin"], ["alice", "user"], ["bob", "user"], ["carol", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username: u, password: PW, role })).status, 200, u);
  }
  [tokA, tokAlice, tokBob, tokCarol] = await Promise.all(["adminA", "alice", "bob", "carol"].map(async (u) =>
    (await api(s.base, "POST", "/auth/login", { username: u, password: PW })).json.token as string));
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = join(s.tmp, "t.db");
  dbm = await import("./db.js");
  sp = await import("./shared-providers.js");

  pShared = randomUUID(); pPrivate = randomUUID(); pCarol = randomUUID(); pBob = randomUUID();
  const mk = (tok: string, id: string, baseUrl: string, key: string) =>
    api(s.base, "PUT", `/providers/${id}`, { name: "Shared fake", kind: "openai-compatible", baseUrl, model: "m1", apiKey: key }, tok);
  assert.equal((await mk(tokA, pShared, fakeBase, OWNER_KEY)).status, 200);
  assert.equal((await mk(tokA, pPrivate, fakeBase, OWNER_KEY)).status, 200);
  assert.equal((await mk(tokCarol, pCarol, fakeBase, CAROL_KEY)).status, 200);
  assert.equal((await mk(tokBob, pBob, fakeBase, "BOB-KEY-0000")).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/providers/${pShared}/shared`, { shared: true }, tokA)).status, 200);
  // alice: m1 only; bob: no row (default none)
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pShared}`, { mode: "list", models: ["m1"] }, tokA)).status, 200);
});
after(() => { s?.stop(); fake?.close(); });

test("a. a granted user chats with an allowed model: upstream gets the owner key, the message is the user's", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  const aid = sendFrame(cl, conv, "m1");
  const asst = await cl.waitMsg(aid);
  assert.equal(asst.status, "done");
  assert.match(asst.content, /R:hi/);
  assert.ok(up.keys.includes(OWNER_KEY));
  const last = up.chats[up.chats.length - 1];
  assert.equal(last.key, OWNER_KEY);
  const owner = dbm.db.prepare("SELECT user_id FROM conversations WHERE id = ?").get(conv) as { user_id: string };
  assert.equal(owner.user_id, uidOf("alice"));
  cl.ws.close();
});

test("b. a denied model is refused before anything is stored or sent upstream", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m2" });
  const before = upstreamCalls();
  const aid = sendFrame(cl, conv, "m2");
  const err = await cl.waitFrame((f) => f.type === "error" && f.code === "model_not_allowed");
  assert.equal(err.messageId, aid);
  assert.equal(upstreamCalls(), before);
  assert.equal(dbMessages(conv), 0);
  cl.ws.close();
});

test("c. a user without a row cannot see, list or use the shared provider", async () => {
  const bobCtx = ctxFor(tokBob, pShared);
  const sync = (await api(s.base, "GET", "/sync?since=0", undefined, tokBob)).json;
  assert.equal(sync.providers.some((p: any) => p.id === pShared), false);
  assert.equal((await api(s.base, "GET", `/providers/${pShared}/models`, undefined, tokBob)).status, 404);
  const cl = await connect(bobCtx);
  const conv = await newConv(bobCtx, { providerId: pShared, model: "m1" });
  const before = upstreamCalls();
  cl.send({ type: "send", conversationId: conv, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  await cl.waitFrame((f) => f.type === "error" && f.code === "model_not_allowed");
  assert.equal(upstreamCalls(), before);
  cl.ws.close();
});

test("d. defaultSharedAccess=all opens it to bob; a none row overrides the default", async () => {
  assert.equal((await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "all" }, tokA)).status, 200);
  const cl = await connect(ctxFor(tokBob, pShared));
  const conv = await newConv(ctxFor(tokBob, pShared), { providerId: pShared, model: "m1" });
  const aid = sendFrame(cl, conv, "m1");
  assert.equal((await cl.waitMsg(aid)).status, "done");
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("bob")}/grants/${pShared}`, { mode: "none" }, tokA)).status, 200);
  const before = upstreamCalls();
  cl.send({ type: "send", conversationId: conv, content: "again", userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  await cl.waitFrame((f) => f.type === "error" && f.code === "model_not_allowed");
  assert.equal(upstreamCalls(), before);
  cl.ws.close();
  await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "none" }, tokA);
});

test("e. no response or frame shows the owner's URL or key; another user's private provider is refused", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  const bodies = [
    (await api(s.base, "GET", "/sync?since=0", undefined, tokAlice)).text,
    (await api(s.base, "GET", "/models", undefined, tokAlice)).text,
    (await api(s.base, "GET", `/providers/${pShared}/models`, undefined, tokAlice)).text,
    (await api(s.base, "GET", `/providers/${pShared}/models/loaded?model=m2`, undefined, tokAlice)).text,
    (await api(s.base, "PUT", `/providers/${pShared}`, { name: "x", kind: "openai-compatible", baseUrl: "https://evil.example", model: "m1" }, tokAlice)).text,
  ];
  await new Promise((r) => setTimeout(r, 200));
  for (const f of cl.frames) bodies.push(JSON.stringify(f));
  const leaks = (text: string) => text.includes(OWNER_KEY) || text.includes(CAROL_KEY) || text.includes("127.0.0.1") || text.includes(fakeBase);
  for (const b of bodies) assert.equal(leaks(b), false, b.slice(0, 200));
  assert.equal(sp.getUsableProviderRow(uidOf("adminA"), pCarol), undefined);
  assert.equal((await api(s.base, "GET", `/providers/${pCarol}/models`, undefined, tokA)).status, 404);
  // the owner's own view keeps its own URL (not a leak to the owner)
  const own = (await api(s.base, "GET", "/sync?since=0", undefined, tokA)).json.providers.find((p: any) => p.id === pShared);
  assert.equal(own.shared, true);
  assert.equal(own.hasKey, true);
  cl.ws.close();
});

test("f. the /v1 API: m1 passes, m2 is 403, an unusable provider is 404", async () => {
  const key = (await api(s.base, "POST", "/apikeys", { name: "t" }, tokAlice)).json.key as string;
  const v1 = (model: string, k = key) => api(s.base, "POST", "/v1/chat/completions", { model, messages: [{ role: "user", content: "hi" }] }, k);
  const ok = await v1("m1");
  assert.equal(ok.status, 200);
  assert.match(JSON.stringify(ok.json), /R:hi/);
  const denied = await v1("m2");
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "model_not_allowed");
  const bobKey = (await api(s.base, "POST", "/apikeys", { name: "t" }, tokBob)).json.key as string;
  assert.equal((await v1("m1", bobKey)).status, 404);
});

test("g. revoking a grant refuses the next send and tells connected clients to re-fetch", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pShared}`, { mode: "none" }, tokA)).status, 200);
  await cl.waitFrame((f) => f.type === "providers-changed");
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  const before = upstreamCalls();
  cl.send({ type: "send", conversationId: conv, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  await cl.waitFrame((f) => f.type === "error" && f.code === "model_not_allowed");
  assert.equal(upstreamCalls(), before);
  cl.ws.close();
});

test("h. maintenance and the model refusal do not interfere (maintenance first)", async () => {
  await api(s.base, "PUT", "/admin/users/" + uidOf("alice") + "/grants/" + pShared, { mode: "all" }, tokA);
  assert.equal((await api(s.base, "PUT", "/admin/maintenance", { enabled: true, message: "down" }, tokA)).status, 200);
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m2" });
  cl.send({ type: "send", conversationId: conv, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  const e = await cl.waitFrame((f) => f.type === "error");
  assert.equal(e.code, "maintenance");
  await api(s.base, "PUT", "/admin/maintenance", { enabled: false }, tokA);
  cl.ws.close();
});

test("i. an upstream error that names the owner's URL and key is shown to the borrower without them (/v1)", async () => {
  // a second upstream: lists a model, then fails every chat call with a body that mentions its own address and the key
  const port = await freePort();
  const DEAD_KEY = "DEAD-KEY-SECRET-123";
  const leaky = createServer((req, res) => {
    req.resume();
    if (req.method === "GET" && req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "dead-model" }] })); return; }
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: `cannot use http://10.9.8.7:8090/v1 with key ${DEAD_KEY}` }));
  }).listen(port, "127.0.0.1");
  try {
    const pDead = randomUUID();
    assert.equal((await api(s.base, "PUT", `/providers/${pDead}`, { name: "Leaky shared", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: "dead-model", apiKey: DEAD_KEY }, tokA)).status, 200);
    assert.equal((await api(s.base, "PUT", `/admin/providers/${pDead}/shared`, { shared: true }, tokA)).status, 200);
    assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pDead}`, { mode: "all" }, tokA)).status, 200);
    const key = (await api(s.base, "POST", "/apikeys", { name: "t-leaky" }, tokAlice)).json.key as string;
    const r = await api(s.base, "POST", "/v1/chat/completions", { model: "dead-model", messages: [{ role: "user", content: "hi" }] }, key);
    const text = JSON.stringify(r.json);
    assert.equal(r.status, 500, `expected the upstream error, got ${r.status}: ${text}`);
    assert.ok(!text.includes("10.9.8.7"), `the upstream address leaked: ${text}`);
    assert.ok(!text.includes(DEAD_KEY), `the key leaked: ${text}`);
    // the owner still sees the real text (nothing to hide from them)
    const own = await api(s.base, "POST", "/apikeys", { name: "t-owner" }, tokA);
    const r2 = await api(s.base, "POST", "/v1/chat/completions", { model: "dead-model", messages: [{ role: "user", content: "hi" }] }, own.json.key as string);
    assert.match(JSON.stringify(r2.json), /10.9.8.7/);
  } finally { leaky.close(); }
});
