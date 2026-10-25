// Auto title for VS Code Code turns (code-agent.ts): the title model comes from settings (titleModel, search model, first usable
// openai-compatible model), a failed request is logged and retried once, and a user-set title is never overwritten.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

process.env.DB_PATH = ":memory:";
const tu = await import("./test-tools-util.js");
const bridges = await import("./bridges.js");
const auth = await import("./auth.js");
const dbm = await import("./db.js");
const chat = await import("./chat.js");
const hub = await import("./hub.js");
const providers = await import("./providers/index.js");
const projects = await import("./projects.js");
import type { StreamItem, StreamRequest } from "./providers/index.js";

let server: Server;
let port = 0;
let userId = "";
let token = "";
let vsProvId = "";
let modelProvId = "";
let llmProvId = "";
let llm: Awaited<ReturnType<typeof tu.startLlm>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout waiting"); await sleep(10); }
};
const FIRST_SYSTEM = "Write a title of 3-6 words for this conversation. Reply with the title only.";
const convTitle = (id: string) => (dbm.getConversationRow(id) as any)?.title;

/* ---- scripted model for the Code turn ---- */
let script: StreamItem[][] = [];
providers.registerProvider("scripted", () => ({
  async *stream(req: StreamRequest) {
    const r = script[Math.min(scriptN++, script.length - 1)];
    for (const it of r) { if (req.signal.aborted) return; yield it; await sleep(1); }
  },
}));
let scriptN = 0;

/* ---- fake extension: answers ready/run frames; the scripted turn makes no tool calls ---- */
class Ext {
  ws!: WebSocket;
  welcomed = false;
  constructor(readonly name: string, readonly instance: string) {}
  async connect() {
    const q = new URLSearchParams({ token, name: this.name, kind: "vscode", instance: this.instance });
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?${q}`);
    this.ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === "welcome") this.welcomed = true;
      if (f.type === "run") {
        this.send({ type: "checkpoint", requestId: f.runId, checkpointId: "cp-" + f.runId, ref: "refs/omnichat/checkpoints/" + f.runId, createdAt: 1, dirty: false });
        this.send({ type: "run_ack", runId: f.runId, ok: true });
      } else if (f.type === "run_end") {
        this.send({ type: "changes", requestId: f.runId, changes: [], truncated: false });
        this.send({ type: "done", runId: f.runId, ok: true });
      }
    });
    await new Promise<void>((res, rej) => { this.ws.once("open", () => res()); this.ws.once("error", rej); });
    this.send({
      type: "ready", kind: "vscode", name: this.name, instance: this.instance, version: "0.1.0", protocol: 1, vscodeVersion: "1.96.0",
      platform: "linux", shell: "bash", remote: null, cwd: "/work/app", workspaces: ["/work/app"], allowAnyCwd: false, trusted: true,
      capabilities: { workspaces: true, fs: false, approval: true, checkpoints: true, transcript: false, tools: ["read_file"] },
    });
    await until(() => this.welcomed);
    return this;
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.terminate(); } catch { /* ignore */ } }
}
let ext: Ext;

before(async () => {
  const u = await auth.createUserDirect("codetitle", "password123", false);
  userId = u.userId;
  token = auth.createDevice(userId, "VS Code (ct)", "vscode-ext").token;
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/bridge") return bridges.handleBridgeUpgrade(req, socket, head, url);
    socket.destroy();
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  port = (server.address() as any).port;
  hub.addConn(userId, { readyState: 1, OPEN: 1, send: () => undefined, on() { /* no-op */ } } as any);
  llm = await tu.startLlm();
  vsProvId = randomUUID(); modelProvId = randomUUID(); llmProvId = randomUUID();
  const ins = dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)");
  ins.run(vsProvId, userId, "VS", "vscode-bridge", "pcT", "", "", Date.now(), dbm.nextSeq());
  ins.run(modelProvId, userId, "Model", "scripted", "http://unused", "m1", "", Date.now(), dbm.nextSeq());
  ins.run(llmProvId, userId, "LLM", "openai-compatible", llm.base, "llm-1", "", Date.now(), dbm.nextSeq());
  projects.saveSettings(userId, { autoTitle: true, titleModel: null, search: { searchModel: null } } as any);
  ext = await new Ext("pcT", "t1").connect();
});
after(() => { ext?.close(); server.close(); server.closeAllConnections?.(); llm?.close(); });

function mkConv(title = "New chat"): string {
  const id = randomUUID();
  const now = Date.now();
  dbm.db.prepare(
    "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd, approval_mode) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)",
  ).run(id, userId, title, vsProvId, `${modelProvId}::m1`, now, now, dbm.nextSeq(), "append", "code", "/work/app", "auto");
  return id;
}

/** One Code turn; resolves when the reply is stored. */
async function codeTurn(conv: string, content = "rename the module") {
  script = [["Done."]]; scriptN = 0;
  const assistantMessageId = "m" + randomUUID().slice(0, 8);
  await chat.handleSend(userId, { conversationId: conv, content, userMessageId: randomUUID(), assistantMessageId }, () => undefined);
  await until(() => dbm.getMessageRow(assistantMessageId)?.status !== "streaming");
  return assistantMessageId;
}

test("a Code turn gets a title from the first usable openai-compatible model when no title or search model is set", async () => {
  projects.saveSettings(userId, { titleModel: null, search: { searchModel: null } } as any);
  llm.titleReply = "Rename Module Task";
  const n = llm.titleBodies.length;
  const cv = mkConv();
  await codeTurn(cv);
  await until(() => convTitle(cv) === "Rename Module Task");
  assert.equal(llm.titleBodies.length - n, 1);
  const body = llm.titleBodies.at(-1);
  assert.equal(body.model, "llm-1");
  assert.equal(body.messages[0].content, FIRST_SYSTEM);
});

test("settings.titleModel wins over the search model and the fallback", async () => {
  projects.saveSettings(userId, { titleModel: `${llmProvId}::llm-1`, search: { searchModel: `${modelProvId}::m1` } } as any);
  llm.titleReply = "Explicit Title Model";
  const cv = mkConv();
  await codeTurn(cv);
  await until(() => convTitle(cv) === "Explicit Title Model");
  projects.saveSettings(userId, { titleModel: null, search: { searchModel: null } } as any);
});

test("a user-set title is never overwritten by a Code turn", async () => {
  const n = llm.titleBodies.length;
  llm.titleReply = "Should not apply";
  const cv = mkConv("My own name");
  await codeTurn(cv);
  await sleep(300);
  assert.equal(llm.titleBodies.length, n, "no title request for a renamed chat");
  assert.equal(convTitle(cv), "My own name");
});

test("a failed title request is logged with its status and retried once; the chat keeps its placeholder title", async () => {
  llm.titleReply = null; // HTTP 500 from the fake model
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    const n = llm.titleBodies.length;
    const cv = mkConv();
    await codeTurn(cv);
    await until(() => llm.titleBodies.length - n >= 2);
    await sleep(100);
    assert.equal(llm.titleBodies.length - n, 2, "one retry, no more");
    assert.ok(warns.some((w) => /auto title: HTTP 500/.test(w) && /attempt 1/.test(w)), warns.join("\n"));
    assert.ok(warns.some((w) => /attempt 2/.test(w)));
    assert.equal(convTitle(cv), "rename the module", "the first user message stays as the placeholder title when no title is produced");
  } finally {
    console.warn = orig;
    llm.titleReply = "Recovered";
  }
});

test("a long first message with no title produced: the Code chat keeps its first 30 characters, clipped at a phrase boundary", async () => {
  llm.titleReply = null;
  const n = llm.titleBodies.length;
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
  try {
    const cv = mkConv();
    await codeTurn(cv, "Please refactor the payment module so that the retry logic is shared between the webhook handler and the nightly job, then update the tests");
    await until(() => llm.titleBodies.length - n >= 2);
    await sleep(100);
    assert.equal(convTitle(cv), "Please refactor the payment");
  } finally {
    console.warn = orig;
    llm.titleReply = "Recovered";
  }
});

test("a Code chat titles with its own openai-compatible model before the first usable one", async () => {
  const own = randomUUID();
  dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
    .run(own, userId, "LLM2", "openai-compatible", llm.base, "llm-2", "", Date.now(), dbm.nextSeq());
  projects.saveSettings(userId, { titleModel: null, search: { searchModel: null } } as any);
  llm.titleReply = "Own Model Title";
  const n = llm.titleBodies.length;
  const cv = mkConv();
  dbm.db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(`${own}::llm-2`, cv);
  await codeTurn(cv);
  await until(() => convTitle(cv) === "Own Model Title");
  assert.equal(llm.titleBodies.length - n, 1);
  assert.equal(llm.titleBodies.at(-1).model, "llm-2");
});
