import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as netServer } from "node:net";
import { createServer as httpServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let child: ChildProcess;
let port = 0, tmp = "", base = "", token = "";
let oai: Server;
let oaiPort = 0;
let oaiHits = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
};
function freePort(): Promise<number> {
  return new Promise((res) => { const s = netServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
}
async function api(method: string, path: string, body?: unknown, tok = token) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
function open(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}
async function fakeBridge(name: string, ready: any = {}) {
  const ws = await open(`ws://127.0.0.1:${port}/bridge?token=${token}&name=${name}`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: "ready", name, cwd: "C:\\work", ...ready }));
  await sleep(100);
  return { ws, got, send: (o: any) => ws.send(JSON.stringify(o)) };
}
async function appWs() {
  const ws = await open(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const lastMsg = (id: string) => { let m: any; for (const f of frames) for (const x of f.messages ?? []) if (x.id === id) m = x; return m; };
  const anyMsg = (pred: (m: any) => boolean) => frames.flatMap((f) => f.messages ?? []).some(pred);
  return { ws, frames, lastMsg, anyMsg };
}
const sess = (sessionId: string, messages: any[], extra: any = {}) => ({ sessionId, cwd: "C:\\work", title: null, updatedAt: Date.now(), messages, ...extra });
const um = (key: string, text: string, createdAt = Date.now()) => ({ key, role: "user", text, createdAt, status: "done" });
const am = (key: string, text: string, status = "done", createdAt = Date.now()) => ({ key, role: "assistant", text, createdAt, status });
async function sync() { return (await api("GET", "/sync?since=0")).json; }

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-"));
  port = await freePort();
  oaiPort = await freePort();
  oai = httpServer((req, res) => {
    oaiHits++;
    if (req.url === "/v1/models" && req.headers.authorization === "Bearer sk-test") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alpha" }] }));
    } else { res.statusCode = 401; res.end("nope"); }
  }).listen(oaiPort);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { windowsHide: true,
    cwd: serverDir, env: { ...process.env, PORT: String(port), DB_PATH: join(tmp, "t.db") }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  token = (await api("POST", "/auth/register", { username: "tester", password: "password123" }, "")).json.token;
});
after(() => { child?.kill(); oai?.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test("models endpoints + run.model forwarding", async () => {
  const good = randomUUID(), bad = randomUUID(), dshP = randomUUID();
  await api("PUT", `/providers/${good}`, { name: "Local", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${oaiPort}/v1/`, model: "m", apiKey: "sk-test" });
  await api("PUT", `/providers/${bad}`, { name: "Bad", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${oaiPort}/v1`, model: "m", apiKey: "wrong" });
  await api("PUT", `/providers/${dshP}`, { name: "PC", kind: "dsh-bridge", baseUrl: "mpc", model: "x" });

  let r = await api("GET", `/providers/${good}/models`);
  assert.equal(typeof r.json.fetchedAt, "number");
  delete r.json.fetchedAt;
  assert.deepEqual(r.json.models.map((m: any) => ({ id: m.id, name: m.name })), [{ id: "alpha", name: "alpha" }, { id: "zeta", name: "zeta" }]);
  const hits = oaiHits;
  await api("GET", `/providers/${good}/models`);
  assert.equal(oaiHits, hits, "cached");
  r = await api("GET", `/providers/${bad}/models`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, []);
  assert.match(r.json.error, /401/);
  assert.equal((await api("GET", `/providers/nope/models`)).status, 404);
  assert.equal((await api("GET", `/providers/${good}/models`, undefined, "")).status, 401);

  assert.deepEqual((await api("GET", `/providers/${dshP}/models`)).json.models, []);
  const b = await fakeBridge("mpc", { models: [{ provider: "opencodex", id: "lm-studio/lfm", name: "LFM" }], defaultModel: "opencodex::lm-studio/lfm" });
  const dm = (await api("GET", `/providers/${dshP}/models`)).json;
  delete dm.fetchedAt;
  assert.deepEqual(dm, {
    models: [{ id: "opencodex::lm-studio/lfm", name: "lm-studio/lfm (opencodex)", group: "opencodex", current: true }],
    defaultModel: "opencodex::lm-studio/lfm",
  });
  b.send({ type: "models", models: [{ provider: "p", id: "a", name: "A" }, { bogus: 1 }, null] });
  await sleep(100);
  assert.deepEqual((await api("GET", `/providers/${dshP}/models`)).json.models, [{ id: "p::a", name: "a (p)", group: "p" }]);

  const all = (await api("GET", "/models")).json;
  assert.equal(all.groups.length, 3);
  const g = all.groups.find((x: any) => x.providerId === good);
  assert.equal(g.providerName, "Local");
  assert.equal(g.kind, "openai-compatible");
  assert.equal(g.models.length, 2);
  assert.ok(all.groups.find((x: any) => x.providerId === bad).error);

  const conv = randomUUID();
  await api("PUT", `/conversations/${conv}`, { providerId: dshP, model: "p::a" });
  const app = await appWs();
  app.ws.send(JSON.stringify({ type: "send", conversationId: conv, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID() }));
  await until(() => b.got.some((m) => m.type === "run"));
  const run = b.got.find((m) => m.type === "run");
  assert.equal(run.model, "p::a");
  b.send({ type: "done", runId: run.runId, ok: true, sessionId: "session-m1" });
  await sleep(100);
  await api("PUT", `/conversations/${conv}`, { model: "dsh" });
  app.ws.send(JSON.stringify({ type: "send", conversationId: conv, content: "hi2", userMessageId: randomUUID(), assistantMessageId: randomUUID() }));
  await until(() => b.got.filter((m) => m.type === "run").length === 2);
  const run2 = b.got.filter((m) => m.type === "run")[1];
  assert.ok(!("model" in run2));
  b.send({ type: "done", runId: run2.runId, ok: true, sessionId: "session-m1" });
  await sleep(100);
  app.ws.close(); b.ws.close();
  await sleep(100);
});

test("dsh-originated session is mirrored, updated, broadcast; malformed frames ignored; disconnect marks error", async () => {
  const provId = randomUUID();
  await api("PUT", `/providers/${provId}`, { name: "PC2", kind: "dsh-bridge", baseUrl: "pc2", model: "x" });
  const b = await fakeBridge("pc2");
  const app = await appWs();

  b.send({ type: "sessions", full: "yes", sessions: "nope" });
  b.send({ type: "sessions", full: true, sessions: [null, 5, { sessionId: "../bad", messages: [] }, { sessionId: "s", messages: [{ key: "zz", role: "user", text: "x" }] }] });
  await sleep(150);

  const t0 = 1_700_000_000_000;
  b.send({ type: "sessions", full: true, sessions: [sess("session-d1", [um("u:1:0", "Hello from dsh GUI", t0), am("a:1", "partial", "streaming", t0 + 5)], { title: "My dsh chat" })] });
  await until(() => app.frames.some((f) => f.conversations?.length));
  let s = await sync();
  const conv = s.conversations.find((c: any) => c.id === "dsh-session-d1");
  assert.ok(conv);
  assert.equal(conv.title, "My dsh chat");
  assert.equal(conv.providerId, provId);
  const msgs = s.messages.filter((m: any) => m.conversationId === "dsh-session-d1").sort((a: any, b: any) => a.createdAt - b.createdAt);
  assert.deepEqual(msgs.map((m: any) => [m.role, m.content, m.status, m.createdAt]), [["user", "Hello from dsh GUI", "done", t0], ["assistant", "partial", "streaming", t0 + 5]]);
  const asstId = msgs[1].id;
  const seq1 = msgs[1].seq;

  b.send({ type: "sessions", full: false, sessions: [sess("session-d1", [am("a:1", "partial and final", "done", t0 + 5)])] });
  await until(() => app.lastMsg(asstId)?.status === "done");
  s = await sync();
  const m2 = s.messages.filter((m: any) => m.conversationId === "dsh-session-d1");
  assert.equal(m2.length, 2);
  assert.equal(m2.find((m: any) => m.id === asstId).content, "partial and final");
  assert.ok(m2.find((m: any) => m.id === asstId).seq > seq1);

  const seqBefore = (await sync()).seq;
  b.send({ type: "sessions", full: false, sessions: [sess("session-d1", [am("a:1", "partial and final", "done", t0 + 5)])] });
  await sleep(150);
  assert.equal((await sync()).seq, seqBefore);

  b.send({ type: "sessions", full: false, sessions: [sess("session-d1", [um("u:2:0", "again"), am("a:2", "work", "streaming")])] });
  await until(() => app.anyMsg((m) => m.content === "work"));
  b.ws.close();
  await until(() => app.anyMsg((m) => m.content === "work" && m.status === "error"));
  s = await sync();
  assert.equal(s.messages.find((m: any) => m.content === "work").status, "error");
  assert.equal(s.messages.find((m: any) => m.id === asstId).status, "done");
  app.ws.close();
});

test("app-originated run is not duplicated; mirror ignored during active run", async () => {
  const provId = randomUUID(), conv = randomUUID();
  await api("PUT", `/providers/${provId}`, { name: "PC3", kind: "dsh-bridge", baseUrl: "pc3", model: "x" });
  await api("PUT", `/conversations/${conv}`, { providerId: provId });
  const b = await fakeBridge("pc3");
  const app = await appWs();
  const u1 = randomUUID(), a1 = randomUUID();
  app.ws.send(JSON.stringify({ type: "send", conversationId: conv, content: "from app", userMessageId: u1, assistantMessageId: a1 }));
  await until(() => b.got.some((m) => m.type === "run"));
  const run = b.got.find((m) => m.type === "run");
  const ev = (event: any) => b.send({ type: "event", runId: run.runId, event });
  ev({ type: "session", sessionId: "session-app1", cwd: "C:\\work" }); // cwd already known: the later mirror frame changes nothing
  ev({ type: "status", phase: "turn_start", turn: 1, step: 0 });
  ev({ type: "text", text: "answer" });
  await sleep(150);

  b.send({ type: "sessions", full: false, sessions: [sess("session-app1", [um("u:1:0", "from app"), am("a:1", "answer", "streaming")])] });
  await sleep(200);
  let s = await sync();
  assert.equal(s.messages.filter((m: any) => m.conversationId === conv).length, 2);
  assert.ok(!s.conversations.some((c: any) => c.id === "dsh-session-app1"));

  b.send({ type: "done", runId: run.runId, ok: true, sessionId: "session-app1" });
  await until(() => app.lastMsg(a1)?.status === "done");
  await sleep(50);

  const seqBefore = (await sync()).seq;
  b.send({ type: "sessions", full: true, sessions: [sess("session-app1", [um("u:1:0", "from app"), am("a:1", "answer (mirror version)", "done")])] });
  await sleep(250);
  s = await sync();
  assert.equal(s.seq, seqBefore);
  const cm = s.messages.filter((m: any) => m.conversationId === conv);
  assert.equal(cm.length, 2);
  assert.equal(cm.find((m: any) => m.id === a1).content, "answer");
  assert.ok(!s.conversations.some((c: any) => c.id === "dsh-session-app1"));

  b.send({ type: "sessions", full: false, sessions: [sess("session-app1", [um("u:2:0", "typed in gui", Date.now() + 10), am("a:2", "gui answer", "done", Date.now() + 11)])] });
  await until(() => app.anyMsg((m) => m.content === "gui answer"));
  s = await sync();
  assert.equal(s.messages.filter((m: any) => m.conversationId === conv).length, 4);
  b.ws.close(); app.ws.close();
});
