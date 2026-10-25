// Chat settings and history search from inside VS Code (docs/design/V056D-CONTRACT.md): conversation_settings_request / _set and
// history_search_request, sent through the chat dispatcher with a fake peer (no socket needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.DB_PATH = ":memory:";
const auth = await import("./auth.js");
const dbm = await import("./db.js");
const hub = await import("./hub.js");
const { handleVscodeChatFrame } = await import("./vscode-chat.js");
import type { VscodeChatPeer } from "./vscode-bridge.js";

const BRIDGE = "pcA";
const userId = (await auth.createUserDirect("settingsuser", "password123", false)).userId;
const otherId = (await auth.createUserDirect("settingsother", "password123", false)).userId;
const provId = randomUUID();
dbm.db.prepare("INSERT INTO providers (id, user_id, name, kind, base_url, model, api_key, created_at, deleted, seq) VALUES (?,?,?,?,?,?,?,?,0,?)")
  .run(provId, userId, "VS Code (t)", "vscode-bridge", BRIDGE, "vscode", "", Date.now(), dbm.nextSeq());
// the app side of this user: broadcasts of conversation upserts land here
const appFrames: any[] = [];
hub.addConn(userId, { readyState: 1, OPEN: 1, send: (d: string) => { appFrames.push(JSON.parse(d)); }, on() { /* no-op */ } } as any);

/** Sends one frame as `user` through the chat dispatcher; returns the frames the extension got back. */
function send(frame: Record<string, unknown>, user = userId): any[] {
  const replies: any[] = [];
  const peer: VscodeChatPeer = { userId: user, bridge: BRIDGE, instance: "i1", cwd: "/work/app", workspaces: ["/work/app"], reply: (f) => { replies.push(f); return true; } };
  handleVscodeChatFrame(peer, frame as any);
  return replies;
}
const rid = () => "r" + randomUUID().slice(0, 8);

function addConv(opts: { user?: string; mode?: "code" | "chat"; title?: string; prov?: string | null } = {}): string {
  const id = "c" + randomUUID();
  const now = Date.now();
  dbm.db.prepare(
    "INSERT INTO conversations (id, user_id, title, provider_id, model, created_at, updated_at, deleted, seq, system_mode, mode, cwd) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)",
  ).run(id, opts.user ?? userId, opts.title ?? "Settings chat", opts.prov === undefined ? provId : opts.prov, `${provId}::m1`, now, now, dbm.nextSeq(), "append", opts.mode ?? "code", "/work/app");
  return id;
}
function addMsg(conv: string, content: string, createdAt: number, user = userId): void {
  dbm.db.prepare("INSERT INTO messages (id, user_id, conversation_id, role, content, status, created_at, seq) VALUES (?,?,?,?,?,'done',?,?)")
    .run(randomUUID(), user, conv, "user", content, createdAt, dbm.nextSeq());
}
const row = (id: string): any => dbm.getConversationRow(id);

test("conversation_settings_request: the chat's prompt, mode, effort and title; empty prompt reads as an empty string", () => {
  const id = addConv({ title: "Hello" });
  let [r] = send({ type: "conversation_settings_request", requestId: rid(), conversationId: id });
  assert.equal(r.type, "conversation_settings");
  assert.deepEqual({ systemPrompt: r.systemPrompt, systemMode: r.systemMode, effort: r.effort, title: r.title }, { systemPrompt: "", systemMode: "append", effort: null, title: "Hello" });
  assert.equal(r.conversationId, id);

  // a chat (not Code) conversation, another user's, another bridge's: not_found
  const chat = addConv({ mode: "chat" });
  const foreign = addConv({ user: otherId, prov: null });
  for (const bad of [chat, foreign, "cnope"]) {
    const reply = send({ type: "conversation_settings_request", requestId: rid(), conversationId: bad });
    assert.equal(reply[0].type, "error");
    assert.equal(reply[0].code, "not_found");
  }
  const noIds = send({ type: "conversation_settings_request", requestId: rid() });
  assert.equal(noIds[0].code, "invalid_frame");
});

test("conversation_settings_set: stores the columns the app writes, bumps seq, broadcasts the conversation", () => {
  const id = addConv();
  const seq0 = row(id).seq;
  appFrames.length = 0;
  const reqId = rid();
  const [ack] = send({ type: "conversation_settings_set", requestId: reqId, conversationId: id, systemPrompt: "  Be terse.  ", systemMode: "replace", effort: "high", title: "  Renamed  " });
  assert.equal(ack.type, "conversation_settings_ack");
  assert.equal(ack.requestId, reqId);
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.settings, { systemPrompt: "  Be terse.  ", systemMode: "replace", effort: "high" });
  assert.equal(ack.title, "Renamed");
  const r = row(id);
  assert.equal(r.system_prompt, "  Be terse.  ");
  assert.equal(r.system_mode, "replace");
  assert.equal(r.effort, "high");
  assert.equal(r.title, "Renamed");
  assert.ok(r.seq > seq0);
  assert.ok(appFrames.some((f) => f.type === "upsert" && f.conversations?.some((c: any) => c.id === id && c.title === "Renamed")));

  // an empty prompt stores NULL; effort null = the model default; absent fields are kept
  const [ack2] = send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, systemPrompt: "", effort: null });
  assert.equal(ack2.ok, true);
  assert.equal(row(id).system_prompt, null);
  assert.equal(row(id).effort, null);
  assert.equal(row(id).system_mode, "replace");
  assert.equal(row(id).title, "Renamed");
});

test("conversation_settings_set: invalid values are refused with invalid_frame and change nothing", () => {
  const id = addConv();
  send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, systemPrompt: "keep", effort: "medium", title: "Keep" });
  const refused: Record<string, unknown>[] = [
    { systemPrompt: 42 },
    { systemPrompt: null },
    { systemPrompt: "x".repeat(20001) },
    { systemMode: "prepend" },
    { effort: "extreme" },
    { title: "   " },
    { title: "t".repeat(201) },
    { title: 7 },
  ];
  for (const f of refused) {
    const [ack] = send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, ...f });
    assert.equal(ack.ok, false, JSON.stringify(f));
    assert.equal(ack.error, "invalid_frame", JSON.stringify(f));
  }
  const max = send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, systemPrompt: "y".repeat(20000), title: "t".repeat(200) });
  assert.equal(max[0].ok, true);
  assert.equal(row(id).system_prompt.length, 20000);
  assert.equal(row(id).title.length, 200);
  // a value that is only an invalid field of a frame refuses the whole frame
  send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, systemPrompt: "keep", effort: "medium", title: "Keep" });
  send({ type: "conversation_settings_set", requestId: rid(), conversationId: id, systemPrompt: "other", effort: "bogus" });
  assert.equal(row(id).system_prompt, "keep");
  assert.equal(row(id).effort, "medium");
});

test("conversation_settings_set: not_found for other chats and users, and no requestId is invalid_frame", () => {
  const chat = addConv({ mode: "chat" });
  const foreign = addConv({ user: otherId });
  for (const bad of [chat, foreign]) {
    const [ack] = send({ type: "conversation_settings_set", requestId: rid(), conversationId: bad, title: "Hacked" });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, "not_found");
  }
  assert.notEqual(row(foreign).title, "Hacked");
  assert.equal(send({ type: "conversation_settings_set", conversationId: chat, title: "x" })[0].code, "invalid_frame");
});

test("history_search_request: only this bridge's Code chats of the asking user; snippets mark the match; limit and query checks", () => {
  const mine = addConv({ title: "Quarterly notes" });
  addMsg(mine, "the zebra crossing was closed", 1_000);
  const chat = addConv({ mode: "chat", title: "Other" });
  addMsg(chat, "a zebra in a chat", 5_000);
  const foreign = addConv({ user: otherId });
  addMsg(foreign, "a zebra of someone else", 5_000, otherId);

  const [r] = send({ type: "history_search_request", requestId: rid(), query: "  zebra  " });
  assert.equal(r.type, "history_search");
  assert.equal(r.query, "zebra");
  assert.deepEqual(r.results.map((h: any) => h.conversationId), [mine]);
  const hit = r.results[0];
  assert.equal(hit.title, "Quarterly notes");
  assert.equal(hit.role, "user");
  assert.equal(typeof hit.messageId, "string");
  assert.equal(typeof hit.at, "number");
  assert.ok(hit.snippet.includes("\u0001zebra\u0002"), hit.snippet);

  const [one] = send({ type: "history_search_request", requestId: rid(), query: "zebra", limit: 1 });
  assert.equal(one.results.length, 1);

  for (const bad of [{ query: "" }, { query: "   " }, { query: "z".repeat(201) }, { query: 5 }, { query: "zebra", limit: 0 }, { query: "zebra", limit: 1.5 }]) {
    const [e] = send({ type: "history_search_request", requestId: rid(), ...bad });
    assert.equal(e.type, "error", JSON.stringify(bad));
    assert.equal(e.code, "invalid_frame", JSON.stringify(bad));
  }
  assert.equal(send({ type: "history_search_request", query: "zebra" })[0].code, "invalid_frame");
});

test("history_search_request: pages past the hits of other chats to find this bridge's, at most 30 results", () => {
  const mine = addConv({ title: "Old one" });
  addMsg(mine, "needle in the old chat", 1);
  const chat = addConv({ mode: "chat", title: "Busy" });
  for (let i = 0; i < 35; i++) addMsg(chat, `needle ${i} in a plain chat`, 10_000 + i);
  const [r] = send({ type: "history_search_request", requestId: rid(), query: "needle" });
  assert.deepEqual(r.results.map((h: any) => h.conversationId), [mine]);

  // many own hits: capped at 30
  for (let i = 0; i < 40; i++) addMsg(mine, `needle ${i} again`, 20_000 + i);
  const [capped] = send({ type: "history_search_request", requestId: rid(), query: "needle" });
  assert.equal(capped.results.length, 30);
});
