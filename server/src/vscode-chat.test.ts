// Chat from inside VS Code (docs/design/VSCODE-BRIDGE.md S12): prompt / models / conversations / transcript / approval mode / stop.
// Scripted model + fake extension, in process (same style as code-agent.test.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

process.env.DB_PATH = ":memory:";
const bridges = await import("./bridges.js");
const auth = await import("./auth.js");
const dbm = await import("./db.js");
const hub = await import("./hub.js");
const approvals = await import("./tools/approvals.js");
const providers = await import("./providers/index.js");
await import("./vscode-chat.js");
import type { StreamItem, StreamRequest } from "./providers/index.js";

let server: Server;
let modelServer: Server;
let port = 0;
let userId = "";
let otherUserId = "";
let token = "";
let modelProvId = "";
let otherProvId = "";
const appFrames: any[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};

/* ---- scripted model ---- */
type Round = StreamItem[] | ((req: StreamRequest) => StreamItem[]);
let script: Round[] = [];
let requests: StreamRequest[] = [];
let streamDelay = 1;
const call = (name: string, args: unknown, id = "t" + randomUUID().slice(0, 6)): StreamItem => ({ kind: "tool_calls", calls: [{ id, name, arguments: JSON.stringify(args) }] });
providers.registerProvider("scripted", () => ({
  async *stream(req: StreamRequest) {
    requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const r = script[Math.min(requests.length - 1, script.length - 1)];
    const items = typeof r === "function" ? r(req) : r;
    for (const it of items) { if (req.signal.aborted) return; yield it; await sleep(streamDelay); }
  },
}));

/* ---- fake extension ---- */
class Ext {
  frames: any[] = [];
  times: number[] = [];
  ws!: WebSocket;
  tools: (f: any, x: Ext) => any = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 });
  constructor(readonly name: string, readonly instance: string, readonly cwd = "/work/app") {}
  async connect(caps: Record<string, unknown> = {}, tok = token) {
    const q = new URLSearchParams({ token: tok, name: this.name, kind: "vscode", instance: this.instance });
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
    this.ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); this.frames.push(f); this.times.push(Date.now()); this.react(f); });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    this.send({
      type: "ready", kind: "vscode", name: this.name, instance: this.instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0",
      platform: "linux", shell: "bash", remote: null, cwd: this.cwd, workspaces: [this.cwd], allowAnyCwd: false, trusted: true,
      capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: true, chat: true, tools: ["read_file", "list_dir", "edit_file", "write_file", "run_command"], ...caps },
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
      this.send({ type: "changes", requestId: f.runId, changes: [], truncated: false });
      this.send({ type: "done", runId: f.runId, ok: true });
    } else if (f.type === "cancel") {
      this.send({ type: "done", runId: f.runId, ok: false, error: "cancelled" });
    }
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  /** sends a chat frame and waits for the first reply frame of `replyType` with the same requestId */
  async ask(frame: Record<string, unknown>, replyType: string): Promise<any> {
    const from = this.frames.length;
    this.send(frame);
    await until(() => this.frames.slice(from).some((f) => f.type === replyType && f.requestId === frame.requestId));
    return this.frames.slice(from).find((f) => f.type === replyType && f.requestId === frame.requestId);
  }
  close() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

let ext: Ext;
let plain: Ext; // no chat capability, other folder
let n = 0;
const rid = () => "r" + ++n;
const resetExt = () => { requests = []; ext.frames.length = 0; ext.times.length = 0; ext.tools = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 }); };
const transcripts = (x: Ext = ext) => x.of("transcript");
const itemsOf = (kind: string, x: Ext = ext) => transcripts(x).flatMap((f) => f.items).filter((i: any) => i.kind === kind);
const prompt = (over: Record<string, unknown> = {}) =>
  ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "do it", model: `${modelProvId}::m1`, approvalMode: "auto", ...over }, "prompt_ack");
const settled = async (conversationId: string) => {
  await until(() => !dbm.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND status = 'streaming'").get(conversationId));
  await until(() => transcripts().some((f) => f.conversationId === conversationId && f.items.some((i: any) => i.kind === "assistant" && i.status !== "streaming")));
};

before(async () => {
  const u = await auth.createUserDirect("chatuser", "password123", false);
  userId = u.userId;
  otherUserId = (await auth.createUserDirect("otheruser", "password123", false)).userId;
  token = auth.createDevice(userId, "VS Code (t)", "vscode-ext").token;
  modelServer = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "mx" }, { id: "text-embedding-3" }] })); });
  await new Promise<void>((res) => modelServer.listen(0, "127.0.0.1", () => res()));
  const mport = (modelServer.address() as any).port;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
  hub.addConn(userId, { readyState: 1, OPEN: 1, send: (d: string) => { appFrames.push(JSON.parse(d)); }, on() { /* no-op */ } } as any);
  modelProvId = randomUUID();
  otherProvId = randomUUID();
  const ins = dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)");
  ins.run(modelProvId, userId, "Model", "scripted", "http://unused", "m1", "", Date.now(), dbm.nextSeq());
  ins.run(randomUUID(), userId, "Oai", "openai-compatible", `http://127.0.0.1:${mport}/v1`, "mx", "", Date.now(), dbm.nextSeq());
  ins.run(otherProvId, otherUserId, "Private", "scripted", "http://unused", "p1", "", Date.now(), dbm.nextSeq());
  ext = await new Ext("pcA", "i1").connect();
  plain = await new Ext("pcA", "i2", "/other").connect({ chat: false, transcript: false });
});
after(() => { ext?.close(); plain?.close(); server.close(); server.closeAllConnections?.(); modelServer.close(); });

test("no model chosen and none configured: prompt_ack no_model, nothing is created", async () => {
  resetExt();
  const a = await ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "hi" }, "prompt_ack");
  assert.deepEqual([a.ok, a.error], [false, "no_model"]);
  assert.equal(Number((dbm.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id = ?").get(userId) as any).n), 0);
  assert.equal(Number((dbm.db.prepare("SELECT COUNT(*) n FROM providers WHERE user_id = ? AND kind = 'vscode-bridge'").get(userId) as any).n), 0);
});

test("prompt: creates the provider + Code conversation, runs the turn, streams transcript frames; the app sees it too", async () => {
  resetExt();
  script = [[{ kind: "text", text: "Looking." }, call("read_file", { path: "src/a.ts" })], [call("edit_file", { path: "src/a.ts", oldString: "a", newString: "b" })], ["All done."]];
  requests = [];
  const a = await prompt({ text: "fix a" });
  assert.equal(a.ok, true);
  const cid = a.conversationId as string;
  assert.match(cid, /^c/);
  const prov = dbm.db.prepare("SELECT * FROM providers WHERE user_id = ? AND kind = 'vscode-bridge'").get(userId) as any;
  assert.equal(prov.base_url, "pcA");
  const conv = dbm.getConversationRow(cid);
  assert.deepEqual([conv.provider_id, conv.mode, conv.cwd, conv.model, conv.approval_mode], [prov.id, "code", "/work/app", `${modelProvId}::m1`, "auto"]);
  await settled(cid);

  const last = (kind: string, id?: string) => itemsOf(kind).filter((i: any) => !id || i.id === id).at(-1);
  const asst = itemsOf("assistant").filter((i: any) => i.status === "done").at(-1);
  assert.equal(asst.text, "Looking.\n\nAll done.");
  const user = last("user");
  assert.equal(user.text, "fix a");
  const toolIds = [...new Set(itemsOf("tool").map((i: any) => i.id))];
  assert.equal(toolIds.length, 2);
  for (const id of toolIds) assert.equal(last("tool", id).status, "done");
  assert.equal(last("tool", toolIds[0]).tool, "read_file");
  assert.match(last("tool", toolIds[0]).summary, /read_file src\/a\.ts/);
  assert.equal(last("tool", toolIds[0]).decidedBy, "mode:auto");
  assert.ok(transcripts().every((f) => f.conversationId === cid && !f.reset));
  assert.ok(transcripts().some((f) => typeof f.runId === "string" && f.runId));
  // the plain instance (no chat capability) received no transcript frames, and its chat frames are ignored
  assert.equal(transcripts(plain).length, 0);
  // the normal WS broadcast carries the same conversation
  assert.ok(appFrames.some((f) => f.type === "upsert" && f.conversations?.some((c: any) => c.id === cid)));
  assert.ok(appFrames.some((f) => f.type === "delta" && f.conversationId === cid));
  assert.equal(dbm.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(cid) && (dbm.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?").get(cid) as any).n, 2);
});

test("transcript frames are throttled to 10 per second per conversation", async () => {
  resetExt();
  streamDelay = 2;
  script = [Array.from({ length: 150 }, (_, i) => `w${i} `)];
  try {
    const a = await prompt();
    await settled(a.conversationId);
    const fr = transcripts();
    assert.ok(fr.length >= 2);
    for (let i = 1; i < ext.times.length; i++) { /* arrival gaps of consecutive transcript frames */ }
    const ts = ext.frames.map((f, i) => (f.type === "transcript" ? ext.times[i] : 0)).filter(Boolean);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= 80, `frames ${i - 1}/${i} only ${ts[i] - ts[i - 1]} ms apart`);
    const final = itemsOf("assistant").at(-1);
    assert.equal(final.status, "done");
    assert.equal(final.text.split(" ").filter(Boolean).length, 150);
  } finally { streamDelay = 1; }
});

test("models_request: tool-capable (openai-compatible) models of the user's providers only", async () => {
  resetExt();
  const m = await ext.ask({ type: "models_request", requestId: rid() }, "models");
  assert.ok(m.items.length >= 1);
  assert.ok(m.items.every((i: any) => /^[^:]+::.+/.test(i.ref) && i.label && i.provider === "Oai"));
  assert.ok(m.items.some((i: any) => i.ref.endsWith("::mx")));
  assert.ok(!m.items.some((i: any) => i.ref.includes(modelProvId)));
});

test("conversations_request lists this bridge's Code conversations for the folder (newest first); conversation_request returns the full history with reset", async () => {
  resetExt();
  const l = await ext.ask({ type: "conversations_request", requestId: rid(), cwd: "/work/app" }, "conversations");
  assert.ok(l.items.length >= 2);
  assert.deepEqual(Object.keys(l.items[0]).sort(), ["approvalMode", "cwd", "id", "title", "updatedAt"]);
  assert.ok(l.items.every((i: any) => i.cwd === "/work/app"));
  assert.ok(l.items[0].updatedAt >= l.items[1].updatedAt);
  assert.equal(l.items.find((i: any) => i.title === "fix a")?.approvalMode, "auto");
  const none = await ext.ask({ type: "conversations_request", requestId: rid(), cwd: "/elsewhere" }, "conversations");
  assert.deepEqual(none.items, []);
  // history of the first prompt
  const id = l.items.find((i: any) => i.title === "fix a").id;
  const t = await ext.ask({ type: "conversation_request", requestId: rid(), conversationId: id }, "transcript");
  assert.equal(t.reset, true);
  assert.equal(t.conversationId, id);
  assert.deepEqual(t.items.map((i: any) => i.kind), ["user", "tool", "tool", "assistant"]);
  assert.equal(t.items[0].text, "fix a");
  assert.deepEqual(t.items.slice(1, 3).map((i: any) => [i.tool, i.status]), [["read_file", "done"], ["edit_file", "done"]]);
  assert.equal(t.items[3].status, "done");
  assert.equal(t.items[3].text, "Looking.\n\nAll done.");
  // not found / foreign
  const nf = await ext.ask({ type: "conversation_request", requestId: rid(), conversationId: "nope" }, "error");
  assert.equal(nf.code, "not_found");
});

test("continuing a conversation: same conversationId, history reaches the model", async () => {
  resetExt();
  const conv = (dbm.db.prepare("SELECT id FROM conversations WHERE title = 'fix a'").get() as any).id;
  script = [["second answer"]];
  requests = [];
  const a = await prompt({ conversationId: conv, text: "and now b", approvalMode: undefined });
  assert.equal(a.ok, true);
  assert.equal(a.conversationId, conv);
  await settled(conv);
  assert.ok(requests[0].messages.some((m) => m.role === "user" && m.content === "fix a"));
  assert.ok(requests[0].messages.some((m) => m.role === "user" && m.content === "and now b"));
  assert.equal(dbm.getConversationRow(conv).approval_mode, "auto"); // kept
});

test("errors: workspace_not_open, forbidden_model, invalid frames, unknown conversation", async () => {
  resetExt();
  assert.equal((await prompt({ cwd: "/nowhere" })).error, "workspace_not_open");
  const fm = await prompt({ model: `${otherProvId}::p1` });
  assert.deepEqual([fm.ok, fm.error], [false, "forbidden_model"]);
  assert.equal((await prompt({ model: "garbage" })).error, "forbidden_model");
  assert.equal((await prompt({ text: "" })).error, "invalid_frame");
  assert.equal((await prompt({ text: "x".repeat(100 * 1024 + 1) })).error, "invalid_frame");
  assert.equal((await prompt({ cwd: "relative/path" })).error, "invalid_frame");
  assert.equal((await prompt({ conversationId: "c-unknown" })).error, "not_found");
  assert.equal((await prompt({ approvalMode: "yolo" })).error, "invalid_frame");
  assert.equal((await prompt({ approvalMode: "full" })).error, "confirm_required");
  const noId = await (async () => { const from = ext.frames.length; ext.send({ type: "prompt", cwd: "/work/app", text: "x" }); await until(() => ext.frames.length > from); return ext.frames.at(-1); })();
  assert.deepEqual([noId.type, noId.code], ["error", "invalid_frame"]);
  // a failed prompt created nothing new
  assert.equal(transcripts().length, 0);
  // a prompt from an instance without chat is ignored (no reply at all)
  plain.frames.length = 0;
  plain.send({ type: "prompt", requestId: "z1", cwd: "/other", text: "hi", model: `${modelProvId}::m1` });
  await sleep(100);
  assert.equal(plain.of("prompt_ack").length, 0);
});

test("full access on a prompt needs confirmFull", async () => {
  resetExt();
  script = [["ok"]];
  const a = await prompt({ approvalMode: "full", confirmFull: true });
  assert.equal(a.ok, true);
  assert.equal(dbm.getConversationRow(a.conversationId).approval_mode, "full");
  await settled(a.conversationId);
});

test("set_approval_mode: confirm_required for full, persisted + broadcast otherwise, not_found for others' conversations", async () => {
  resetExt();
  const conv = (dbm.db.prepare("SELECT id FROM conversations WHERE title = 'fix a'").get() as any).id;
  const need = await ext.ask({ type: "set_approval_mode", requestId: rid(), conversationId: conv, mode: "full" }, "approval_mode");
  assert.deepEqual([need.ok, need.error, need.conversationId], [false, "confirm_required", conv]);
  assert.equal(dbm.getConversationRow(conv).approval_mode, "auto");
  appFrames.length = 0;
  const ok = await ext.ask({ type: "set_approval_mode", requestId: rid(), conversationId: conv, mode: "full", confirmFull: true }, "approval_mode");
  assert.deepEqual([ok.ok, ok.mode], [true, "full"]);
  assert.equal(dbm.getConversationRow(conv).approval_mode, "full");
  assert.ok(appFrames.some((f) => f.type === "upsert" && f.conversations?.some((c: any) => c.id === conv && c.approvalMode === "full")));
  const back = await ext.ask({ type: "set_approval_mode", requestId: rid(), conversationId: conv, mode: "manual" }, "approval_mode");
  assert.equal(back.ok, true);
  assert.equal(dbm.getConversationRow(conv).approval_mode, null);
  const nf = await ext.ask({ type: "set_approval_mode", requestId: rid(), conversationId: "missing", mode: "auto" }, "approval_mode");
  assert.deepEqual([nf.ok, nf.error], [false, "not_found"]);
  // another user's conversation is not reachable
  const foreign = randomUUID();
  dbm.db.prepare("INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)")
    .run(foreign, otherUserId, "x", null, null, 1, 1, dbm.nextSeq(), "append", "code", "/work/app");
  assert.equal((await ext.ask({ type: "set_approval_mode", requestId: rid(), conversationId: foreign, mode: "auto" }, "approval_mode")).error, "not_found");
});

test("manual mode: the tool item shows pending while the approval waits, then done", async () => {
  resetExt();
  script = [[call("write_file", { path: "n.ts", content: "x" })], ["fine"]];
  const from = appFrames.length;
  const a = await prompt({ approvalMode: "manual" });
  await until(() => appFrames.slice(from).some((f) => f.type === "tool_approval")).catch((e) => { throw new Error(e.message + JSON.stringify(dbm.db.prepare("SELECT status,content FROM messages WHERE conversation_id = ?").all(a.conversationId)) + JSON.stringify(appFrames.slice(from).map((f) => f.type))); });
  await until(() => itemsOf("tool").some((i: any) => i.status === "pending"));
  assert.equal(ext.of("approval_pending").length, 1);
  const card = appFrames.slice(from).find((f) => f.type === "tool_approval");
  assert.ok(approvals.resolveApproval(userId, card.approvalId, "once"));
  await settled(a.conversationId);
  const t = itemsOf("tool").at(-1);
  assert.deepEqual([t.status, t.decidedBy], ["done", "user"]);
});

test("busy: a second prompt while a run is active; stop frame ends the run (assistant stopped)", async () => {
  resetExt();
  ext.tools = () => null; // the tool call never answers
  script = [[call("run_command", { command: "npm test" })]];
  const a = await prompt();
  assert.equal(a.ok, true);
  await until(() => ext.of("tool_call").length === 1);
  const b = await prompt({ conversationId: a.conversationId });
  assert.deepEqual([b.ok, b.error], [false, "busy"]);
  const c = await prompt(); // other conversation, same window
  assert.deepEqual([c.ok, c.error], [false, "busy"]);
  ext.send({ type: "stop", requestId: rid(), conversationId: a.conversationId });
  await until(() => ext.of("cancel").length === 1);
  await until(() => transcripts().some((f) => f.items.some((i: any) => i.kind === "assistant" && i.status === "stopped")));
  assert.equal(dbm.db.prepare("SELECT status FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(a.conversationId) && (dbm.db.prepare("SELECT status FROM messages WHERE conversation_id = ? AND role = 'assistant'").get(a.conversationId) as any).status, "stopped");
  // after the run the window is free again
  await until(() => !dbm.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND status = 'streaming'").get(a.conversationId));
  resetExt();
  script = [["ok"]];
  assert.equal((await prompt()).ok, true);
});

test("a failing model turn ends the transcript with an error status item", async () => {
  await sleep(300);
  resetExt();
  script = [() => { throw new Error("boom upstream"); }];
  const a = await prompt();
  assert.equal(a.ok, true);
  await until(() => transcripts().some((f) => f.items.some((i: any) => i.kind === "assistant" && i.status === "error")));
  assert.ok(itemsOf("status").some((i: any) => /boom upstream/.test(i.text)));
});

test("rate limit: more than 30 chat frames per second get an error frame {code: rate_limited}", async () => {
  await sleep(1100);
  resetExt();
  for (let i = 0; i < 45; i++) ext.send({ type: "models_request", requestId: "rl" + i });
  await until(() => ext.of("error").length > 0);
  assert.equal(ext.of("error")[0].code, "rate_limited");
  await until(() => ext.of("models").length >= 30);
  await sleep(200);
  assert.ok(ext.of("models").length <= 30);
});

/* ---- a user with only agent-bridge providers, then with an openai-compatible one; Windows folders ---- */
let bridgeOnlyUid = "";
let bridgeOnlyExt: Ext | null = null;
let bridgeOnlyOaiId = "";

test("only an agent-bridge provider: models is empty (no default), a prompt without model is refused with a readable no_model", async () => {
  const u = await auth.createUserDirect("bridgeonly", "password123", false);
  bridgeOnlyUid = u.userId;
  const tok = auth.createDevice(bridgeOnlyUid, "VS Code (t)", "vscode-ext").token;
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(randomUUID(), bridgeOnlyUid, "DSH", "dsh-bridge", "dsh-box", "dsh", "", Date.now(), dbm.nextSeq());
  bridgeOnlyExt = await new Ext("pcOnly", "i1", "/work/only").connect({}, tok);
  assert.deepEqual(bridgeOnlyExt.of("welcome")[0].features, ["chat"]);
  const m = await bridgeOnlyExt.ask({ type: "models_request", requestId: rid() }, "models");
  assert.deepEqual(m.items, []);
  assert.equal("defaultRef" in m, false);
  const a = await bridgeOnlyExt.ask({ type: "prompt", requestId: rid(), cwd: "/work/only", text: "hi" }, "prompt_ack");
  assert.deepEqual([a.ok, a.error], [false, "no_model"]);
  assert.equal(typeof a.message, "string");
  assert.match(a.message, /OpenAI-compatible/);
  assert.equal(a.conversationId, undefined);
  assert.equal(Number((dbm.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id = ?").get(bridgeOnlyUid) as any).n), 0);
});

test("after adding an openai-compatible provider: models lists its chat models only; defaultRef only when it is one of them", async () => {
  bridgeOnlyOaiId = randomUUID();
  const mport = (modelServer.address() as any).port;
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(bridgeOnlyOaiId, bridgeOnlyUid, "Local LLM", "openai-compatible", `http://127.0.0.1:${mport}/v1`, "mx", "", Date.now(), dbm.nextSeq());
  const m = await bridgeOnlyExt!.ask({ type: "models_request", requestId: rid() }, "models");
  assert.deepEqual(m.items, [{ ref: `${bridgeOnlyOaiId}::mx`, label: "mx", provider: "Local LLM" }]);
  assert.equal("defaultRef" in m, false);
  // no title/search model and no remembered model: a prompt without model is still refused
  const a = await bridgeOnlyExt!.ask({ type: "prompt", requestId: rid(), cwd: "/work/only", text: "hi" }, "prompt_ack");
  assert.deepEqual([a.ok, a.error], [false, "no_model"]);
  // a remembered model of this bridge that is not a listed model is not offered as default
  const convId = "c" + randomUUID();
  const vbProv = randomUUID();
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(vbProv, bridgeOnlyUid, "VS Code (PC bridge)", "vscode-bridge", "pcOnly", "vscode", "", Date.now(), dbm.nextSeq());
  dbm.db.prepare("INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)")
    .run(convId, bridgeOnlyUid, "Remembered", vbProv, `${modelProvId}::m1`, Date.now(), Date.now(), dbm.nextSeq(), "append", "code", "/work/only");
  assert.equal("defaultRef" in (await bridgeOnlyExt!.ask({ type: "models_request", requestId: rid() }, "models")), false);
  // the same bridge remembers a listed model: it becomes the default
  dbm.db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(`${bridgeOnlyOaiId}::mx`, convId);
  const m2 = await bridgeOnlyExt!.ask({ type: "models_request", requestId: rid() }, "models");
  assert.equal(m2.defaultRef, `${bridgeOnlyOaiId}::mx`);
  assert.equal(m2.items.length, 1);
});

test("Windows folder C:\\Users\\me\\proj: prompt, listing under any slash/case form, and transcript round trip", async () => {
  const cwd = "C:\\Users\\me\\proj";
  const w = await new Ext("winPc", "w1", cwd).connect();
  try {
    requests = [];
    script = [["win ok"]];
    const a = await w.ask({ type: "prompt", requestId: rid(), cwd, text: "hello win", model: `${modelProvId}::m1`, approvalMode: "auto" }, "prompt_ack");
    assert.equal(a.ok, true, JSON.stringify(a));
    const cid = a.conversationId as string;
    await until(() => w.of("transcript").some((f) => f.items.some((i: any) => i.kind === "assistant" && i.status === "done")));
    for (const q of [cwd, "c:/users/me/proj", "C:/Users/me/proj/"]) {
      const l = await w.ask({ type: "conversations_request", requestId: rid(), cwd: q }, "conversations");
      assert.deepEqual(l.items.map((i: any) => i.id), [cid], `listing for ${q}`);
      assert.equal(l.items[0].cwd, cwd);
      assert.equal(l.items[0].title, "hello win");
      assert.equal(typeof l.items[0].updatedAt, "number");
    }
    // a folder that only shares a name prefix is a different folder
    const other = await w.ask({ type: "conversations_request", requestId: rid(), cwd: "C:\\Users\\me\\pro" }, "conversations");
    assert.deepEqual(other.items, []);
    const t = await w.ask({ type: "conversation_request", requestId: rid(), conversationId: cid }, "transcript");
    assert.equal(t.reset, true);
    assert.deepEqual(t.items.map((i: any) => i.kind), ["user", "assistant"]);
    assert.equal(t.items[0].text, "hello win");
    assert.equal(t.items[1].status, "done");
    assert.equal(t.items[1].text, "win ok");
  } finally {
    w.close();
    bridgeOnlyExt?.close();
  }
});
