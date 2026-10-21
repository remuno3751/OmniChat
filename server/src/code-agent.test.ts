// VS Code Code agent (docs/design/VSCODE-BRIDGE.md S5, S8, S9): scripted model + fake extension, in process.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

process.env.DB_PATH = ":memory:";
const bridges = await import("./bridges.js");
const auth = await import("./auth.js");
const dbm = await import("./db.js");
const chat = await import("./chat.js");
const hub = await import("./hub.js");
const approvals = await import("./tools/approvals.js");
const providers = await import("./providers/index.js");
const projects = await import("./projects.js");
const agent = await import("./code-agent.js");
import type { StreamItem, StreamRequest } from "./providers/index.js";

let server: Server;
let port = 0;
let userId = "";
let token = "";
let vsProvId = "";
let modelProvId = "";
const frames: any[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};

/* ---- scripted model: one entry per upstream request ---- */
type Round = StreamItem[] | ((req: StreamRequest) => StreamItem[]);
let script: Round[] = [];
let requests: StreamRequest[] = [];
const call = (name: string, args: unknown, id = "t" + randomUUID().slice(0, 6)): StreamItem => ({ kind: "tool_calls", calls: [{ id, name, arguments: JSON.stringify(args) }] });
providers.registerProvider("scripted", () => ({
  async *stream(req: StreamRequest) {
    requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const r = script[Math.min(requests.length - 1, script.length - 1)];
    const items = typeof r === "function" ? r(req) : r;
    for (const it of items) { if (req.signal.aborted) return; yield it; await sleep(1); }
  },
}));

/* ---- fake extension ---- */
class Ext {
  frames: any[] = [];
  ws!: WebSocket;
  /** answers tool calls; return null to stay silent */
  tools: (f: any, x: Ext) => any = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 });
  constructor(readonly name: string, readonly instance: string) {}
  async connect(over: Record<string, unknown> = {}) {
    const q = new URLSearchParams({ token, name: this.name, kind: "vscode", instance: this.instance });
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
    this.ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); this.frames.push(f); this.react(f); });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    this.send({
      type: "ready", kind: "vscode", name: this.name, instance: this.instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0",
      platform: "linux", shell: "bash", remote: null, cwd: "/work/app", workspaces: ["/work/app"], allowAnyCwd: false, trusted: true,
      capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: false, tools: ["read_file", "list_dir", "edit_file", "write_file", "run_command", "git_commit"] },
      ...over,
    });
    await until(() => this.of("welcome").length > 0);
    return this;
  }
  react(f: any) {
    if (f.type === "run") {
      this.send({ type: "checkpoint", requestId: f.runId, checkpointId: "cp-" + f.runId, ref: "refs/omnichat/checkpoints/" + f.runId, createdAt: 1, dirty: false });
      this.send({ type: "run_ack", runId: f.runId, ok: true });
    } else if (f.type === "tool_call") {
      const r = this.tools(f, this);
      if (r) this.send({ type: "tool_result", runId: f.runId, callId: f.callId, ...r });
    } else if (f.type === "run_end") {
      this.send({ type: "changes", requestId: f.runId, changes: [{ path: "a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ p" }], truncated: false });
      this.send({ type: "done", runId: f.runId, ok: true });
    } else if (f.type === "cancel") {
      this.send({ type: "done", runId: f.runId, ok: false, error: "cancelled" });
    }
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  close() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

let ext: Ext;
let seqN = 0;

before(async () => {
  const u = await auth.createUserDirect("agentuser", "password123", false);
  userId = u.userId;
  token = auth.createDevice(userId, "VS Code (t)", "vscode-ext").token;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
  // a fake browser connection that records every broadcast frame (tool_approval, tool, phase, ...)
  hub.addConn(userId, { readyState: 1, OPEN: 1, send: (d: string) => { frames.push(JSON.parse(d)); }, on() { /* no-op */ } } as any);
  vsProvId = randomUUID();
  modelProvId = randomUUID();
  const ins = dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)");
  ins.run(vsProvId, userId, "VS", "vscode-bridge", "pcA", "", "", Date.now(), dbm.nextSeq());
  ins.run(modelProvId, userId, "Model", "scripted", "http://unused", "m1", "", Date.now(), dbm.nextSeq());
  ext = await new Ext("pcA", "i1").connect();
});
after(() => { ext?.close(); server.close(); server.closeAllConnections?.(); });

function mkConv(over: { approvalMode?: string; model?: string | null; cwd?: string | null } = {}): string {
  const id = randomUUID();
  const now = Date.now();
  dbm.db.prepare(
    "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd, approval_mode) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)",
  ).run(id, userId, "New chat", vsProvId, over.model === undefined ? `${modelProvId}::m1` : over.model, now, now, dbm.nextSeq(), "append", "code", over.cwd === undefined ? "/work/app" : over.cwd, over.approvalMode ?? null);
  return id;
}

/** Sends one user message and waits for the assistant message to leave "streaming". */
async function turn(conv: string, rounds: Round[], opts: { waitFor?: () => boolean } = {}) {
  script = rounds; requests = [];
  const userMessageId = randomUUID(), assistantMessageId = "m" + ++seqN + randomUUID().slice(0, 6);
  const p = chat.handleSend(userId, { conversationId: conv, content: "do it", userMessageId, assistantMessageId }, () => undefined);
  return { assistantMessageId, p, async done() { await p; await until(() => dbm.getMessageRow(assistantMessageId)?.status !== "streaming"); return dbm.toMessage(dbm.getMessageRow(assistantMessageId)); }, opts };
}
const toolMsgs = (i: number) => requests[i].messages.filter((m) => m.role === "tool");
const approvalFrames = () => frames.filter((f) => f.type === "tool_approval");
const resetExt = () => { ext.frames.length = 0; ext.tools = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 }); };

test("multi-round tool use: auto mode, results fed back, trace + phases + checkpoint + changes persisted", async () => {
  resetExt();
  const conv = mkConv({ approvalMode: "auto" });
  const t = await turn(conv, [
    [{ kind: "text", text: "Looking." }, call("read_file", { path: "src/a.ts" })],
    [call("edit_file", { path: "src/a.ts", oldString: "a", newString: "b" })],
    ["All done."],
  ]);
  const m = await t.done();
  assert.equal(m.status, "done");
  assert.match(m.content, /Looking\.\n\nAll done\./);
  assert.equal(requests.length, 3);
  assert.match(String(requests[0].messages[0].content), /Workspace root: \/work\/app/);
  assert.equal(requests[0].tools?.length, 6); // only the tools this window advertises
  assert.equal(toolMsgs(1).length, 1);
  assert.deepEqual(JSON.parse(toolMsgs(1)[0].content), { echo: "read_file" });
  assert.deepEqual(JSON.parse(toolMsgs(2)[1].content), { echo: "edit_file" });
  const sent = ext.of("tool_call");
  assert.deepEqual(sent.map((f) => f.tool), ["read_file", "edit_file"]);
  assert.deepEqual(sent[0].approval, { by: "mode:auto", protectedOk: false });
  assert.equal(ext.of("run")[0].checkpoint, true);
  assert.equal(ext.of("run")[0].approvalMode, "auto");
  assert.equal(ext.of("run_end").length, 1);
  assert.equal(m.toolCalls?.length, 2);
  assert.deepEqual(m.toolCalls?.map((c) => [c.name, c.status, c.decidedBy]), [["read_file", "done", "mode:auto"], ["edit_file", "done", "mode:auto"]]);
  assert.ok(m.phases?.some((p) => p.phase === "tool" && p.end !== null));
  assert.equal(m.changes?.[0].path, "a.ts");
  const cp = dbm.db.prepare("SELECT * FROM checkpoints WHERE message_id = ?").get(t.assistantMessageId) as any;
  assert.equal(cp.bridge, "pcA");
  assert.equal(cp.cwd, "/work/app");
  assert.match(cp.ref, /^refs\/omnichat\/checkpoints\//);
  assert.ok(frames.some((f) => f.type === "checkpoint" && f.messageId === t.assistantMessageId));
});

test("tool errors reach the model as 'ERROR <code>: <message>'; bad arguments / unknown tools never reach the extension", async () => {
  resetExt();
  ext.tools = () => ({ ok: false, error: { code: "not_found", message: "no such file" } });
  const conv = mkConv({ approvalMode: "auto" });
  const t = await turn(conv, [
    [call("read_file", { path: "nope.ts" })],
    [{ kind: "tool_calls", calls: [{ id: "x1", name: "read_file", arguments: "{oops" }, { id: "x2", name: "rm_rf", arguments: "{}" }] }],
    ["ok"],
  ]);
  const m = await t.done();
  assert.equal(m.status, "done");
  assert.equal(toolMsgs(1)[0].content, "ERROR not_found: no such file");
  assert.match(toolMsgs(2).find((x) => x.tool_call_id === "x1")?.content ?? "", /^ERROR invalid_args:/);
  assert.match(toolMsgs(2).find((x) => x.tool_call_id === "x2")?.content ?? "", /^ERROR unsupported:/);
  assert.equal(ext.of("tool_call").length, 1);
  assert.deepEqual(m.toolCalls?.map((c) => c.status), ["error", "error", "error"]);
});

test("round limit (OMNICHAT_CODE_MAX_ROUNDS) stops with an explanatory message", async () => {
  resetExt();
  process.env.OMNICHAT_CODE_MAX_ROUNDS = "3";
  try {
    const t = await turn(mkConv({ approvalMode: "auto" }), [[call("read_file", { path: "a" })]]);
    const m = await t.done();
    assert.equal(m.status, "done");
    assert.equal(requests.length, 3);
    assert.equal(ext.of("tool_call").length, 3);
    assert.match(m.content, /round limit of 3/);
  } finally { delete process.env.OMNICHAT_CODE_MAX_ROUNDS; }
  assert.equal(agent.codeMaxRounds(), 50);
  process.env.OMNICHAT_CODE_MAX_ROUNDS = "9999";
  assert.equal(agent.codeMaxRounds(), 200);
  delete process.env.OMNICHAT_CODE_MAX_ROUNDS;
});

test("wall clock limit stops the loop", async () => {
  resetExt();
  process.env.OMNICHAT_CODE_MAX_MS = "50";
  try {
    ext.tools = (f, x) => { setTimeout(() => x.send({ type: "tool_result", runId: f.runId, callId: f.callId, ok: true, result: {}, truncated: false, durationMs: 1 }), 80); return null; };
    const m = await (await turn(mkConv({ approvalMode: "auto" }), [[call("read_file", { path: "a" })]])).done();
    assert.match(m.content, /time limit/);
    assert.equal(requests.length, 1);
  } finally { delete process.env.OMNICHAT_CODE_MAX_MS; }
});

test("stop cancels the run: cancel frame, message stopped", async () => {
  resetExt();
  ext.tools = () => null; // never answers
  const t = await turn(mkConv({ approvalMode: "auto" }), [[call("run_command", { command: "npm test" })]]);
  await until(() => ext.of("tool_call").length === 1).catch((e) => { throw new Error(e.message + " " + JSON.stringify(dbm.getMessageRow(t.assistantMessageId)) + JSON.stringify(ext.frames.map((f) => f.type))); });
  chat.handleStop(userId, t.assistantMessageId);
  const m = await t.done();
  assert.equal(m.status, "stopped");
  assert.equal(ext.of("cancel").length, 1);
  assert.equal(ext.of("run_end").length, 1);
  assert.equal(requests.length, 1);
});

test("context over 70%: the oldest tool results are elided, the newest kept", async () => {
  resetExt();
  const big = "x".repeat(4000);
  ext.tools = (f) => ({ ok: true, result: { text: big, n: f.callId }, truncated: false, durationMs: 1 });
  projects.saveSettings(userId, { contextLimits: { [`${modelProvId}::m1`]: 2500 } } as any);
  try {
    const t = await turn(mkConv({ approvalMode: "auto" }), [[call("read_file", { path: "1" })], [call("read_file", { path: "2" })], [call("read_file", { path: "3" })], ["end"]]);
    await t.done();
    const last = toolMsgs(3);
    assert.equal(last.length, 3);
    assert.match(last[0].content, /^\[result elided to save context: read_file/);
    assert.ok(last[2].content.includes(big.slice(0, 100)), "newest result kept");
  } finally { projects.saveSettings(userId, { contextLimits: null } as any); }
});

test("model resolution: missing / unusable model refuses with a clear message; bridge kinds are not models", async () => {
  resetExt();
  const a = await (await turn(mkConv({ approvalMode: "auto", model: null }), [["x"]])).done();
  assert.equal(a.status, "error");
  assert.match(a.content, /Choose a model/);
  const b = await (await turn(mkConv({ model: `${vsProvId}::m` }), [["x"]])).done();
  assert.equal(b.status, "error");
  assert.match(b.content, /cannot answer/);
  const c = await (await turn(mkConv({ cwd: null }), [["x"]])).done();
  assert.match(c.content, /No working folder/);
  assert.equal(requests.length, 0);
});

/* ---------------- approvals (S8) ---------------- */

async function approve(decision: "once" | "always" | "deny", from = approvalFrames().length): Promise<any> {
  await until(() => approvalFrames().length > from);
  const f = approvalFrames()[from];
  assert.ok(approvals.resolveApproval(userId, f.approvalId, decision));
  return f;
}

test("manual: an edit asks the user; allow once -> by:user; the card is not protected", async () => {
  resetExt();
  const from = approvalFrames().length;
  const t = await turn(mkConv(), [[call("edit_file", { path: "src/a.ts", oldString: "a", newString: "b" })], ["fine"]]);
  const card = await approve("once", from);
  assert.equal(card.tool, "edit_file");
  assert.equal(card.protected, undefined);
  const m = await t.done();
  assert.equal(m.status, "done");
  assert.deepEqual(ext.of("tool_call")[0].approval, { by: "user", protectedOk: false });
  assert.equal(m.toolCalls?.[0].decidedBy, "user");
  // server-originated card mirrored in VS Code and closed again
  assert.equal(ext.of("approval_pending").length, 1);
  assert.equal(ext.of("approval_pending")[0].protected, false);
  assert.equal(ext.of("approval_settled")[0].decidedBy, "user");
});

test("manual: reads run without asking; deny -> ERROR denied, extension never sees the call", async () => {
  resetExt();
  const from = approvalFrames().length;
  const t = await turn(mkConv(), [[call("read_file", { path: "a" })], [call("write_file", { path: "n.ts", content: "x" })], ["ok"]]);
  await approve("deny", from);
  const m = await t.done();
  assert.deepEqual(ext.of("tool_call").map((f) => f.tool), ["read_file"]);
  assert.deepEqual(ext.of("tool_call")[0].approval, { by: "mode:manual", protectedOk: false });
  assert.equal(toolMsgs(2).at(-1)?.content, "ERROR denied: denied by user");
  assert.equal(m.toolCalls?.[1].status, "denied");
  assert.equal(m.toolCalls?.[1].decidedBy, "user");
});

test("auto: allow-listed command runs; other commands ask", async () => {
  resetExt();
  const from = approvalFrames().length;
  const t = await turn(mkConv({ approvalMode: "auto" }), [[call("run_command", { command: "npm test -- foo" })], [call("run_command", { command: "make deploy" })], ["ok"]]);
  await approve("once", from);
  await t.done();
  const sent = ext.of("tool_call");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].approval.by, "mode:auto");
  assert.equal(sent[1].approval.by, "user");
  assert.equal(approvalFrames().length, from + 1);
});

test("full: automatic, but a protected path still asks; 'always' never creates a rule; protectedOk is set", async () => {
  resetExt();
  const before = Number((dbm.db.prepare("SELECT COUNT(*) n FROM approval_rules WHERE user_id = ?").get(userId) as any).n);
  const from = approvalFrames().length;
  const t = await turn(mkConv({ approvalMode: "full" }), [
    [call("write_file", { path: "src/ok.ts", content: "x" })],
    [call("write_file", { path: ".env", content: "SECRET=1" })],
    ["ok"],
  ]);
  const card = await approve("always", from);
  assert.equal(card.protected, true);
  assert.ok(card.reasons.length > 0);
  const m = await t.done();
  const sent = ext.of("tool_call");
  assert.deepEqual(sent[0].approval, { by: "mode:full", protectedOk: false });
  assert.deepEqual(sent[1].approval, { by: "user", protectedOk: true });
  assert.equal(approvalFrames().length, from + 1);
  assert.equal(Number((dbm.db.prepare("SELECT COUNT(*) n FROM approval_rules WHERE user_id = ?").get(userId) as any).n), before);
  assert.equal(m.toolCalls?.[1].decidedBy, "user");
  assert.equal(ext.of("approval_pending")[0].protected, true);
});

test("rules: deny rule wins (decidedBy rule:<id>); allow rule lowers a normal ask but not a protected one", async () => {
  resetExt();
  const denyId = randomUUID(), allowId = randomUUID();
  const addRule = (id: string, kind: string, pattern: string, action: string) =>
    dbm.db.prepare("INSERT INTO approval_rules (id, user_id, project_id, kind, pattern, action, created_at, note) VALUES (?,?,?,?,?,?,?,?)").run(id, userId, null, kind, pattern, action, Date.now(), null);
  addRule(denyId, "command", "rm *", "deny");
  addRule(allowId, "tool", "write_file", "allow");
  try {
    const from = approvalFrames().length;
    const t = await turn(mkConv(), [
      [call("run_command", { command: "rm tmp.txt" })],
      [call("write_file", { path: "src/x.ts", content: "x" })],
      [call("write_file", { path: "id_rsa", content: "k" })],
      ["done"],
    ]);
    await approve("deny", from); // only the protected write asks
    const m = await t.done();
    assert.equal(toolMsgs(1)[0].content, "ERROR denied: denied by rule");
    assert.equal(m.toolCalls?.[0].decidedBy, `rule:${denyId}`);
    assert.equal(m.toolCalls?.[0].status, "denied");
    assert.deepEqual(ext.of("tool_call").map((f) => f.approval.by), [`rule:${allowId}`]);
    assert.equal(m.toolCalls?.[2].status, "denied");
    assert.equal(approvalFrames().length, from + 1);
  } finally { dbm.db.prepare("DELETE FROM approval_rules WHERE user_id = ?").run(userId); }
});

test("approval timeout is recorded as decidedBy 'timeout' and the call time is not counted while waiting", async () => {
  resetExt();
  process.env.TOOL_APPROVAL_TIMEOUT_MS = "150";
  try {
    const m = await (await turn(mkConv(), [[call("write_file", { path: "a.ts", content: "x" })], ["ok"]])).done();
    assert.equal(m.toolCalls?.[0].decidedBy, "timeout");
    assert.equal(toolMsgs(1)[0].content, "ERROR denied: approval timed out");
    assert.equal(ext.of("tool_call").length, 0);
  } finally { delete process.env.TOOL_APPROVAL_TIMEOUT_MS; }
});

test("the VS Code panel can answer a server approval (approval_decision, first answer wins)", async () => {
  resetExt();
  const from = approvalFrames().length;
  const t = await turn(mkConv(), [[call("write_file", { path: "a.ts", content: "x" })], ["ok"]]);
  await until(() => ext.of("approval_pending").length === 1);
  ext.send({ type: "approval_decision", approvalId: ext.of("approval_pending")[0].approvalId, decision: "once" });
  const m = await t.done();
  assert.equal(m.toolCalls?.[0].status, "done");
  assert.equal(ext.of("approval_settled").length, 1);
  assert.equal(approvalFrames().length, from + 1); // the app card existed too; it was closed by the VS Code answer
  assert.equal(approvals.pendingApprovalCount(userId, m.conversationId), 0);
});

test("extension-originated approval: the user is asked as a protected item and the extension gets approval_reply", async () => {
  resetExt();
  const from = approvalFrames().length;
  ext.tools = (f, x) => {
    x.send({ type: "approval", requestId: f.runId, approvalId: "ext-a1", callId: f.callId, tool: f.tool, path: "/etc/hosts", reason: "outside workspace (symlink)" });
    return null; // the result follows after the reply
  };
  const t = await turn(mkConv({ approvalMode: "auto" }), [[call("read_file", { path: "link" })], ["ok"]]);
  const card = await approve("always", from);
  assert.equal(card.protected, true);
  assert.match(JSON.stringify(card.reasons), /symlink/);
  await until(() => ext.of("approval_reply").length === 1);
  assert.deepEqual(ext.of("approval_reply")[0], { type: "approval_reply", approvalId: "ext-a1", decision: "allowed-once" });
  const tc = ext.of("tool_call")[0];
  ext.send({ type: "tool_result", runId: tc.runId, callId: tc.callId, ok: true, result: { ok: 1 }, truncated: false, durationMs: 1 });
  const m = await t.done();
  assert.equal(m.status, "done");
  // a deny rule still rejects an extension escalation without asking
  dbm.db.prepare("INSERT INTO approval_rules (id, user_id, project_id, kind, pattern, action, created_at, note) VALUES (?,?,?,?,?,?,?,?)").run("r-deny", userId, null, "path", "/etc/*", "deny", Date.now(), null);
  try {
    resetExt();
    ext.tools = (f, x) => { x.send({ type: "approval", requestId: f.runId, approvalId: "ext-a2", callId: f.callId, tool: f.tool, path: "/etc/hosts", reason: "x" }); return null; };
    const t2 = await turn(mkConv({ approvalMode: "auto" }), [[call("read_file", { path: "link" })], ["ok"]]);
    await until(() => ext.of("approval_reply").length === 1);
    assert.equal(ext.of("approval_reply")[0].decision, "rejected");
    const tc2 = ext.of("tool_call")[0];
    ext.send({ type: "tool_result", runId: tc2.runId, callId: tc2.callId, ok: false, error: { code: "denied", message: "rejected" } });
    await t2.done();
  } finally { dbm.db.prepare("DELETE FROM approval_rules WHERE user_id = ?").run(userId); }
});
