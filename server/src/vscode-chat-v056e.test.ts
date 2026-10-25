// v0.5.6-E server side (docs/design/V056E-CONTRACT.md §1): checkpoints_request / checkpoint_restore, prompt with replaceLast,
// and the sources of an answer on the transcript. Scripted model + fake extension, in process (same style as vscode-chat.test.ts).
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
const providers = await import("./providers/index.js");
const chat = await import("./chat.js");
const transcript = await import("./vscode-transcript.js");
await import("./vscode-chat.js");
import type { StreamItem, StreamRequest } from "./providers/index.js";

let server: Server;
let port = 0;
let userId = "";
let otherUserId = "";
let token = "";
let modelProvId = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};

/* ---- scripted model ---- */
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
  tools: (f: any) => any = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 });
  /** the answer to the next `rewind` frames */
  rewindReply: { ok: boolean; error?: string } = { ok: true };
  constructor(readonly name: string, readonly instance: string, readonly cwd = "/work/app") {}
  async connect() {
    const q = new URLSearchParams({ token, name: this.name, kind: "vscode", instance: this.instance });
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
    this.ws.on("message", (raw) => { const f = JSON.parse(raw.toString()); this.frames.push(f); this.react(f); });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    this.send({
      type: "ready", kind: "vscode", name: this.name, instance: this.instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0",
      platform: "linux", shell: "bash", remote: null, cwd: this.cwd, workspaces: [this.cwd], allowAnyCwd: false, trusted: true,
      capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: true, chat: true, tools: ["read_file", "edit_file", "run_command"] },
    });
    await until(() => this.of("welcome").length > 0);
    return this;
  }
  react(f: any) {
    if (f.type === "run") {
      this.send({ type: "checkpoint", requestId: f.runId, checkpointId: "cp-" + f.runId, ref: "refs/omnichat/checkpoints/" + f.runId, createdAt: Date.now(), dirty: false });
      this.send({ type: "run_ack", runId: f.runId, ok: true });
    } else if (f.type === "tool_call") {
      const r = this.tools(f);
      if (r) this.send({ type: "tool_result", runId: f.runId, callId: f.callId, ...r });
    } else if (f.type === "run_end") {
      this.send({ type: "changes", requestId: f.runId, changes: [], truncated: false });
      this.send({ type: "done", runId: f.runId, ok: true });
    } else if (f.type === "cancel") {
      this.send({ type: "done", runId: f.runId, ok: false, error: "cancelled" });
    } else if (f.type === "rewind") {
      this.send({ type: "rewound", requestId: f.requestId, ...(this.rewindReply.ok ? { ok: true } : { ok: false, error: this.rewindReply.error }) });
    }
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  of(type: string) { return this.frames.filter((f) => f.type === type); }
  /** sends a chat frame and waits for the reply frame of `replyType` with the same requestId (or an error frame with it) */
  async ask(frame: Record<string, unknown>, replyType: string): Promise<any> {
    const from = this.frames.length;
    this.send(frame);
    const hit = (f: any) => f.requestId === frame.requestId && (f.type === replyType || f.type === "error");
    await until(() => this.frames.slice(from).some(hit));
    return this.frames.slice(from).find(hit);
  }
  close() { try { this.ws.terminate(); } catch { /* ignore */ } }
}

let ext: Ext;
let n = 0;
const rid = () => "r" + ++n;
const resetExt = () => { requests = []; ext.frames.length = 0; ext.tools = (f) => ({ ok: true, result: { echo: f.tool }, truncated: false, durationMs: 1 }); ext.rewindReply = { ok: true }; };
const prompt = (over: Record<string, unknown> = {}) =>
  ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "do it", model: `${modelProvId}::m1`, approvalMode: "auto", ...over }, "prompt_ack");
/** the run of a conversation has ended and its final answer is stored */
const settled = async (conversationId: string) => {
  await until(() => !dbm.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND status = 'streaming'").get(conversationId));
  await until(() => !chat.isGenerating(conversationId));
};
const history = async (conversationId: string) => (await ext.ask({ type: "conversation_request", requestId: rid(), conversationId }, "transcript")).items as any[];
const checkpoints = async (conversationId: string) => ext.ask({ type: "checkpoints_request", requestId: rid(), conversationId }, "checkpoints");
const restore = (conversationId: string, checkpointId: string, extra: Record<string, unknown> = {}) =>
  ext.ask({ type: "checkpoint_restore", requestId: rid(), conversationId, checkpointId, ...extra }, "checkpoint_restored");
/** a conversation of `owner` on a vscode-bridge provider of bridge `pcA` (no messages) */
function foreignConversation(owner: string): string {
  const prov = randomUUID();
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(prov, owner, "VS Code", "vscode-bridge", "pcA", "vscode", "", Date.now(), dbm.nextSeq());
  const id = "c" + randomUUID();
  dbm.db.prepare("INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)")
    .run(id, owner, "Other", prov, `${modelProvId}::m1`, Date.now(), Date.now(), dbm.nextSeq(), "append", "code", "/work/app");
  return id;
}
const cpRow = (id: string): any => dbm.db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id);
const count = (sql: string, ...args: string[]): number => Number((dbm.db.prepare(sql).get(...args) as any).n);

before(async () => {
  const u = await auth.createUserDirect("v56euser", "password123", false);
  userId = u.userId;
  otherUserId = (await auth.createUserDirect("v56eother", "password123", false)).userId;
  token = auth.createDevice(userId, "VS Code (v56e)", "vscode-ext").token;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
  hub.addConn(userId, { readyState: 1, OPEN: 1, send: () => { /* the app socket */ }, on() { /* no-op */ } } as any);
  modelProvId = randomUUID();
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(modelProvId, userId, "Model", "scripted", "http://unused", "m1", "", Date.now(), dbm.nextSeq());
  ext = await new Ext("pcA", "v1").connect();
});
after(() => { ext?.close(); server.close(); server.closeAllConnections?.(); });

test("checkpoints_request: newest first, prompt on one line cut to 120 characters, files, restorable, dirty", async () => {
  resetExt();
  script = [["first answer"]];
  const a = await prompt({ text: "first\n  question   with   breaks" });
  await settled(a.conversationId);
  await sleep(5);
  script = [["second answer"]];
  await prompt({ conversationId: a.conversationId, text: "x".repeat(150) });
  await settled(a.conversationId);
  const cid = a.conversationId as string;
  // the first answer changed two files; the second one's checkpoint is not restorable (no snapshot)
  const first = dbm.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at LIMIT 1").get(cid) as any;
  dbm.db.prepare("UPDATE messages SET changes = ? WHERE id = ?").run(JSON.stringify([{ path: "a.ts" }, { path: "b.ts" }]), first.id);
  const second = dbm.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(cid) as any;
  dbm.db.prepare("UPDATE checkpoints SET ref = NULL, unavailable = ? WHERE message_id = ?").run("not a git repository", second.id);
  dbm.db.prepare("UPDATE checkpoints SET dirty = 1 WHERE message_id = ?").run(second.id);
  const r = await checkpoints(cid);
  assert.equal(r.type, "checkpoints");
  assert.equal(r.conversationId, cid);
  assert.equal(r.items.length, 2);
  const [newest, oldest] = r.items;
  assert.deepEqual(Object.keys(newest).sort(), ["createdAt", "dirty", "files", "id", "messageId", "prompt", "restorable"]);
  assert.equal(newest.prompt, "x".repeat(120));
  assert.deepEqual([newest.restorable, newest.dirty, newest.files], [false, true, 0]);
  assert.equal(oldest.prompt, "first question with breaks");
  assert.deepEqual([oldest.restorable, oldest.dirty, oldest.files], [true, false, 2]);
  assert.equal(oldest.messageId, first.id);
  assert.ok(oldest.createdAt <= newest.createdAt);
});

test("checkpoints_request: not_found for a conversation of another user or a missing id; invalid without requestId", async () => {
  const foreign = foreignConversation(otherUserId);
  const f = await ext.ask({ type: "checkpoints_request", requestId: rid(), conversationId: foreign }, "checkpoints");
  assert.equal(f.type, "error");
  assert.equal(f.code, "not_found");
  assert.equal(f.requestId !== undefined, true);
  const missing = await ext.ask({ type: "checkpoints_request", requestId: rid(), conversationId: "cnope" }, "checkpoints");
  assert.equal(missing.code, "not_found");
  const bad = await ext.ask({ type: "checkpoints_request", conversationId: "cnope" }, "checkpoints");
  assert.equal(bad.code, "invalid_frame");
});

test("checkpoint_restore: restored through the bridge (ref, folder, removeNew); busy while a run is active", async () => {
  resetExt();
  script = [["ok"]];
  const a = await prompt({ text: "make it" });
  await settled(a.conversationId);
  const cid = a.conversationId as string;
  const cp = (await checkpoints(cid)).items[0];
  const done = await restore(cid, cp.id, { removeNew: true });
  assert.deepEqual([done.ok, done.error], [true, undefined]);
  const rewind = ext.of("rewind").at(-1);
  assert.deepEqual([rewind.cwd, rewind.removeNew], ["/work/app", true]);
  assert.equal(rewind.ref, cpRow(cp.id).ref);

  // a run in progress: the tool never answers, so the run stays active
  ext.tools = () => null;
  script = [[call("run_command", { command: "npm test" })]];
  const b = await prompt({ conversationId: cid, text: "long run" });
  await until(() => ext.of("tool_call").length >= 1);
  const busy = await restore(cid, cp.id);
  assert.deepEqual([busy.ok, busy.error], [false, "busy"]);
  ext.send({ type: "stop", requestId: rid(), conversationId: b.conversationId });
  await settled(cid);
});

test("checkpoint_restore: not_found (other conversation's checkpoint, unknown), unavailable, dirty_editors, failed with message", async () => {
  resetExt();
  script = [["ok"]];
  const a = await prompt({ text: "another" });
  await settled(a.conversationId);
  const cid = a.conversationId as string;
  const cp = (await checkpoints(cid)).items[0];
  const other = foreignConversation(userId);
  assert.equal((await restore(other, cp.id)).error, "not_found");
  assert.equal((await restore(cid, "cp-unknown")).error, "not_found");
  dbm.db.prepare("UPDATE checkpoints SET ref = NULL, unavailable = ? WHERE id = ?").run("not a git repository", cp.id);
  const unavailable = await restore(cid, cp.id);
  assert.deepEqual([unavailable.ok, unavailable.error], [false, "unavailable"]);
  dbm.db.prepare("UPDATE checkpoints SET ref = ?, unavailable = NULL WHERE id = ?").run("refs/omnichat/checkpoints/x", cp.id);
  ext.rewindReply = { ok: false, error: "dirty_editors" };
  assert.equal((await restore(cid, cp.id)).error, "dirty_editors");
  ext.rewindReply = { ok: false, error: "disk full" };
  const failed = await restore(cid, cp.id);
  assert.deepEqual([failed.ok, failed.error, failed.message], [false, "failed", "disk full"]);
  const invalid = await ext.ask({ type: "checkpoint_restore", requestId: rid(), conversationId: cid }, "checkpoint_restored");
  assert.equal(invalid.code, "invalid_frame");
});

test("prompt with replaceLast: the last user message and everything after it leave the conversation, then the new text runs", async () => {
  resetExt();
  script = [["answer one"]];
  const a = await prompt({ text: "one" });
  await settled(a.conversationId);
  const cid = a.conversationId as string;
  script = [[call("read_file", { path: "x.ts" })], ["answer two"]];
  await prompt({ conversationId: cid, text: "two" });
  await settled(cid);
  const oldAnswer = dbm.db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(cid) as any;
  const before = await history(cid);
  assert.deepEqual(before.filter((i) => i.kind === "user").map((i) => i.text), ["one", "two"]);

  resetExt();
  script = [["answer edited"]];
  const e = await prompt({ conversationId: cid, text: "two, edited", replaceLast: true });
  assert.deepEqual([e.ok, e.conversationId], [true, cid]);
  await settled(cid);
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE id = ?", oldAnswer.id), 0);
  const users = dbm.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at").all(cid).map((r: any) => r.content);
  assert.deepEqual(users, ["one", "two, edited"]);
  const after = await history(cid);
  assert.deepEqual(after.filter((i) => i.kind === "user").map((i) => i.text), ["one", "two, edited"]);
  assert.ok(after.every((i) => !(i.kind === "tool") || i.tool !== "read_file"), "the removed tool call is gone");
  assert.ok(after.some((i) => i.kind === "assistant" && i.text === "answer edited" && i.status === "done"));
  // the model saw the first turn and the edited prompt only
  const sent = requests.at(-1)!.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.ok(sent.includes("one") && sent.includes("two, edited") && !sent.includes("two"));
});

test("prompt with replaceLast: invalid without a conversation or without a user message; busy while running", async () => {
  resetExt();
  const noConv = await ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "x", model: `${modelProvId}::m1`, replaceLast: true }, "prompt_ack");
  assert.deepEqual([noConv.ok, noConv.error], [false, "invalid_frame"]);
  const empty = foreignConversation(userId);
  const none = await ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "x", conversationId: empty, replaceLast: true }, "prompt_ack");
  assert.deepEqual([none.ok, none.error], [false, "invalid_frame"]);
  assert.equal(count("SELECT COUNT(*) n FROM messages WHERE conversation_id = ?", empty), 0);

  ext.tools = () => null;
  script = [[call("run_command", { command: "npm test" })]];
  const a = await prompt({ text: "busy one" });
  await until(() => ext.of("tool_call").length >= 1);
  const busy = await ext.ask({ type: "prompt", requestId: rid(), cwd: "/work/app", text: "again", conversationId: a.conversationId, replaceLast: true, model: `${modelProvId}::m1` }, "prompt_ack");
  assert.deepEqual([busy.ok, busy.error], [false, "busy"]);
  ext.send({ type: "stop", requestId: rid(), conversationId: a.conversationId });
  await settled(a.conversationId);
});

test("sources: sanitized (http/https, no user info or fragment, host, title and url limits, at most 8, no snippet)", () => {
  const long = "a".repeat(600);
  const out = transcript.toTranscriptSources([
    { index: 1, title: "  Example\n page ", url: "https://user:pw@example.com:8443/path?q=1#frag", snippet: "secret" },
    { index: 2, title: "", url: "http://docs.example.org/x" },
    { index: 3, title: "t".repeat(300), url: "https://a.example/" + long },
    { index: 4, title: "javascript", url: "javascript:alert(1)" },
    { index: 5, title: "ftp", url: "ftp://files.example/x" },
    { index: 6, title: "broken", url: "not a url" },
    { index: 7, title: "no url" },
    { index: 8, title: "x", url: 42 },
    ...Array.from({ length: 5 }, (_, i) => ({ index: 10 + i, title: "more " + i, url: `https://more${i}.example/` })),
  ]);
  assert.equal(out.length, 8);
  assert.deepEqual(out[0], { title: "Example page", url: "https://example.com:8443/path?q=1", host: "example.com" });
  assert.deepEqual(out[1], { title: "docs.example.org", url: "http://docs.example.org/x", host: "docs.example.org" });
  assert.equal(out[2].title.length, 200);
  assert.equal(out[2].url.length, 500);
  assert.equal(out[2].host, "a.example");
  assert.deepEqual(out.map((s) => s.title).slice(3), ["more 0", "more 1", "more 2", "more 3", "more 4"]);
  assert.deepEqual(transcript.toTranscriptSources(undefined), []);
  assert.deepEqual(transcript.toTranscriptSources("nope"), []);
  assert.ok(out.every((s) => !("snippet" in s) && !("index" in s)));
});

test("sources on the transcript: the live final frame and the history of a conversation carry them", async () => {
  resetExt();
  await sleep(1100); // chat frames are limited to 30 per second and connection; the tests above used the window
  // live: a feed of its own answer, sources set before it ends
  const liveConv = "clive" + randomUUID().slice(0, 6);
  const feed = transcript.beginTranscript({ userId, bridge: "pcA", conversationId: liveConv, userMessageId: null, assistantMessageId: "a-live" });
  feed.addText("Answer [1].");
  feed.setSources([{ index: 1, title: "Src", url: "https://u:p@live.example/p#f", snippet: "s" }]);
  feed.end("done");
  await until(() => ext.of("transcript").some((f) => f.conversationId === liveConv && f.items.some((i: any) => i.id === "a-live" && i.status === "done")));
  const fin = ext.of("transcript").filter((f) => f.conversationId === liveConv).flatMap((f) => f.items).find((i: any) => i.id === "a-live" && i.status === "done");
  assert.deepEqual(fin.sources, [{ title: "Src", url: "https://live.example/p", host: "live.example" }]);

  // history: a stored answer with sources (messages.sources), and one with broken sources (dropped per entry)
  script = [["hist"]];
  const a = await prompt({ text: "history" });
  await settled(a.conversationId);
  const cid = a.conversationId as string;
  await until(() => !transcript.activeFeed(cid)); // the live feed of the finished turn is gone (history reads the rows then)
  const stored = JSON.stringify([{ index: 1, title: "Kept", url: "https://kept.example/", snippet: "x" }, { index: 2, title: "Bad", url: "ftp://nope/" }]);
  dbm.db.prepare("UPDATE messages SET sources = ? WHERE conversation_id = ? AND role = 'assistant'").run(stored, cid);
  const items = (await history(cid)).filter((i) => i.kind === "assistant");
  assert.deepEqual(items.at(-1).sources, [{ title: "Kept", url: "https://kept.example/", host: "kept.example" }]);
  dbm.db.prepare("UPDATE messages SET sources = 'not json' WHERE conversation_id = ? AND role = 'assistant'").run(cid);
  const broken = (await history(cid)).filter((i) => i.kind === "assistant").at(-1);
  assert.equal("sources" in broken, false);
});
