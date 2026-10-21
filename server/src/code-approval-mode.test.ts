// VS Code bridge over the real server process: approval mode API (S6), checkpoint/changes storage and rewind routing (S9).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, connect, say, sleep, type Ctx } from "./test-chat-util.js";
import { openWs, startServer, api } from "./test-server.js";

let c: Ctx;
let vsProv = "";
before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  vsProv = randomUUID();
  const r = await c.call("PUT", `/providers/${vsProv}`, { name: "VS", kind: "vscode-bridge", baseUrl: "Box", model: "x" });
  assert.equal(r.status, 200);
});
after(() => { c?.s.stop(); c?.be.close(); });

const codeConv = async (): Promise<string> => {
  const id = randomUUID();
  const r = await c.call("PUT", `/conversations/${id}`, { providerId: vsProv, model: `${c.provId}::fake-model` });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, "code");
  return id;
};

test("approvalMode: default manual; validation; full needs confirmFull; Code conversations only", async () => {
  const id = await codeConv();
  const get = async () => (await c.call("GET", "/sync")).json.conversations.find((x: any) => x.id === id);
  assert.equal((await get()).approvalMode, "manual");
  let r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "auto" });
  assert.equal(r.status, 200);
  assert.equal(r.json.approvalMode, "auto");
  r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "full" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "confirm_required");
  assert.equal((await get()).approvalMode, "auto");
  r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "full", confirmFull: false });
  assert.equal(r.json.code, "confirm_required");
  r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "yolo" });
  assert.equal(r.status, 400);
  r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "full", confirmFull: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.approvalMode, "full");
  // other updates keep the mode
  r = await c.call("PUT", `/conversations/${id}`, { title: "renamed" });
  assert.equal(r.json.approvalMode, "full");
  r = await c.call("PUT", `/conversations/${id}`, { approvalMode: "manual" });
  assert.equal(r.json.approvalMode, "manual");
  // chat conversation: refused
  const chatId = randomUUID();
  await c.call("PUT", `/conversations/${chatId}`, { providerId: c.provId });
  r = await c.call("PUT", `/conversations/${chatId}`, { approvalMode: "auto" });
  assert.equal(r.status, 400);
  // a new Code conversation can start with an explicit mode, but never with an unconfirmed full
  const n = randomUUID();
  assert.equal((await c.call("PUT", `/conversations/${n}`, { providerId: vsProv, approvalMode: "full" })).json.code, "confirm_required");
  assert.equal((await c.call("PUT", `/conversations/${n}`, { providerId: vsProv, approvalMode: "auto" })).json.approvalMode, "auto");
});

test("the mode is never reset: not when the last client disconnects, not after a server restart", async () => {
  const id = await codeConv();
  assert.equal((await c.call("PUT", `/conversations/${id}`, { approvalMode: "full", confirmFull: true })).status, 200);
  const cl = await connect(c);
  cl.ws.close();
  await sleep(500);
  const mode = async (tok: string, base: string) => (await api(base, "GET", "/sync", undefined, tok)).json.conversations.find((x: any) => x.id === id).approvalMode;
  assert.equal(await mode(c.token, c.s.base), "full");
  // restart on the same data directory
  const old = c.s;
  const exited = new Promise((res) => old.child.once("exit", res));
  old.child.kill();
  await exited;
  const again = await startServer({}, old.tmp);
  c.s = again; // the following tests use the restarted server
  c.call = (m, p, b, t = c.token) => api(c.s.base, m, p, b, t);
  assert.equal(await mode(c.token, again.base), "full");
});

test("checkpoint + changes of a vscode run are stored; rewind goes to the extension; dirty_editors surfaces; refused while running", async () => {
  const t = (await c.call("POST", "/bridges/token", { name: "Box", kind: "vscode" })).json;
  const ws = await openWs(`${c.s.base.replace("http", "ws")}/bridge?token=${t.token}&name=Box&kind=vscode&instance=i1`);
  const got: any[] = [];
  let rewindAnswer: any = { ok: true };
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    got.push(f);
    const send = (o: unknown) => ws.send(JSON.stringify(o));
    if (f.type === "run") {
      send({ type: "checkpoint", requestId: f.runId, checkpointId: "cp1-" + f.runId, ref: "refs/omnichat/checkpoints/x", createdAt: 5, dirty: true });
      send({ type: "run_ack", runId: f.runId, ok: true });
    } else if (f.type === "run_end") {
      send({ type: "changes", requestId: f.runId, changes: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "p".repeat(300 * 1024) }], truncated: false });
      send({ type: "done", runId: f.runId, ok: true });
    } else if (f.type === "rewind") {
      send({ type: "rewound", requestId: f.requestId, ...rewindAnswer });
    }
  });
  ws.send(JSON.stringify({
    type: "ready", kind: "vscode", name: "Box", instance: "i1", version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0", platform: "linux", shell: "bash", remote: null,
    cwd: "/work/a", workspaces: ["/work/a"], allowAnyCwd: false, trusted: true,
    capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: false, tools: ["read_file"] },
  }));
  while (!got.some((f) => f.type === "welcome")) await sleep(10);

  const cl = await connect(c);
  const id = await codeConv();
  const { asst, assistantMessageId } = await say(c, cl, id, "hello", { cwd: "/work/a" });
  assert.equal(asst.status, "done", asst.content);
  assert.match(asst.content, /R:hello/);
  assert.equal(got.find((f) => f.type === "run").checkpoint, true);
  assert.equal(got.find((f) => f.type === "run").cwd, "/work/a");
  // changes: stored on the message, patch capped
  const ch = (await c.call("GET", `/messages/${assistantMessageId}/changes`)).json.changes;
  assert.equal(ch.length, 1);
  assert.ok(ch[0].patch.length <= 200 * 1024);
  const cps = (await c.call("GET", `/code/checkpoints?conversationId=${id}`)).json.checkpoints;
  assert.equal(cps.length, 1);
  assert.equal(cps[0].bridge, "Box");
  assert.equal(cps[0].cwd, "/work/a");
  assert.equal(cps[0].dirty, true);
  assert.equal(cps[0].messageId, assistantMessageId);

  let r = await c.call("POST", `/code/checkpoints/${cps[0].id}/rewind`, { removeNew: true });
  assert.equal(r.status, 200);
  const rw = got.find((f) => f.type === "rewind");
  assert.equal(rw.ref, "refs/omnichat/checkpoints/x");
  assert.equal(rw.cwd, "/work/a");
  assert.equal(rw.removeNew, true);
  rewindAnswer = { ok: false, error: "dirty_editors" };
  r = await c.call("POST", `/code/checkpoints/${cps[0].id}/rewind`, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "dirty_editors");
  rewindAnswer = { ok: false, error: "boom" };
  assert.equal((await c.call("POST", `/code/checkpoints/${cps[0].id}/rewind`, {})).status, 502);

  // while a run is active: refused
  c.be.slowMs = 400;
  const u = randomUUID(), a = randomUUID();
  cl.send({ type: "send", conversationId: id, content: "again", userMessageId: u, assistantMessageId: a });
  await sleep(150);
  r = await c.call("POST", `/code/checkpoints/${cps[0].id}/rewind`, {});
  assert.equal(r.status, 409);
  await cl.waitMsg(a, (m) => m.status !== "streaming", 8000);
  c.be.slowMs = 0;
  ws.terminate();
});
