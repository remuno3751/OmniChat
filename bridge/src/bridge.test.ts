import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Bridge } from "./bridge.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh.mjs");

type Msg = Record<string, any>;

async function setup() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const conns: Array<{ ws: WebSocket; url: string; msgs: Msg[]; waiters: Array<() => void> }> = [];
  wss.on("connection", (ws, req) => {
    const c = { ws, url: req.url ?? "", msgs: [] as Msg[], waiters: [] as Array<() => void> };
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
    cwd: os.tmpdir(),
    dsh: { appDir: "X:\\none", profile: "headless", command: process.execPath, commandArgs: [fake] },
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    fetchImpl: async () => { throw new Error("no upstream in tests"); },
  });
  bridge.start();
  const waitFor = async (c: (typeof conns)[number], pred: (m: Msg) => boolean, ms = 8000): Promise<Msg> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = c.msgs.find(pred);
      if (m) return m;
      if (Date.now() > deadline) throw new Error("timeout waiting for message; got " + JSON.stringify(c.msgs));
      await new Promise<void>((r) => { c.waiters.push(r); setTimeout(r, 100); });
    }
  };
  const waitConn = async (n: number) => {
    const deadline = Date.now() + 8000;
    while (conns.length < n) {
      if (Date.now() > deadline) throw new Error("no connection " + n);
      await new Promise((r) => setTimeout(r, 20));
    }
    return conns[n - 1];
  };
  const close = async () => {
    bridge.stop();
    wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => wss.close(r));
  };
  return { wss, bridge, conns, waitFor, waitConn, close };
}

const send = (c: { ws: WebSocket }, m: Msg) => c.ws.send(JSON.stringify(m));

test("ready, run -> events -> done, busy, cancel, reconnect", async () => {
  const t = await setup();
  try {
    const c1 = await t.waitConn(1);
    assert.match(c1.url, /^\/bridge\?/);
    assert.match(c1.url, /token=tok/);
    assert.match(c1.url, /name=test-pc/);
    const ready = await t.waitFor(c1, (m) => m.type === "ready");
    assert.equal(ready.name, "test-pc");
    assert.equal(ready.cwd, os.tmpdir());

    // normal run
    send(c1, { type: "run", runId: "r1", sessionId: null, prompt: "hi" });
    const d1 = await t.waitFor(c1, (m) => m.type === "done" && m.runId === "r1");
    assert.equal(d1.ok, true);
    assert.equal(d1.sessionId, "session-fake-1");
    assert.equal(d1.error, undefined);
    const evs = c1.msgs.filter((m) => m.type === "event" && m.runId === "r1").map((m) => m.event);
    assert.equal(evs[0].type, "session");
    assert.ok(evs.some((e) => e.type === "text" && e.text === "echo:hi"));
    assert.equal(c1.msgs.filter((m) => m.type === "done" && m.runId === "r1").length, 1);

    // resume passes sessionId through
    send(c1, { type: "run", runId: "r1b", sessionId: "session-abc", prompt: "again" });
    const d1b = await t.waitFor(c1, (m) => m.type === "done" && m.runId === "r1b");
    assert.equal(d1b.sessionId, "session-abc");

    // failure
    send(c1, { type: "run", runId: "rf", sessionId: null, prompt: "FAIL" });
    const df = await t.waitFor(c1, (m) => m.type === "done" && m.runId === "rf");
    assert.equal(df.ok, false);
    assert.ok(df.error);

    // busy + cancel
    send(c1, { type: "run", runId: "r2", sessionId: null, prompt: "SLOW" });
    await t.waitFor(c1, (m) => m.type === "event" && m.runId === "r2" && m.event.type === "text");
    send(c1, { type: "run", runId: "r3", sessionId: null, prompt: "x" });
    const busy = await t.waitFor(c1, (m) => m.type === "done" && m.runId === "r3");
    assert.deepEqual([busy.ok, busy.error], [false, "busy"]);
    send(c1, { type: "cancel", runId: "r2" });
    const d2 = await t.waitFor(c1, (m) => m.type === "done" && m.runId === "r2");
    assert.deepEqual([d2.ok, d2.error], [false, "cancelled"]);

    // reconnect after server closes
    c1.ws.close();
    const c2 = await t.waitConn(2);
    await t.waitFor(c2, (m) => m.type === "ready");
    send(c2, { type: "run", runId: "r4", sessionId: null, prompt: "back" });
    assert.equal((await t.waitFor(c2, (m) => m.type === "done" && m.runId === "r4")).ok, true);
  } finally {
    await t.close();
  }
});
