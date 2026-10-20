import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Bridge } from "./bridge.js";
import { CORDIS, tmpDir } from "./testutil.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh.mjs");

type Msg = Record<string, any>;

// Same shape as the rewind tests in bridge-v4.test.ts, with the preview switch set by the caller.
async function setup(previewFs: boolean | undefined) {
  const home = tmpDir();
  const cwd = path.resolve(tmpDir(), "ws");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "index.html"), "<p>hi</p>");
  fs.mkdirSync(path.join(cwd, "sub"));
  fs.writeFileSync(path.join(cwd, "sub", "a.css"), "p{}");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
  const cordis = path.join(home, "profiles", "headless", "cordis.patch.yml");
  fs.mkdirSync(path.dirname(cordis), { recursive: true });
  fs.writeFileSync(cordis, CORDIS);
  const userPatch = path.join(home, "user-overlay.yml");
  fs.writeFileSync(userPatch, "- id: agent-default-model\n  config:\n    provider: opencodex\n    model: lm-studio/lfm2.5-24b-a2b\n");

  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const conns: Array<{ ws: WebSocket; msgs: Msg[]; waiters: Array<() => void> }> = [];
  wss.on("connection", (ws) => {
    const c = { ws, msgs: [] as Msg[], waiters: [] as Array<() => void> };
    conns.push(c);
    ws.on("message", (d) => {
      c.msgs.push(JSON.parse(d.toString()));
      c.waiters.splice(0).forEach((f) => f());
    });
  });
  const bridge = new Bridge({
    serverUrl: `http://127.0.0.1:${port}`,
    getToken: async () => "tok",
    name: "test-pc",
    cwd,
    dsh: { appDir: "X:\\none", profile: "headless", patch: userPatch, command: process.execPath, commandArgs: [fake] },
    dshHome: home,
    mirror: false,
    pollMs: 40,
    fetchImpl: async () => { throw new Error("no upstream in tests"); },
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    warn: () => {},
    previewFs,
  });
  bridge.start();
  const waitFor = async (c: (typeof conns)[number], pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = c.msgs.find(pred);
      if (m) return m;
      if (Date.now() > deadline) throw new Error("timeout; got " + JSON.stringify(c.msgs).slice(0, 2000));
      await new Promise<void>((r) => { c.waiters.push(r); setTimeout(r, 50); });
    }
  };
  const waitConn = async () => {
    const deadline = Date.now() + 8000;
    while (conns.length < 1) {
      if (Date.now() > deadline) throw new Error("no connection");
      await new Promise((r) => setTimeout(r, 20));
    }
    return conns[0];
  };
  const close = async () => {
    bridge.stop();
    wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => wss.close(r));
  };
  return { home, cwd, bridge, waitFor, waitConn, close };
}

const send = (c: { ws: WebSocket }, m: Msg) => c.ws.send(JSON.stringify(m));
const fsReq = (c: { ws: WebSocket }, requestId: string, cwd: string, op: string, p?: unknown, extra: Msg = {}) =>
  send(c, { type: "fs", requestId, cwd, op, ...(p === undefined ? {} : { path: p }), ...extra });

test("preview off (default): ready has no capabilities, and fs is refused", async () => {
  const t = await setup(undefined);
  try {
    const c = await t.waitConn();
    const ready = await t.waitFor(c, (m) => m.type === "ready");
    assert.equal("capabilities" in ready, false, "frame is the same as before");
    fsReq(c, "f1", t.cwd, "list", "");
    const r = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "f1");
    assert.deepEqual(r, { type: "fs_result", requestId: "f1", ok: false, error: "preview is disabled on this bridge" });
  } finally {
    await t.close();
  }
});

test("preview on: ready advertises fs, list and read work, and the rules hold", async () => {
  const t = await setup(true);
  try {
    const c = await t.waitConn();
    const ready = await t.waitFor(c, (m) => m.type === "ready");
    assert.deepEqual(ready.capabilities, { fs: true });

    fsReq(c, "l1", t.cwd, "list", "");
    const l = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "l1");
    assert.equal(l.ok, true);
    const names = (l.entries as Array<{ name: string }>).map((e) => e.name);
    assert.deepEqual(names, ["sub", "index.html"], "hidden .env is not listed; dirs first");

    fsReq(c, "r1", t.cwd, "read", "index.html");
    const r = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r1");
    assert.equal(r.ok, true);
    assert.equal(Buffer.from(r.content, "base64").toString("utf8"), "<p>hi</p>");
    assert.equal(r.mime, "text/html");
    assert.equal(r.size, 9);
    assert.equal(r.truncated, false);

    fsReq(c, "r2", t.cwd, "read", ".env");
    const env = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r2");
    assert.equal(env.ok, false);
    assert.equal(env.content, undefined);

    fsReq(c, "r3", t.cwd, "read", "../../etc/passwd");
    const up = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r3");
    assert.equal(up.ok, false);
    assert.equal(String(up.error).includes(t.cwd), false, "error text never contains the full path");

    fsReq(c, "r4", t.cwd, "read", "sub", {});
    const dir = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r4");
    assert.deepEqual([dir.ok, dir.error], [false, "not a file"]);

    fsReq(c, "r5", t.cwd, "delete", "index.html");
    const bad = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r5");
    assert.deepEqual([bad.ok, bad.error], [false, "invalid op"]);

    fsReq(c, "r6", t.cwd, "read", 42 as unknown as string);
    const typed = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "r6");
    assert.equal(typed.ok, false);
  } finally {
    await t.close();
  }
});

test("preview on: a cwd that is not the bridge working directory is refused", async () => {
  const t = await setup(true);
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    fsReq(c, "w1", path.resolve(tmpDir(), "elsewhere"), "list", "");
    const r = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "w1");
    assert.deepEqual([r.ok, r.error], [false, "cwd does not match the bridge working directory"]);
    send(c, { type: "fs", requestId: "w2", op: "list", path: "" });
    const none = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "w2");
    assert.equal(none.ok, false, "missing cwd is refused");
  } finally {
    await t.close();
  }
});

test("preview on: more than 20 requests in a second are refused as too many requests", async () => {
  const t = await setup(true);
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    for (let i = 0; i < 25; i++) fsReq(c, `burst-${i}`, t.cwd, "list", "");
    await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "burst-24");
    const results = c.msgs.filter((m) => m.type === "fs_result" && String(m.requestId).startsWith("burst-"));
    assert.equal(results.length, 25);
    const refused = results.filter((m) => m.error === "too many requests");
    assert.ok(refused.length >= 5, `refused ${refused.length}`);
    assert.ok(results.filter((m) => m.ok).length <= 20);
  } finally {
    await t.close();
  }
});

test("preview on: fs answers while a run is in progress (read only)", async () => {
  const t = await setup(true);
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "fs-slow", sessionId: null, prompt: "SLOW" });
    await t.waitFor(c, (m) => m.type === "event" && m.runId === "fs-slow");
    fsReq(c, "busy-1", t.cwd, "read", "index.html");
    const r = await t.waitFor(c, (m) => m.type === "fs_result" && m.requestId === "busy-1");
    assert.equal(r.ok, true, JSON.stringify(r));
    send(c, { type: "cancel", runId: "fs-slow" });
    await t.waitFor(c, (m) => m.type === "done" && m.runId === "fs-slow");
  } finally {
    await t.close();
  }
});
