// Maintenance mode (docs/PROTOCOL-v7-maintenance.md). Tests are written against the contract.
// One server for the whole file, run in order: default state, admin write and validation, blocking, HTTP 503,
// broadcast + hello, switching off again, audit trail.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, type TestServer } from "./test-server.js";
import { startBackend, connect, newConv, say, type Backend, type Client, type Ctx } from "./test-chat-util.js";

const PW = "password123";
const MSG = "Upgrading the GPU cluster";

let s: TestServer;
let be: Backend;
let localTok = "", adminTok = "", bobTok = "", bobKey = "";
let provAdmin = "", provBob = "";
let adminCtx: Ctx, bobCtx: Ctx;

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const putMaint = (body: unknown, tok = adminTok) => api(s.base, "PUT", "/admin/maintenance", body, tok);
const getMaint = () => api(s.base, "GET", "/maintenance");
const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be,
  call: (method, path, body, t = tok) => api(s.base, method, path, body, t),
  stop() { /* shared server, stopped in after() */ },
});

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  be = await startBackend();
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  assert.equal((await local("POST", "/local-admin/users", { username: "boss", password: PW, role: "admin" })).status, 200);
  assert.equal((await local("POST", "/local-admin/users", { username: "bob", password: PW, role: "user" })).status, 200);
  adminTok = (await api(s.base, "POST", "/auth/login", { username: "boss", password: PW })).json.token;
  bobTok = (await api(s.base, "POST", "/auth/login", { username: "bob", password: PW })).json.token;
  assert.ok(adminTok && bobTok, "logins failed");
  const v1 = `http://127.0.0.1:${be.port}/v1`;
  provAdmin = randomUUID();
  provBob = randomUUID();
  assert.equal((await api(s.base, "PUT", `/providers/${provAdmin}`, { name: "Fake", kind: "openai-compatible", baseUrl: v1, model: "fake-model" }, adminTok)).status, 200);
  assert.equal((await api(s.base, "PUT", `/providers/${provBob}`, { name: "Fake", kind: "openai-compatible", baseUrl: v1, model: "fake-model" }, bobTok)).status, 200);
  bobKey = (await api(s.base, "POST", "/apikeys", { name: "t" }, bobTok)).json.key;
  assert.ok(bobKey, "api key failed");
  adminCtx = ctxFor(adminTok, provAdmin);
  bobCtx = ctxFor(bobTok, provBob);
});
after(() => { s?.stop(); be?.close(); });

test("a. default is disabled and GET /maintenance works without auth", async () => {
  const r = await getMaint();
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.maintenance, { enabled: false, message: "", eta: null, updatedAt: 0 });
});

test("b. only admins can PUT; admin enables it and it reads back; connected clients get the broadcast", async () => {
  const adminCl: Client = await connect(adminCtx);
  const bobCl: Client = await connect(bobCtx);
  assert.equal((await putMaint({ enabled: true }, bobTok)).status, 403);
  assert.equal((await getMaint()).json.maintenance.enabled, false, "a 403 must not change state");

  const eta = Date.now() + 120_000;
  const r = await putMaint({ enabled: true, message: MSG, eta });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.maintenance.enabled, true);
  assert.equal(r.json.maintenance.message, MSG);
  assert.equal(r.json.maintenance.eta, eta);
  assert.ok(r.json.maintenance.updatedAt > 0);
  assert.deepEqual((await getMaint()).json.maintenance, r.json.maintenance);

  // (f) every open connection, admin and regular user alike
  for (const cl of [adminCl, bobCl]) {
    const f = await cl.waitFrame((x) => x.type === "maintenance" && x.maintenance?.enabled === true);
    assert.deepEqual(f.maintenance, r.json.maintenance);
  }
  adminCl.ws.close();
  bobCl.ws.close();
});

test("c. invalid values are rejected with 400 and change nothing", async () => {
  const before = (await getMaint()).json.maintenance;
  const bad: unknown[] = [
    {},
    { enabled: "yes" },
    { message: "x".repeat(501) },
    { message: 42 },
    { eta: 0 },
    { eta: -5 },
    { eta: 1.5 },
    { eta: "soon" },
    { nope: true },
    [1, 2],
  ];
  for (const b of bad) assert.equal((await putMaint(b)).status, 400, JSON.stringify(b));
  assert.deepEqual((await getMaint()).json.maintenance, before);

  // 500 characters is the limit (boundary accepted); a past eta is accepted too
  assert.equal((await putMaint({ message: "y".repeat(500) })).status, 200);
  assert.equal((await putMaint({ eta: 1000 })).status, 200);
  assert.equal((await putMaint({ eta: null, message: MSG })).status, 200);
  const eta = Date.now() + 120_000;
  assert.equal((await putMaint({ eta })).status, 200);
});

test("d. while enabled, regular users cannot start LLM work; admins can", async () => {
  const bobCl = await connect(bobCtx);
  const adminCl = await connect(adminCtx);
  const bobConv = await newConv(bobCtx, { providerId: provBob, model: "fake-model" });
  const calls = be.bodies.length;

  // WS send by a regular user: error frame with code maintenance, nothing sent upstream
  const uid = randomUUID(), aid = randomUUID();
  bobCl.send({ type: "send", conversationId: bobConv, content: "hi", userMessageId: uid, assistantMessageId: aid });
  const err = await bobCl.waitFrame((f) => f.type === "error" && f.code === "maintenance");
  assert.equal(err.message, MSG);
  assert.equal(err.conversationId, bobConv);

  // regenerate is refused the same way
  bobCl.send({ type: "regenerate", conversationId: bobConv, messageId: uid, assistantMessageId: randomUUID() });
  await bobCl.waitFrame((f) => f.type === "error" && f.code === "maintenance" && f.conversationId === bobConv && f !== err);
  assert.equal(be.bodies.length, calls, "no upstream call for a blocked user");

  // admin: the same kind of turn goes through
  const adminConv = await newConv(adminCtx, { providerId: provAdmin, model: "fake-model" });
  const { asst } = await say(adminCtx, adminCl, adminConv, "hello from admin");
  assert.equal(asst.status, "done", JSON.stringify(asst));
  assert.equal(be.bodies.length, calls + 1);

  // HTTP LLM entry points: bench run and compaction are refused with 503 + maintenance for a regular user
  const bench = await api(s.base, "POST", "/bench/runs", { setId: "none" }, bobTok);
  assert.equal(bench.status, 503);
  assert.equal(bench.json.error.code, "maintenance");
  const compact = await api(s.base, "POST", `/conversations/${bobConv}/compact`, {}, bobTok);
  assert.equal(compact.status, 503);
  assert.equal(compact.json.error.code, "maintenance");

  bobCl.ws.close();
  adminCl.ws.close();
});

test("e. /v1/chat/completions answers 503 with code maintenance and Retry-After", async () => {
  const body = { model: "fake-model", messages: [{ role: "user", content: "hi" }] };
  const r = await api(s.base, "POST", "/v1/chat/completions", body, bobKey);
  assert.equal(r.status, 503);
  assert.deepEqual(
    { type: r.json.error.type, code: r.json.error.code, message: r.json.error.message },
    { type: "service_unavailable", code: "maintenance", message: MSG },
  );
  const retry = Number(r.headers.get("retry-after"));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 120, `retry-after=${r.headers.get("retry-after")}`);
});

test("g. hello carries the maintenance state (enabled case)", async () => {
  const cl = await connect(bobCtx);
  const hello = cl.frames.find((f) => f.type === "hello");
  assert.equal(hello?.maintenance?.enabled, true);
  assert.equal(hello?.maintenance?.message, MSG);
  cl.ws.close();
});

test("h. disabling restores normal use for everyone", async () => {
  const bobCl = await connect(bobCtx);
  const r = await putMaint({ enabled: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.maintenance.enabled, false);
  assert.equal((await getMaint()).json.maintenance.enabled, false);
  const f = await bobCl.waitFrame((x) => x.type === "maintenance" && x.maintenance?.enabled === false);
  assert.equal(f.maintenance.enabled, false);

  const conv = await newConv(bobCtx, { providerId: provBob, model: "fake-model" });
  const { asst } = await say(bobCtx, bobCl, conv, "back again");
  assert.equal(asst.status, "done", JSON.stringify(asst));
  const v1 = await api(s.base, "POST", "/v1/chat/completions", { model: "fake-model", messages: [{ role: "user", content: "hi" }] }, bobKey);
  assert.notEqual(v1.status, 503);

  const hello = await connect(bobCtx);
  assert.equal(hello.frames.find((x) => x.type === "hello")?.maintenance?.enabled, false);
  hello.ws.close();
  bobCl.ws.close();
});

test("i. every change is in the audit trail", async () => {
  const r = await api(s.base, "GET", "/admin/audit?limit=200", undefined, adminTok);
  assert.equal(r.status, 200);
  const rows = (r.json.entries as any[]).filter((e) => e.action === "maintenance.update");
  assert.ok(rows.some((e) => e.key === "enabled" && e.newValue === "true"), "enable recorded");
  assert.ok(rows.some((e) => e.key === "enabled" && e.newValue === "false"), "disable recorded");
  assert.ok(rows.some((e) => e.key === "message" && e.newValue === MSG), "message recorded");
  assert.ok(rows.every((e) => e.actor === "boss"), "actor is the admin");
});
