import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { Bridge } from "./bridge.js";
import { CORDIS, tmpDir } from "./testutil.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh.mjs");

type Msg = Record<string, any>;

async function setup() {
  const home = tmpDir();
  const cwd = path.resolve(tmpDir(), "ws");
  fs.mkdirSync(cwd, { recursive: true });
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

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with one committed file, tracked.txt = "a\nb\nc\n". */
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "tracked.txt"), "a\nb\nc\n");
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
}

/** Prompt that modifies tracked.txt (+2/-1) and creates new.txt. */
const EDIT_PROMPT = "WRITE:tracked.txt=a\\nX\\nY\\nc\\n;new.txt=hi";

test("git run: checkpoint before events, changes before done, user git state untouched", async () => {
  const t = await setup();
  try {
    initRepo(t.cwd);
    const head = git(t.cwd, ["rev-parse", "HEAD"]);
    const branch = git(t.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const stash = git(t.cwd, ["stash", "list"]);
    const indexBefore = fs.readFileSync(path.join(t.cwd, ".git", "index"));

    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "g1", sessionId: null, prompt: EDIT_PROMPT });
    const done = await t.waitFor(c, (m) => m.type === "done" && m.runId === "g1");
    assert.equal(done.ok, true, JSON.stringify(done));
    const msgs = c.msgs;

    const cpIdx = msgs.findIndex((m) => m.type === "checkpoint" && m.requestId === "g1");
    assert.ok(cpIdx >= 0);
    const cp = msgs[cpIdx];
    assert.equal(typeof cp.checkpointId, "string");
    assert.equal(cp.ref, `refs/omnichat/checkpoints/${cp.checkpointId}`);
    assert.equal(cp.dirty, false);
    assert.equal(typeof cp.createdAt, "number");
    git(t.cwd, ["rev-parse", "--verify", cp.ref]); // throws if the ref is missing

    const eventIdx = msgs.flatMap((m, i) => (m.type === "event" && m.runId === "g1" ? [i] : []));
    assert.ok(eventIdx.length > 0);
    for (const i of eventIdx) assert.ok(i > cpIdx, "checkpoint must precede every event");

    const doneIdx = msgs.indexOf(done);
    const chIdx = msgs.findIndex((m) => m.type === "changes" && m.requestId === "g1");
    assert.ok(chIdx > 0 && chIdx < doneIdx, "changes frame must precede done");
    const changes = msgs[chIdx].changes as Msg[];
    assert.equal(changes.length, 2, JSON.stringify(changes));
    const tr = changes.find((x) => x.path === "tracked.txt")!;
    assert.deepEqual([tr.status, tr.additions, tr.deletions], ["modified", 2, 1]);
    assert.match(tr.patch, /\+X/);
    const nw = changes.find((x) => x.path === "new.txt")!;
    assert.deepEqual([nw.status, nw.additions, nw.deletions], ["added", 1, 0]);

    assert.equal(git(t.cwd, ["rev-parse", "HEAD"]), head);
    assert.equal(git(t.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
    assert.equal(git(t.cwd, ["stash", "list"]), stash);
    assert.deepEqual(fs.readFileSync(path.join(t.cwd, ".git", "index")), indexBefore);
  } finally {
    await t.close();
  }
});

test("non-git cwd: unavailable checkpoint, empty changes, done carries a warning", async () => {
  const t = await setup();
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "n1", sessionId: null, prompt: "hello" });
    const done = await t.waitFor(c, (m) => m.type === "done" && m.runId === "n1");
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.warning, "not a git repository");
    const cp = c.msgs.find((m) => m.type === "checkpoint" && m.requestId === "n1")!;
    assert.equal(cp.unavailable, "not a git repository");
    assert.equal(cp.checkpointId, undefined);
    const ch = c.msgs.find((m) => m.type === "changes" && m.requestId === "n1")!;
    assert.deepEqual(ch.changes, []);
    assert.ok(c.msgs.indexOf(ch) < c.msgs.indexOf(done));
  } finally {
    await t.close();
  }
});

test("rewind: restores files, refuses wrong cwd, invalid ref and a run in progress", async () => {
  const t = await setup();
  try {
    initRepo(t.cwd);
    const tracked = path.join(t.cwd, "tracked.txt");
    const newFile = path.join(t.cwd, "new.txt");
    const original = fs.readFileSync(tracked);

    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "r-run", sessionId: null, prompt: EDIT_PROMPT });
    await t.waitFor(c, (m) => m.type === "done" && m.runId === "r-run");
    const ref = c.msgs.find((m) => m.type === "checkpoint" && m.requestId === "r-run")!.ref as string;
    assert.notDeepEqual(fs.readFileSync(tracked), original);

    send(c, { type: "rewind", requestId: "w-cwd", ref, cwd: tmpDir() });
    const wrongCwd = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-cwd");
    assert.equal(wrongCwd.ok, false);
    assert.equal(wrongCwd.error, "cwd does not match the bridge working directory");

    send(c, { type: "rewind", requestId: "w-bad", ref: "refs/heads/main", cwd: t.cwd });
    const badRef = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-bad");
    assert.deepEqual([badRef.ok, badRef.error], [false, "invalid ref"]);

    send(c, { type: "rewind", requestId: "w-type", ref: 42, cwd: t.cwd });
    const typeRef = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-type");
    assert.deepEqual([typeRef.ok, typeRef.error], [false, "invalid ref"]);

    send(c, { type: "rewind", requestId: "w-keep", ref, cwd: t.cwd });
    const keep = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-keep");
    assert.equal(keep.ok, true, JSON.stringify(keep));
    assert.equal(keep.restored, 1, "checkpoint tree holds only tracked.txt");
    assert.ok(keep.backupRef.startsWith("refs/omnichat/checkpoints/"));
    assert.deepEqual(fs.readFileSync(tracked), original);
    assert.equal(fs.existsSync(newFile), true, "new file kept without removeNew");

    send(c, { type: "rewind", requestId: "w-rm", ref, cwd: t.cwd, removeNew: true });
    const rm = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-rm");
    assert.equal(rm.ok, true, JSON.stringify(rm));
    assert.equal(rm.removed, 1);
    assert.deepEqual(fs.readFileSync(tracked), original);
    assert.equal(fs.existsSync(newFile), false, "new file removed with removeNew");
  } finally {
    await t.close();
  }
});

test("rewind while a run is in progress is refused; a run starting now is busy", async () => {
  const t = await setup();
  try {
    initRepo(t.cwd);
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "slow-1", sessionId: null, prompt: "SLOW" });
    await t.waitFor(c, (m) => m.type === "event" && m.runId === "slow-1");
    const ref = c.msgs.find((m) => m.type === "checkpoint" && m.requestId === "slow-1")!.ref as string;

    // a second run while the first is active, and a rewind, are both refused
    send(c, { type: "run", runId: "slow-2", sessionId: null, prompt: "x" });
    const busy = await t.waitFor(c, (m) => m.type === "done" && m.runId === "slow-2");
    assert.deepEqual([busy.ok, busy.error], [false, "busy"]);

    send(c, { type: "rewind", requestId: "w-busy", ref, cwd: t.cwd });
    const rw = await t.waitFor(c, (m) => m.type === "rewound" && m.requestId === "w-busy");
    assert.deepEqual([rw.ok, rw.error], [false, "a run is in progress"]);

    send(c, { type: "cancel", runId: "slow-1" });
    const done = await t.waitFor(c, (m) => m.type === "done" && m.runId === "slow-1");
    assert.equal(done.ok, false);
    assert.equal(done.error, "cancelled");
  } finally {
    await t.close();
  }
});

test("agents: sub-agent running then done, last agents frame before done", async () => {
  const t = await setup();
  try {
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    send(c, { type: "run", runId: "a1", sessionId: null, prompt: "SUBAGENT" });
    const done = await t.waitFor(c, (m) => m.type === "done" && m.runId === "a1");
    assert.equal(done.ok, true, JSON.stringify(done));
    const frames = c.msgs.filter((m) => m.type === "agents" && m.requestId === "a1");
    assert.ok(frames.length >= 2, JSON.stringify(frames));
    const first = frames[0].agents[0];
    assert.deepEqual([first.id, first.role, first.status], ["sa1", "helper", "running"]);
    const last = frames[frames.length - 1];
    assert.deepEqual([last.agents[0].status, last.agents[0].summary], ["done", "helper says hi"]);
    assert.ok(c.msgs.indexOf(last) < c.msgs.indexOf(done), "last agents frame precedes done");
  } finally {
    await t.close();
  }
});

test("a second run sent while the first is still starting gets busy", async () => {
  const t = await setup();
  try {
    initRepo(t.cwd);
    const c = await t.waitConn();
    await t.waitFor(c, (m) => m.type === "ready");
    // both messages arrive back to back; the second must see the first as starting or active
    send(c, { type: "run", runId: "e1", sessionId: null, prompt: "SLOW" });
    send(c, { type: "run", runId: "e2", sessionId: null, prompt: "x" });
    const busy = await t.waitFor(c, (m) => m.type === "done" && m.runId === "e2");
    assert.deepEqual([busy.ok, busy.error], [false, "busy"]);
    assert.equal(c.msgs.some((m) => m.type === "checkpoint" && m.requestId === "e2"), false);

    await t.waitFor(c, (m) => m.type === "event" && m.runId === "e1");
    send(c, { type: "cancel", runId: "e1" });
    await t.waitFor(c, (m) => m.type === "done" && m.runId === "e1");
    // once the first run has ended, a new run is accepted again
    send(c, { type: "run", runId: "e3", sessionId: null, prompt: "x" });
    assert.equal((await t.waitFor(c, (m) => m.type === "done" && m.runId === "e3")).ok, true);
  } finally {
    await t.close();
  }
});
