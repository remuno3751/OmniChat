// VS Code bridge transport (docs/design/VSCODE-BRIDGE.md S2, S3, S4, S11), in process: a fake extension talks to handleBridgeUpgrade.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";

process.env.DB_PATH = ":memory:";
const bridges = await import("./bridges.js");
const vb = await import("./vscode-bridge.js");
const auth = await import("./auth.js");

let server: Server;
let port = 0;
let userId = "";
let deviceId = "";
let token = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};

/** A scripted fake extension. `on` handlers see every server frame and may answer. */
class Ext {
  frames: any[] = [];
  closeCode: number | null = null;
  ws!: WebSocket;
  onFrame: (f: any, x: Ext) => void = () => undefined;
  constructor(readonly name: string, readonly instance: string) {}
  async connect(opts: { kind?: string | null; token?: string; ready?: Record<string, unknown> | null } = {}): Promise<this> {
    const kind = opts.kind === undefined ? "vscode" : opts.kind;
    const q = new URLSearchParams({ token: opts.token ?? token, name: this.name });
    if (kind) q.set("kind", kind);
    if (kind === "vscode") q.set("instance", this.instance);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
    this.ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); this.frames.push(f); this.onFrame(f, this); });
    this.ws.on("close", (code) => { this.closeCode = code; });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    if (opts.ready !== null) this.send(this.ready(opts.ready ?? {}));
    return this;
  }
  ready(over: Record<string, unknown> = {}) {
    return {
      type: "ready", kind: "vscode", name: this.name, instance: this.instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0",
      platform: "linux", shell: "bash", remote: null, cwd: "/work/app", workspaces: ["/work/app"], allowAnyCwd: false, trusted: true,
      capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: false, tools: ["read_file", "run_command"] },
      ...over,
    };
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  async waitFor(type: string, n = 1) { await until(() => this.of(type).length >= n); return this.of(type)[n - 1]; }
  close() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

/** Standard well-behaved extension: acks runs, answers tool calls with `{echo: tool}`, reports changes + done on run_end. */
function wellBehaved(x: Ext) {
  x.onFrame = (f) => {
    if (f.type === "run") {
      x.send({ type: "checkpoint", requestId: f.runId, checkpointId: "cp-" + f.runId, ref: "refs/omnichat/checkpoints/" + f.runId, createdAt: 1, dirty: false });
      x.send({ type: "run_ack", runId: f.runId, ok: true });
    } else if (f.type === "tool_call") {
      x.send({ type: "tool_result", runId: f.runId, callId: f.callId, ok: true, result: { echo: f.tool, args: f.args }, truncated: false, durationMs: 1 });
    } else if (f.type === "run_end") {
      x.send({ type: "changes", requestId: f.runId, changes: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "p" }], truncated: false });
      x.send({ type: "done", runId: f.runId, ok: true });
    } else if (f.type === "cancel") {
      x.send({ type: "done", runId: f.runId, ok: false, error: "cancelled" });
    }
  };
}

const open: Ext[] = [];
const mk = (name: string, instance: string) => { const x = new Ext(name, instance); open.push(x); return x; };

before(async () => {
  const u = await auth.createUserDirect("vsuser", "password123", false);
  userId = u.userId;
  const d = auth.createDevice(userId, "VS Code (t)", "vscode-ext");
  token = d.token; deviceId = d.deviceId;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
});
after(() => { for (const x of open) x.close(); server.close(); server.closeAllConnections?.(); });

test("ready -> welcome, listed with version/tools/compat", async () => {
  const x = mk("pc1", "i1");
  await x.connect();
  const w = await x.waitFor("welcome");
  assert.equal(w.protocol, 1);
  assert.equal(w.minExtensionVersion, vb.VSCODE_EXT_MIN_VERSION);
  assert.equal(typeof w.serverVersion, "string");
  assert.deepEqual(w.features, ["chat"]);
  const b = bridges.listBridges(userId).find((e: any) => e.name === "pc1") as any;
  assert.equal(b.kind, "vscode");
  assert.equal(b.version, "0.1.0");
  assert.equal(b.protocol, 1);
  assert.deepEqual(b.tools, ["read_file", "run_command"]);
  assert.equal(b.trusted, true);
  assert.equal(b.busy, false);
  assert.deepEqual(b.compat, { ok: true, minVersion: vb.VSCODE_EXT_MIN_VERSION });
  assert.deepEqual(b.workspaces, ["/work/app"]);
});

test("frames before ready are ignored; no welcome without ready", async () => {
  const x = mk("pc-early", "i1");
  await x.connect({ ready: null });
  x.send({ type: "workspaces", workspaces: ["/x"], allowAnyCwd: true });
  await sleep(100);
  assert.equal(x.of("welcome").length, 0);
  assert.ok(!bridges.listBridges(userId).some((e: any) => e.name === "pc-early"));
  x.send(x.ready());
  await x.waitFor("welcome");
});

test("two instances coexist and merge into one entry; cwd selects the instance", async () => {
  const a = mk("pc2", "ia"), b = mk("pc2", "ib");
  wellBehaved(a); wellBehaved(b);
  await a.connect({ ready: a.ready({ cwd: "/work/app", workspaces: ["/work/app"] }) });
  await b.connect({ ready: b.ready({ cwd: "/work/lib", workspaces: ["/work/lib", "/work/app2"], capabilities: { workspaces: true, tools: ["glob"] } }) });
  await a.waitFor("welcome"); await b.waitFor("welcome");
  const list = bridges.listBridges(userId).filter((e: any) => e.name === "pc2");
  assert.equal(list.length, 1);
  const e = list[0] as any;
  assert.deepEqual([...e.workspaces].sort(), ["/work/app", "/work/app2", "/work/lib"]);
  assert.equal(e.instances, 2);
  assert.deepEqual([...e.tools].sort(), ["glob", "read_file", "run_command"]);

  const run = await vb.openRun({ userId, bridge: "pc2", cwd: "/work/lib", conversationId: "c1" });
  assert.equal(run.instance, "ib");
  assert.equal(b.of("run").length, 1);
  assert.equal(a.of("run").length, 0);
  assert.equal((b.of("run")[0]).cwd, "/work/lib");
  await vb.closeRun(run);

  await assert.rejects(vb.openRun({ userId, bridge: "pc2", cwd: "/nowhere", conversationId: "c1" }), (err: any) => err.code === "workspace_not_open");
  await assert.rejects(vb.openRun({ userId, bridge: "nope", cwd: "/work/app", conversationId: "c1" }), (err: any) => err.code === "offline");
});

test("a reconnecting instance replaces the old connection (4000)", async () => {
  const a1 = mk("pc3", "same"), a2 = mk("pc3", "same");
  await a1.connect(); await a1.waitFor("welcome");
  await a2.connect(); await a2.waitFor("welcome");
  await until(() => a1.closeCode !== null);
  assert.equal(a1.closeCode, 4000);
  assert.equal(bridges.listBridges(userId).filter((e: any) => e.name === "pc3").length, 1);
  assert.equal((bridges.listBridges(userId).find((e: any) => e.name === "pc3") as any).instances, 1);
  // closing the replaced socket must not drop the new one
  await sleep(50);
  assert.equal(bridges.listBridges(userId).filter((e: any) => e.name === "pc3").length, 1);
});

test("dsh bridges are unchanged: no kind/instance, no welcome, no kind in the listing", async () => {
  const d = mk("dshpc", "");
  await d.connect({ kind: null, ready: null });
  d.send({ type: "ready", name: "dshpc", cwd: "C:\\work" });
  await sleep(100);
  assert.equal(d.of("welcome").length, 0);
  const e = bridges.listBridges(userId).find((x: any) => x.name === "dshpc") as any;
  assert.deepEqual(e, { name: "dshpc", cwd: "C:\\work", online: true, workspacesSupported: false, workspaces: [], allowAnyCwd: false });
  // a vscode bridge of the same name is a separate entry
  const v = mk("dshpc", "iv");
  await v.connect(); await v.waitFor("welcome");
  assert.equal(bridges.listBridges(userId).filter((x: any) => x.name === "dshpc").length, 2);
  // vscode needs a valid instance; unknown kinds are refused
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=${token}&name=zz&kind=vscode`);
    ws.once("open", res); ws.once("error", rej);
  }), /400/);
});

test("tool_call round trip with checkpoint/changes hooks", async () => {
  const x = mk("pc4", "i1");
  wellBehaved(x);
  await x.connect(); await x.waitFor("welcome");
  const seen: any = { cp: null, ch: null };
  const run = await vb.openRun({
    userId, bridge: "pc4", cwd: "/work/app", conversationId: "conv", approvalMode: "auto", roots: ["/work/app"],
    hooks: { onCheckpoint: (f) => { seen.cp = f; }, onChanges: (f) => { seen.ch = f; } },
  });
  const runFrame = x.of("run")[0];
  assert.deepEqual({ ...runFrame, runId: "-" }, { type: "run", runId: "-", conversationId: "conv", cwd: "/work/app", approvalMode: "auto", checkpoint: true, roots: ["/work/app"] });
  assert.equal(seen.cp.checkpointId, "cp-" + run.runId);
  const r = await run.callTool("read_file", { path: "a.ts" }, { approval: { by: "mode:manual", protectedOk: false } });
  assert.equal(r.ok, true);
  assert.deepEqual((r as any).result, { echo: "read_file", args: { path: "a.ts" } });
  const tc = x.of("tool_call")[0];
  assert.equal(tc.timeoutMs, 60_000);
  assert.deepEqual(tc.approval, { by: "mode:manual", protectedOk: false });
  // run_command waits timeoutMs + 10 s
  await run.callTool("run_command", { command: "ls", timeoutMs: 5000 });
  assert.equal(x.of("tool_call")[1].timeoutMs, 15_000);
  // a busy instance is listed as busy
  assert.equal((bridges.listBridges(userId).find((e: any) => e.name === "pc4") as any).busy, true);
  const done = await vb.closeRun(run);
  assert.equal(done.ok, true);
  assert.equal(seen.ch.changes[0].path, "a.ts");
  assert.equal((bridges.listBridges(userId).find((e: any) => e.name === "pc4") as any).busy, false);
  // late frames within the recent window still reach the hooks
  seen.ch = null;
  x.send({ type: "changes", requestId: run.runId, changes: [], truncated: false });
  await until(() => seen.ch !== null);
});

test("call timeout fails only that call; a late tool_result is dropped", async () => {
  const x = mk("pc5", "i1");
  const held: any[] = [];
  x.onFrame = (f, e) => {
    if (f.type === "run") { e.send({ type: "run_ack", runId: f.runId, ok: true }); }
    else if (f.type === "tool_call" && f.args.hold) held.push(f);
    else if (f.type === "tool_call") e.send({ type: "tool_result", runId: f.runId, callId: f.callId, ok: true, result: "fine", truncated: false, durationMs: 0 });
    else if (f.type === "run_end") e.send({ type: "done", runId: f.runId, ok: true });
  };
  await x.connect(); await x.waitFor("welcome");
  const run = await vb.openRun({ userId, bridge: "pc5", cwd: "/work/app", conversationId: "c" });
  const t0 = Date.now();
  const r = await run.callTool("read_file", { hold: true }, { timeoutMs: 80 });
  assert.equal(r.ok, false);
  assert.equal((r as any).error.code, "timeout");
  assert.ok(Date.now() - t0 < 2000);
  // late result of the timed-out call: nothing happens, the run keeps working
  x.send({ type: "tool_result", runId: held[0].runId, callId: held[0].callId, ok: true, result: "late", truncated: false, durationMs: 0 });
  const ok = await run.callTool("read_file", { path: "x" });
  assert.deepEqual((ok as any).result, "fine");
  await vb.closeRun(run);
});

test("disconnect fails the run and frees the instance", async () => {
  const x = mk("pc6", "i1");
  x.onFrame = (f, e) => { if (f.type === "run") e.send({ type: "run_ack", runId: f.runId, ok: true }); };
  await x.connect(); await x.waitFor("welcome");
  const run = await vb.openRun({ userId, bridge: "pc6", cwd: "/work/app", conversationId: "c" });
  const pending = run.callTool("read_file", { path: "slow" });
  await x.waitFor("tool_call");
  x.close();
  await assert.rejects(pending, (e: any) => e.code === "disconnected" && e.message === "Bridge 'pc6' disconnected during the run");
  const done = await run.done;
  assert.equal(done.ok, false);
  assert.match(done.error ?? "", /disconnected during the run/);
  await assert.rejects(run.callTool("read_file", {}), (e: any) => e.code === "closed");
  await until(() => !bridges.listBridges(userId).some((e: any) => e.name === "pc6"));
});

test("cancel: pending calls resolve as cancelled, extension gets cancel and ends the run", async () => {
  const x = mk("pc7", "i1");
  x.onFrame = (f, e) => {
    if (f.type === "run") e.send({ type: "run_ack", runId: f.runId, ok: true });
    else if (f.type === "cancel") {
      e.send({ type: "changes", requestId: f.runId, changes: [], truncated: false });
      e.send({ type: "done", runId: f.runId, ok: false, error: "cancelled" });
    }
  };
  await x.connect(); await x.waitFor("welcome");
  const run = await vb.openRun({ userId, bridge: "pc7", cwd: "/work/app", conversationId: "c" });
  const pending = run.callTool("run_command", { command: "sleep 100" });
  await x.waitFor("tool_call");
  run.cancel();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal((r as any).error.code, "cancelled");
  await x.waitFor("cancel");
  assert.equal(x.of("cancel").length, 1);
  const done = await vb.closeRun(run);
  assert.deepEqual(done, { ok: false, error: "cancelled" });
  // an abort signal cancels too
  const ac = new AbortController();
  const run2 = await vb.openRun({ userId, bridge: "pc7", cwd: "/work/app", conversationId: "c", signal: ac.signal });
  ac.abort();
  await run2.done;
  assert.equal(x.of("cancel").length, 2);
});

test("busy: one run per instance; extension-side busy is mapped too", async () => {
  const x = mk("pc8", "i1");
  wellBehaved(x);
  await x.connect(); await x.waitFor("welcome");
  const run = await vb.openRun({ userId, bridge: "pc8", cwd: "/work/app", conversationId: "c" });
  await assert.rejects(vb.openRun({ userId, bridge: "pc8", cwd: "/work/app", conversationId: "d" }), (e: any) => e.code === "busy");
  await vb.closeRun(run);
  // extension says busy / untrusted
  x.onFrame = (f, e) => { if (f.type === "run") e.send({ type: "run_ack", runId: f.runId, ok: false, error: "busy" }); };
  await assert.rejects(vb.openRun({ userId, bridge: "pc8", cwd: "/work/app", conversationId: "c" }), (e: any) => e.code === "busy");
  x.onFrame = (f, e) => { if (f.type === "run") e.send({ type: "run_ack", runId: f.runId, ok: false, error: "untrusted_workspace" }); };
  await assert.rejects(vb.openRun({ userId, bridge: "pc8", cwd: "/work/app", conversationId: "c" }), (e: any) => e.code === "untrusted_workspace");
  // the instance is free again after a refused run
  wellBehaved(x);
  await vb.closeRun(await vb.openRun({ userId, bridge: "pc8", cwd: "/work/app", conversationId: "c" }));
});

test("outdated extension: run refused with the spec message, compat.ok=false in the listing", async () => {
  const x = mk("pc9", "i1");
  wellBehaved(x);
  await x.connect({ ready: x.ready({ version: "0.0.9" }) });
  await x.waitFor("welcome");
  const b = bridges.listBridges(userId).find((e: any) => e.name === "pc9") as any;
  assert.deepEqual(b.compat, { ok: false, minVersion: vb.VSCODE_EXT_MIN_VERSION });
  await assert.rejects(
    vb.openRun({ userId, bridge: "pc9", cwd: "/work/app", conversationId: "c" }),
    (e: any) => e.code === "outdated" && e.message === `VS Code extension 0.0.9 is outdated (need >= ${vb.VSCODE_EXT_MIN_VERSION}). Update the .vsix.`,
  );
  assert.equal(x.of("run").length, 0);
  assert.ok(vb.compareVersions("0.10.0", "0.9.9") > 0 && vb.compareVersions("0.1.0-beta.1", "0.1.0") === 0 && vb.compareVersions("junk", "0.1.0") < 0);
});

test("extension-originated approval goes through the hook; the call timer is paused meanwhile", async () => {
  const x = mk("pc10", "i1");
  x.onFrame = (f, e) => {
    if (f.type === "run") e.send({ type: "run_ack", runId: f.runId, ok: true });
    else if (f.type === "tool_call") e.send({ type: "approval", requestId: f.runId, approvalId: "ap1", callId: f.callId, tool: f.tool, path: "/etc/hosts", reason: "outside workspace" });
    else if (f.type === "approval_reply") e.send({ type: "tool_result", runId: runIdOf(e), callId: callIdOf(e), ok: true, result: "ok", truncated: false, durationMs: 0 });
    else if (f.type === "run_end") e.send({ type: "done", runId: f.runId, ok: true });
  };
  const runIdOf = (e: Ext) => e.of("run")[0].runId;
  const callIdOf = (e: Ext) => e.of("tool_call")[0].callId;
  await x.connect(); await x.waitFor("welcome");
  let gotFrame: any = null;
  const run = await vb.openRun({ userId, bridge: "pc10", cwd: "/work/app", conversationId: "c", hooks: {
    onApproval: async (fr) => { gotFrame = fr; await sleep(200); return "allowed-once"; },
  } });
  // the call timeout (100 ms) is shorter than the approval wait (200 ms) but does not count it
  const r = await run.callTool("read_file", { path: "/etc/hosts" }, { timeoutMs: 100 });
  assert.equal(r.ok, true);
  assert.equal(gotFrame.path, "/etc/hosts");
  assert.deepEqual(x.of("approval_reply")[0], { type: "approval_reply", approvalId: "ap1", decision: "allowed-once" });
  await vb.closeRun(run);
});

test("revoked device closes the vscode socket with 4001", async () => {
  const d = auth.createDevice(userId, "VS Code (rev)", "vscode-ext");
  const x = mk("pc11", "i1");
  await x.connect({ token: d.token }); await x.waitFor("welcome");
  bridges.closeDeviceBridges(userId, d.deviceId);
  await until(() => x.closeCode !== null);
  assert.equal(x.closeCode, 4001);
});

void deviceId;
