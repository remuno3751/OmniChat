// Code preview (docs/design/CODE-PREVIEW.md, stage 2): server gate for file access through a fake bridge.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const PW = "password123";
let child: ChildProcess;
let port = 0;
let tmp = "";
let base = "";
let tok = "";
let otherTok = "";
let rateTok = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
};

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); });
  });
}
async function api(method: string, path: string, body?: unknown, t = tok) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
/** GET that keeps the raw body and headers (for file responses). Paced by default so the 20/s per-user bucket refills between calls. */
async function get(path: string, t = tok, paced = true) {
  if (paced) await sleep(60);
  const r = await fetch(base + path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  const body = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  if ((r.headers.get("content-type") ?? "").includes("application/json")) json = JSON.parse(body.toString("utf8"));
  return { status: r.status, headers: r.headers, body, text: body.toString("utf8"), json };
}
function open(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.once("open", () => res(ws));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}

type Resp = Record<string, unknown> | undefined;
type Respond = (m: any) => Resp;
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** The default answers of a healthy bridge. */
const defaultRespond: Respond = (m) => {
  if (m.op === "list") {
    return { ok: true, entries: [
      { name: "index.html", kind: "file", size: 13 },
      { name: ".env", kind: "file", size: 9 },
      { name: "node_modules", kind: "dir", size: 0 },
      { name: "sub", kind: "dir", size: 0 },
    ] };
  }
  const text = `<h1>hi ${m.path}</h1>`;
  return { ok: true, content: b64(text), size: text.length, mime: "text/html", truncated: false };
};

/** A fake bridge: sends `ready` (with capabilities.fs when caps), and answers `fs` frames with cfg.respond (undefined = no answer). */
async function fakeBridge(name: string, caps: boolean, t = tok) {
  const ws = await open(`ws://127.0.0.1:${port}/bridge?token=${t}&name=${name}`);
  const frames: any[] = [];
  const cfg: { respond: Respond } = { respond: defaultRespond };
  const ready: any = { type: "ready", name, cwd: "C:\\work\\proj" };
  if (caps) ready.capabilities = { fs: true };
  ws.send(JSON.stringify(ready));
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type !== "fs") return;
    frames.push(m);
    const r = cfg.respond(m);
    if (r !== undefined) ws.send(JSON.stringify({ type: "fs_result", requestId: m.requestId, ...r }));
  });
  await sleep(120);
  return { ws, frames, cfg, close: () => ws.close() };
}

/** Creates a provider (dsh-bridge with the bridge name) and a conversation; mode "code" or omitted (chat). */
async function mkConv(bridgeName: string | null, mode: "code" | "chat" | null, t = tok): Promise<string> {
  const id = randomUUID();
  const body: Record<string, unknown> = {};
  if (bridgeName) {
    const prov = randomUUID();
    await api("PUT", `/providers/${prov}`, { name: bridgeName, kind: "dsh-bridge", baseUrl: bridgeName, model: "x" }, t);
    body.providerId = prov;
  }
  if (mode) body.mode = mode;
  const r = await api("PUT", `/conversations/${id}`, body, t);
  assert.equal(r.status, 200, "conversation create");
  return id;
}

let pc: Awaited<ReturnType<typeof fakeBridge>>;
let legacy: Awaited<ReturnType<typeof fakeBridge>>;
let codeConv = "", chatConv = "", ghostConv = "", legacyConv = "", noBridgeConv = "";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "omni-preview-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    windowsHide: true,
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: join(tmp, "t.db"),
      OMNICHAT_OPEN_FIRST_REGISTRATION: "1",
      ALLOW_REGISTRATION: "1",
      OMNICHAT_FS_TIMEOUT_MS: "300",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  // The first account is the administrator (needed for maintenance mode).
  tok = (await api("POST", "/auth/register", { username: "tester", password: PW, deviceName: "t", platform: "test" }, "")).json.token;
  otherTok = (await api("POST", "/auth/register", { username: "other", password: PW, deviceName: "t", platform: "test" }, "")).json.token;
  rateTok = (await api("POST", "/auth/register", { username: "ratey", password: PW, deviceName: "t", platform: "test" }, "")).json.token;
  assert.ok(tok && otherTok && rateTok, "registration");

  pc = await fakeBridge("pc", true);
  legacy = await fakeBridge("legacy", false);
  codeConv = await mkConv("pc", "code");
  chatConv = await mkConv("pc", "chat");
  ghostConv = await mkConv("ghost", "code");
  legacyConv = await mkConv("legacy", "code");
  noBridgeConv = await mkConv(null, "code");
});
after(() => {
  try { pc?.close(); legacy?.close(); } catch { /* ignore */ }
  child?.kill();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("tree and file go through the bridge with its working folder", async () => {
  const tree = await get(`/code/preview/tree?conversationId=${codeConv}`);
  assert.equal(tree.status, 200);
  // .env and node_modules are dropped on the server side too
  assert.deepEqual(tree.json, { entries: [
    { name: "index.html", kind: "file", size: 13 },
    { name: "sub", kind: "dir", size: 0 },
  ] });
  const lf = pc.frames.at(-1);
  assert.equal(lf.type, "fs");
  assert.equal(lf.op, "list");
  assert.equal(lf.cwd, "C:\\work\\proj");
  assert.equal(lf.path, "");

  await get(`/code/preview/tree?conversationId=${codeConv}&path=sub`);
  assert.equal(pc.frames.at(-1).path, "sub");

  const f = await get(`/code/preview/file?conversationId=${codeConv}&path=index.html`);
  assert.equal(f.status, 200);
  assert.equal(f.text, "<h1>hi index.html</h1>");
  assert.match(f.headers.get("content-type") ?? "", /^text\/html/);
  const ff = pc.frames.at(-1);
  assert.equal(ff.op, "read");
  assert.equal(ff.path, "index.html");
  assert.equal(ff.cwd, "C:\\work\\proj");
  assert.equal(ff.maxBytes, 3 * 1024 * 1024);

  await get(`/code/preview/file?conversationId=${codeConv}&path=index.html&maxBytes=1000`);
  assert.equal(pc.frames.at(-1).maxBytes, 1000);
  assert.equal((await get(`/code/preview/file?conversationId=${codeConv}&path=index.html&maxBytes=0`)).status, 400);
});

test("refusals: not Code, no bridge, offline, fs disabled, other user, missing conversation", async () => {
  const legacyFrames = legacy.frames.length;

  const st = (cid: string, t = tok) => get(`/code/preview/status?conversationId=${cid}`, t);
  assert.deepEqual((await st(codeConv)).json, { available: true });

  let r = await get(`/code/preview/tree?conversationId=${chatConv}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "preview_unavailable");
  assert.equal(r.json.reason, "not_code");
  assert.deepEqual((await st(chatConv)).json, { available: false, reason: "not_code" });

  r = await get(`/code/preview/file?conversationId=${noBridgeConv}&path=index.html`);
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, "no_bridge");

  r = await get(`/code/preview/tree?conversationId=${ghostConv}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, "bridge_offline");
  assert.deepEqual((await st(ghostConv)).json, { available: false, reason: "bridge_offline" });

  r = await get(`/code/preview/file?conversationId=${legacyConv}&path=index.html`);
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, "fs_disabled");
  assert.deepEqual((await st(legacyConv)).json, { available: false, reason: "fs_disabled" });
  assert.equal(legacy.frames.length, legacyFrames, "a bridge without fs never receives fs frames");

  // another user's conversation and a missing one: 404, for every route
  assert.equal((await st(codeConv, otherTok)).status, 404);
  assert.equal((await get(`/code/preview/tree?conversationId=${codeConv}`, otherTok)).status, 404);
  assert.equal((await get(`/code/preview/file?conversationId=${codeConv}&path=index.html`, otherTok)).status, 404);
  assert.equal((await st(randomUUID())).status, 404);
});

test("paths the server refuses never reach the bridge", async () => {
  const before = pc.frames.length;
  const bad = [
    "..", "a/../b", "../x", "/etc/passwd", "C:/x", "C:x", "a\\b", "\\\\server\\share",
    ".env", "a/.env", ".git/config", "node_modules/x", "a/node_modules", "a/./b", "a//b", "a/",
    "x\u0000y", "a\u0007b", "a:stream", "x".repeat(501),
  ];
  for (const p of bad) {
    const q = encodeURIComponent(p);
    const t = await get(`/code/preview/tree?conversationId=${codeConv}&path=${q}`);
    assert.equal(t.status, 400, `tree ${JSON.stringify(p)}`);
    assert.equal(t.json.code, "bad_path");
    const f = await get(`/code/preview/file?conversationId=${codeConv}&path=${q}`);
    assert.equal(f.status, 400, `file ${JSON.stringify(p)}`);
    assert.equal(f.json.code, "bad_path");
  }
  // a file request without a path is refused too (the folder itself is not a file)
  assert.equal((await get(`/code/preview/file?conversationId=${codeConv}`)).status, 400);
  assert.equal(pc.frames.length, before, "no fs frame was sent for a refused path");
});

test("bridge failures: timeout, bridge-reported error, oversized content, disconnect", async () => {
  pc.cfg.respond = (m) => {
    if (m.path === "slow.txt") return undefined;
    if (m.path === "err.txt") return { ok: false, error: "no such file" };
    if (m.path === "big.bin") return { ok: true, content: "A".repeat(4 * 1024 * 1024 + 4) };
    return defaultRespond(m);
  };
  try {
    const t0 = Date.now();
    const slow = await get(`/code/preview/file?conversationId=${codeConv}&path=slow.txt`);
    assert.equal(slow.status, 504);
    assert.equal(slow.json.code, "timeout");
    assert.ok(Date.now() - t0 < 2000, "the timeout (300 ms here) applies");

    const err = await get(`/code/preview/file?conversationId=${codeConv}&path=err.txt`);
    assert.equal(err.status, 502);
    assert.equal(err.json.code, "bridge_error");
    assert.equal(err.json.error, "no such file");

    const big = await get(`/code/preview/file?conversationId=${codeConv}&path=big.bin`);
    assert.equal(big.status, 413);
    assert.equal(big.json.code, "too_large");
  } finally {
    pc.cfg.respond = defaultRespond;
  }

  // a bridge that drops while a request is pending fails that request at once (not by the timeout)
  const drop = await fakeBridge("drop", true);
  drop.cfg.respond = () => undefined;
  const dropConv = await mkConv("drop", "code");
  const pending = get(`/code/preview/tree?conversationId=${dropConv}`);
  await until(() => drop.frames.length > 0);
  const t1 = Date.now();
  drop.close();
  const r = await pending;
  assert.equal(r.status, 409);
  assert.equal(r.json.reason, "bridge_offline");
  assert.ok(Date.now() - t1 < 250, "failed on disconnect, not on timeout");
});

test("response headers, truncation and content type", async () => {
  pc.cfg.respond = (m) => {
    if (m.path === "cut.txt") return { ok: true, content: b64("abc"), truncated: true };
    if (m.path === "data.xyz") return { ok: true, content: b64("zz"), mime: "text/html" };
    if (m.path === "evil.xyz") return { ok: true, content: b64("zz"), mime: "application/x-evil" };
    if (m.path === "img.png") return { ok: true, content: b64("zz"), mime: "text/html" };
    return defaultRespond(m);
  };
  try {
    const cut = await get(`/code/preview/file?conversationId=${codeConv}&path=cut.txt`);
    assert.equal(cut.status, 200);
    assert.equal(cut.headers.get("x-truncated"), "1");
    assert.equal(cut.headers.get("x-content-type-options"), "nosniff");
    assert.equal(cut.headers.get("cache-control"), "no-store");
    assert.equal(cut.headers.get("content-security-policy"), "sandbox");
    assert.match(cut.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(cut.text, "abc");

    const whole = await get(`/code/preview/file?conversationId=${codeConv}&path=index.html`);
    assert.equal(whole.headers.get("x-truncated"), null);

    // unknown extension: the bridge mime only when it is on the allow list
    assert.match((await get(`/code/preview/file?conversationId=${codeConv}&path=data.xyz`)).headers.get("content-type") ?? "", /^text\/html/);
    assert.equal((await get(`/code/preview/file?conversationId=${codeConv}&path=evil.xyz`)).headers.get("content-type"), "application/octet-stream");
    // a known extension wins over the bridge's mime
    assert.match((await get(`/code/preview/file?conversationId=${codeConv}&path=img.png`)).headers.get("content-type") ?? "", /^image\/png/);
  } finally {
    pc.cfg.respond = defaultRespond;
  }
});

test("maintenance mode does not stop preview", async () => {
  const on = await api("PUT", "/admin/maintenance", { enabled: true });
  assert.equal(on.status, 200, "admin can turn maintenance on");
  try {
    const f = await get(`/code/preview/file?conversationId=${codeConv}&path=index.html`);
    assert.equal(f.status, 200);
    assert.equal((await get(`/code/preview/status?conversationId=${codeConv}`)).json.available, true);
  } finally {
    await api("PUT", "/admin/maintenance", { enabled: false });
  }
});

test("rate limit: 20 requests per second per user", async () => {
  // a fresh user with no real conversation: each request still spends a token before the lookup
  // sent together, so the bucket cannot refill much while they arrive
  const results = await Promise.all(Array.from({ length: 30 }, () => get(`/code/preview/tree?conversationId=${randomUUID()}`, rateTok, false)));
  const statuses = results.map((r) => r.status);
  const limited = results.find((r) => r.status === 429)?.json;
  const n429 = statuses.filter((s) => s === 429).length;
  const n404 = statuses.filter((s) => s === 404).length;
  assert.equal(n404 + n429, 30);
  assert.ok(n429 >= 1, "some requests are limited");
  assert.ok(n404 >= 20 && n404 <= 24, `about 20 requests pass (got ${n404})`);
  assert.equal(limited?.code, "rate_limited");
});
