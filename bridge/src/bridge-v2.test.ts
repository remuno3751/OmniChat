import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Bridge } from "./bridge.js";
import { CORDIS, SECRET, appendFrame, asst, header, rec, sessionFile, tmpDir, userMsg } from "./testutil.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh.mjs");

type Msg = Record<string, any>;

async function setup(opts: { mirror?: boolean; withModels?: boolean } = {}) {
  const home = tmpDir();
  const cwd = path.resolve(tmpDir(), "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const cordis = path.join(home, "profiles", "headless", "cordis.patch.yml");
  if (opts.withModels !== false) {
    fs.mkdirSync(path.dirname(cordis), { recursive: true });
    fs.writeFileSync(cordis, CORDIS);
  }
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
    mirror: opts.mirror,
    pollMs: 40,
    fetchImpl: async () => { throw new Error("no upstream in tests"); },
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
    warn: () => {},
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
  return { home, cwd, cordis, bridge, waitFor, waitConn, close };
}

const send = (c: { ws: WebSocket }, m: Msg) => c.ws.send(JSON.stringify(m));

test("ready carries models/defaultModel; models frame on file change; no secret on the wire", async () => {
  const t = await setup();
  try {
    const c = await t.waitConn();
    const ready = await t.waitFor(c, (m) => m.type === "ready");
    assert.equal(ready.defaultModel, "opencodex::lm-studio/lfm2.5-24b-a2b");
    assert.equal(ready.models.length, 3);
    assert.deepEqual(ready.models[1], { provider: "opencodex", id: "gpt-5.5", name: "gpt-5.5 (native)" });

    const future = new Date(Date.now() + 10000);
    fs.writeFileSync(t.cordis, CORDIS.replace("- id: m1", "- id: m2"));
    fs.utimesSync(t.cordis, future, future);
    const upd = await t.waitFor(c, (m) => m.type === "models");
    assert.ok(upd.models.some((m: Msg) => m.id === "m2"));
    assert.equal(upd.defaultModel, "opencodex::lm-studio/lfm2.5-24b-a2b");

    const wire = JSON.stringify(c.msgs);
    assert.ok(!wire.includes(SECRET) && !wire.includes("SUPER-SECRET") && !wire.includes("127.0.0.1:10100") && !wire.includes("Authorization"));
  } finally {
    await t.close();
  }
});

test("run.model writes an overlay passed after the user patch, then removes it", async () => {
  const t = await setup();
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "m1", sessionId: null, prompt: "PATCHES", model: "opencodex::gpt-5.5" });
    const d = await t.waitFor(c, (m) => m.type === "done" && m.runId === "m1");
    assert.equal(d.ok, true);
    const ev = c.msgs.find((m) => m.type === "event" && m.runId === "m1" && m.event.type === "patches")!.event;
    assert.equal(ev.files.length, 2);
    assert.match(ev.files[0].text, /lfm2\.5/); // user's patch first
    assert.match(ev.files[1].text, /provider: opencodex/);
    assert.match(ev.files[1].text, /model: gpt-5\.5/);
    assert.equal(fs.existsSync(ev.files[1].file), false, "temp overlay removed");

    // bare id uses the provider known for it; no model -> only the user's patch
    send(c, { type: "run", runId: "m2", sessionId: null, prompt: "PATCHES", model: "m1" });
    await t.waitFor(c, (m) => m.type === "done" && m.runId === "m2");
    const ev2 = c.msgs.find((m) => m.type === "event" && m.runId === "m2" && m.event.type === "patches")!.event;
    assert.match(ev2.files[1].text, /provider: other/);
    send(c, { type: "run", runId: "m3", sessionId: null, prompt: "PATCHES" });
    await t.waitFor(c, (m) => m.type === "done" && m.runId === "m3");
    const ev3 = c.msgs.find((m) => m.type === "event" && m.runId === "m3" && m.event.type === "patches")!.event;
    assert.equal(ev3.files.length, 1);
  } finally {
    await t.close();
  }
});

test("mirror: full on connect, deltas as the GUI appends, busy refusal", async () => {
  const t = await setup();
  try {
    const f = sessionFile(t.home, "--slug--", "session-gui");
    appendFrame(f, [header("session-gui", t.cwd), rec(1, 10, "turn/start", { turn: 1 }), userMsg(2, 11, "from gui"), rec(3, 12, "session/title", { title: "T" })]);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(f, old, old);

    const c = await t.waitConn();
    const full = await t.waitFor(c, (m) => m.type === "sessions");
    assert.equal(full.full, true);
    assert.equal(full.sessions[0].sessionId, "session-gui");
    assert.equal(full.sessions[0].title, "T");
    assert.deepEqual(full.sessions[0].messages.map((m: Msg) => m.key), ["u:1:0"]);

    appendFrame(f, [asst(4, 20, 1, 1, [{ type: "text", text: "hi from gui" }])]);
    const delta = await t.waitFor(c, (m) => m.type === "sessions" && m.full === false);
    assert.deepEqual(delta.sessions[0].messages.map((m: Msg) => [m.key, m.status, m.text]), [["a:1", "streaming", "hi from gui"]]);

    // log changed just now (GUI writing) -> refuse; our own idle -> busy error
    send(c, { type: "run", runId: "b1", sessionId: "session-gui", prompt: "x" });
    const busy = await t.waitFor(c, (m) => m.type === "done" && m.runId === "b1");
    assert.deepEqual([busy.ok, busy.error], [false, "session busy in dsh"]);

    // once quiet, a run on that session is accepted
    fs.utimesSync(f, old, old);
    send(c, { type: "run", runId: "b2", sessionId: "session-gui", prompt: "x" });
    assert.equal((await t.waitFor(c, (m) => m.type === "done" && m.runId === "b2")).ok, true);
  } finally {
    await t.close();
  }
});

test("--no-mirror sends no sessions frames", async () => {
  const t = await setup({ mirror: false });
  try {
    appendFrame(sessionFile(t.home, "s", "session-q"), [header("session-q", t.cwd), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, "x")]);
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.msgs.some((m) => m.type === "sessions"), false);
  } finally {
    await t.close();
  }
});
