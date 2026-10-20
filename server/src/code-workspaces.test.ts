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


const PC = "wspc";
async function mkCodeConv(): Promise<string> {
  const prov = randomUUID();
  await api("PUT", `/providers/${prov}`, { name: PC, kind: "dsh-bridge", baseUrl: PC, model: "x" });
  const id = randomUUID();
  await api("PUT", `/conversations/${id}`, { providerId: prov, model: "x", mode: "code" });
  return id;
}
const send = (app: Awaited<ReturnType<typeof appWs>>, conversationId: string, extra: any = {}) =>
  app.ws.send(JSON.stringify({ type: "send", conversationId, content: "hi", userMessageId: randomUUID(), assistantMessageId: randomUUID(), ...extra }));
const convOf = async (id: string) => (await sync()).conversations.find((c: any) => c.id === id);

test("migration: conversations.cwd exists, new conversations have cwd null", async () => {
  const id = await mkCodeConv();
  const c = await convOf(id);
  assert.equal(c.cwd, null);
});

test("mirror stores cwd on create and backfills an existing conversation", async () => {
  const b = await fakeBridge(PC);
  b.send({ type: "sessions", full: true, sessions: [sess("ws-1", [um("u:0:0", "a")], { cwd: "C:\\work\\app" })] });
  
  await sleep(200);
  assert.equal((await convOf("dsh-ws-1")).cwd, "C:\\work\\app");
  // cwd changes later: updated; relative / bogus cwd is ignored
  b.send({ type: "sessions", full: false, sessions: [sess("ws-1", [], { cwd: "D:\\other" })] });
  await sleep(200);
  assert.equal((await convOf("dsh-ws-1")).cwd, "D:\\other");
  b.send({ type: "sessions", full: false, sessions: [sess("ws-1", [], { cwd: "../etc" })] });
  await sleep(200);
  assert.equal((await convOf("dsh-ws-1")).cwd, "D:\\other");
  b.ws.close();
});

test("send with cwd: stored, forwarded in run, validated", async () => {
  const b = await fakeBridge(PC, { capabilities: { workspaces: true }, workspaces: ["/home/me/a", "/home/me/b/"] });
  const app = await appWs();
  const id = await mkCodeConv();

  send(app, id, { cwd: "/home/me/evil" });
  await until(() => app.frames.some((f) => f.type === "error" && f.code === "invalid_cwd"));
  assert.equal((await convOf(id)).cwd, null);
  assert.equal(b.got.filter((m) => m.type === "run").length, 0);

  for (const bad of ["relative/dir", "/home/me/a/../../etc", "/home/me/a\u0000x", "/home/me/a\n", 42]) {
    app.frames.length = 0;
    send(app, id, { cwd: bad });
    await until(() => app.frames.some((f) => f.type === "error" && f.code === "invalid_cwd"));
  }
  assert.equal((await convOf(id)).cwd, null);

  send(app, id, { cwd: "/home/me/b" });
  await until(() => b.got.some((m) => m.type === "run"));
  const run = b.got.find((m) => m.type === "run");
  assert.equal(run.cwd, "/home/me/b");
  assert.equal((await convOf(id)).cwd, "/home/me/b");
  // the session event carries the folder actually used
  b.send({ type: "event", runId: run.runId, event: { type: "session", sessionId: "ws-s2", cwd: "/home/me/b/" } });
  b.send({ type: "done", runId: run.runId, ok: true, sessionId: "ws-s2" });
  await until(() => app.frames.some((f) => (f.conversations ?? []).some((c: any) => c.id === id && c.cwd === "/home/me/b/")));

  // once a session exists a later cwd is ignored
  b.got.length = 0;
  send(app, id, { cwd: "/home/me/a" });
  await until(() => b.got.some((m) => m.type === "run"));
  assert.equal(b.got.find((m) => m.type === "run").sessionId, "ws-s2");
  assert.equal("cwd" in b.got.find((m) => m.type === "run"), false);
  assert.equal((await convOf(id)).cwd, "/home/me/b/");
  app.ws.close(); b.ws.close();
});

test("old bridge (no workspaces support): cwd is not forwarded; /bridges reports workspaces", async () => {
  const old = await fakeBridge(PC);
  let list = (await api("GET", "/bridges")).json.bridges.find((x: any) => x.name === PC);
  assert.equal(list.workspacesSupported, false);
  const app = await appWs();
  const id = await mkCodeConv();
  send(app, id, { cwd: "/anywhere/ok" });
  await until(() => old.got.some((m) => m.type === "run"));
  assert.equal("cwd" in old.got.find((m) => m.type === "run"), false);
  old.ws.close(); app.ws.close();
  await sleep(100);

  const nb = await fakeBridge(PC, { capabilities: { workspaces: true }, workspaces: ["/w/one"], allowAnyCwd: false });
  nb.send({ type: "workspaces", workspaces: ["/w/two", "/w/one", "rel", "/w/two"] });
  await sleep(150);
  list = (await api("GET", "/bridges")).json.bridges.find((x: any) => x.name === PC);
  assert.deepEqual(list.workspaces, ["/w/two", "/w/one"]);
  assert.equal(list.workspacesSupported, true);
  nb.ws.close();
});
