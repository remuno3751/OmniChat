// Usage quotas for shared providers (docs/PROTOCOL-v7-quotas.md). One server, tests run in order.
// A fake upstream (node:http) requires the owner's key and reports usage (100 in, 50 out) for every reply.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { connect, newConv, type Client, type Ctx } from "./test-chat-util.js";

const PW = "password123";
const OWNER_KEY = "OWNER-KEY-QUOTA-7373";
const TURN_TOKENS = 150; // 100 prompt + 50 completion, as the fake upstream reports

let s: TestServer;
let fake: Server;
let fakeBase = "";
const up = { chats: 0 };
let localTok = "";
let tokA = "", tokAlice = "", tokBob = "", tokCarol = "";
let dbm: typeof import("./db.js");
let q: typeof import("./quota.js");
let pShared = "", pAliceOwn = "";
let aliceKey = "";
const uidOf = (u: string) => (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: string }).id;
const usedToday = (u: string) => q.usageToday(uidOf(u));
const messageCount = (conversationId: string) =>
  (dbm.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conversationId) as { n: number }).n;

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* shared server, stopped in after() */ },
});
const sendFrame = (cl: Client, conversationId: string) => {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId, content: "hi", userMessageId, assistantMessageId });
  return assistantMessageId;
};

before(async () => {
  const port = await freePort();
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
    if (key !== OWNER_KEY) { res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad key"}'); return; }
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw || "{}");
    up.chats++;
    const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: `R:${last}` } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `R:${last}` }, finish_reason: "stop" }], usage }));
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
  q = await import("./quota.js");

  pShared = randomUUID(); pAliceOwn = randomUUID();
  const mk = (tok: string, id: string, name: string, key: string) =>
    api(s.base, "PUT", `/providers/${id}`, { name, kind: "openai-compatible", baseUrl: fakeBase, model: "m1", apiKey: key }, tok);
  assert.equal((await mk(tokA, pShared, "Shared fake", OWNER_KEY)).status, 200);
  assert.equal((await mk(tokAlice, pAliceOwn, "Alice own", OWNER_KEY)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/providers/${pShared}/shared`, { shared: true }, tokA)).status, 200);
  // alice may use every model of the shared provider; bob has no row (default none)
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pShared}`, { mode: "all" }, tokA)).status, 200);
  aliceKey = (await api(s.base, "POST", "/apikeys", { name: "quota" }, tokAlice)).json.key;
});
after(() => { s?.stop(); fake?.close(); });

test("a. defaults: nothing limited, GET /quota has the documented shape, usage counted from the upstream usage", async () => {
  const st = (await api(s.base, "GET", "/quota", undefined, tokAlice)).json;
  assert.equal(st.enabled, false);
  assert.equal(st.applies, true);
  assert.equal(st.daily.limit, null);
  assert.equal(st.monthly.limit, null);
  assert.equal(st.daily.used, 0);
  assert.ok(!Number.isNaN(Date.parse(st.daily.resetsAt)));
  assert.ok(!Number.isNaN(Date.parse(st.monthly.resetsAt)));
  assert.equal((await api(s.base, "GET", "/quota", undefined, tokA)).json.applies, false, "admins do not apply");
  assert.equal((await api(s.base, "GET", "/quota")).status, 401);

  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  for (let i = 0; i < 3; i++) {
    const aid = sendFrame(cl, conv);
    assert.equal((await cl.waitMsg(aid)).status, "done", `turn ${i}`);
  }
  assert.equal(usedToday("alice"), 3 * TURN_TOKENS);
  cl.ws.close();
});

test("b. daily limit: the turn that starts over the limit is refused over WS, nothing stored or sent upstream", async () => {
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: true, dailyTokens: 750 }, tokA)).status, 200);
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  // 450 used: two more turns fit (600, then 750)
  for (let i = 0; i < 2; i++) assert.equal((await cl.waitMsg(sendFrame(cl, conv))).status, "done", `turn ${i}`);
  assert.equal(usedToday("alice"), 750);
  const calls = up.chats, before = messageCount(conv);
  const aid = sendFrame(cl, conv);
  const err = await cl.waitFrame((f) => f.type === "error" && f.code === "quota_exceeded");
  assert.equal(err.messageId, aid);
  assert.match(err.message, /daily/);
  assert.equal(up.chats, calls);
  assert.equal(messageCount(conv), before);
  cl.ws.close();
});

test("c. HTTP /v1 answers 429 rate_limit/quota_exceeded once the limit is reached", async () => {
  const calls = up.chats;
  const r = await api(s.base, "POST", "/v1/chat/completions", { model: "shared-fake/m1", messages: [{ role: "user", content: "hi" }] }, aliceKey);
  assert.equal(r.status, 429);
  assert.equal(r.json.error.code, "quota_exceeded");
  assert.equal(r.json.error.type, "rate_limit");
  assert.equal(up.chats, calls);
});

test("d. monthly limit: a daily default of 0 is unlimited, the monthly limit still refuses", async () => {
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { dailyTokens: 0, monthlyTokens: 900 }, tokA)).status, 200);
  const st = (await api(s.base, "GET", "/quota", undefined, tokAlice)).json;
  assert.equal(st.daily.limit, null);
  assert.equal(st.monthly.limit, 900);
  assert.equal(st.monthly.used, 750);
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  assert.equal((await cl.waitMsg(sendFrame(cl, conv))).status, "done", "750 < 900 fits");
  assert.equal(usedToday("alice"), 900);
  sendFrame(cl, conv);
  const err = await cl.waitFrame((f) => f.type === "error" && f.code === "quota_exceeded");
  assert.match(err.message, /monthly/);
  cl.ws.close();
});

test("e. per-user override: 0 means unlimited; removing it restores the defaults; a partial override keeps the other default", async () => {
  const uid = uidOf("alice");
  const put = await api(s.base, "PUT", `/admin/quotas/users/${uid}`, { dailyTokens: 0, monthlyTokens: 0 }, tokA);
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.override, { dailyTokens: 0, monthlyTokens: 0 });
  assert.equal((await api(s.base, "GET", "/quota", undefined, tokAlice)).json.monthly.limit, null);
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  assert.equal((await cl.waitMsg(sendFrame(cl, conv))).status, "done", "unlimited for alice");
  cl.ws.close();

  assert.equal((await api(s.base, "DELETE", `/admin/quotas/users/${uid}`, undefined, tokA)).json.removed, true);
  const cl2 = await connect(ctxFor(tokAlice, pShared));
  const conv2 = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  cl2.send({ type: "send", conversationId: conv2, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID() });
  await cl2.waitFrame((f) => f.type === "error" && f.code === "quota_exceeded");
  cl2.ws.close();

  // daily override only: the monthly limit still comes from the defaults (900, already used)
  await api(s.base, "PUT", `/admin/quotas/users/${uid}`, { dailyTokens: 100000, monthlyTokens: null }, tokA);
  const st = (await api(s.base, "GET", "/quota", undefined, tokAlice)).json;
  assert.equal(st.daily.limit, 100000);
  assert.equal(st.monthly.limit, 900);
  const list = (await api(s.base, "GET", "/admin/quotas/users", undefined, tokA)).json;
  const row = list.users.find((u: any) => u.userId === uid);
  assert.deepEqual(row.override, { dailyTokens: 100000, monthlyTokens: null });
  assert.equal(row.usedThisMonth, st.monthly.used);
  await api(s.base, "DELETE", `/admin/quotas/users/${uid}`, undefined, tokA);
});

test("f. enabled=false lifts every limit (usage is still counted); own providers and admins are exempt", async () => {
  // alice is over the monthly limit now
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: false }, tokA)).status, 200);
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  const before = usedToday("alice");
  assert.equal((await cl.waitMsg(sendFrame(cl, conv))).status, "done");
  assert.equal(usedToday("alice"), before + TURN_TOKENS);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: true }, tokA)).status, 200);

  // her own provider is never limited, and its use is not counted
  const ownConv = await newConv(ctxFor(tokAlice, pAliceOwn), { providerId: pAliceOwn, model: "m1" });
  const used = usedToday("alice");
  assert.equal((await cl.waitMsg(sendFrame(cl, ownConv))).status, "done", "own provider");
  assert.equal(usedToday("alice"), used);
  cl.ws.close();

  // an admin uses the shared provider while the limits are set to 1 token (only admin-owned providers can be shared)
  await api(s.base, "PUT", "/admin/quotas", { dailyTokens: 1, monthlyTokens: 1 }, tokA);
  const acl = await connect(ctxFor(tokA, pShared));
  const aconv = await newConv(ctxFor(tokA, pShared), { providerId: pShared, model: "m1" });
  assert.equal((await acl.waitMsg(sendFrame(acl, aconv))).status, "done", "admin is exempt");
  assert.equal(usedToday("adminA"), 0, "admin usage is not counted");
  acl.ws.close();
  await api(s.base, "PUT", "/admin/quotas", { dailyTokens: 0, monthlyTokens: 0 }, tokA);
});

test("g. admin routes: admin only, strict bodies, audited changes", async () => {
  assert.equal((await api(s.base, "GET", "/admin/quotas", undefined, tokAlice)).status, 403);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: true }, tokAlice)).status, 403);
  assert.equal((await api(s.base, "GET", "/admin/quotas/users", undefined, tokAlice)).status, 403);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { bogus: 1 }, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { dailyTokens: -1 }, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", { enabled: "yes" }, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", "/admin/quotas", {}, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", `/admin/quotas/users/${uidOf("alice")}`, { dailyTokens: 1.5, monthlyTokens: null }, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", `/admin/quotas/users/${uidOf("alice")}`, { dailyTokens: null }, tokA)).status, 400);
  assert.equal((await api(s.base, "PUT", "/admin/quotas/users/no-such-user", { dailyTokens: null, monthlyTokens: null }, tokA)).status, 404);
  assert.equal((await api(s.base, "DELETE", "/admin/quotas/users/no-such-user", undefined, tokA)).status, 404);

  const cur = (await api(s.base, "GET", "/admin/quotas", undefined, tokA)).json.quotas;
  assert.equal(cur.enabled, true);
  assert.equal(cur.monthlyTokens, 0);
  const audit = (await api(s.base, "GET", "/admin/audit?limit=200", undefined, tokA)).json.entries as any[];
  assert.ok(audit.some((e) => e.action === "quotas.update"), "quotas.update audited");
  assert.ok(audit.some((e) => e.action === "quota.user"), "quota.user audited");
});

test("h. cleanup removes usage rows older than 400 days and keeps recent ones", async () => {
  const uid = uidOf("alice");
  dbm.db.prepare("INSERT INTO quota_usage (user_id, day, tokens) VALUES (?, '2000-01-01', 5)").run(uid);
  const removed = q.cleanupQuotaUsage();
  assert.ok(removed >= 1);
  const old = dbm.db.prepare("SELECT COUNT(*) AS n FROM quota_usage WHERE user_id = ? AND day = '2000-01-01'").get(uid) as { n: number };
  assert.equal(old.n, 0);
  assert.ok(usedToday("alice") > 0, "today's rows stay");
});
