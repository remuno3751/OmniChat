// Aria voice call, relay (docs/design/ARIA-HOST.md: "中継の規則", "履歴への記録", ARIA-HOST-ADDENDUM.md). A fake Aria runs in this process; the server is a child process.
// The client is a plain WebSocket to /voice/ws; the fake Aria's live socket is driven with fc.send / fc.sendBinary.
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { startServer, api, type TestServer } from "./test-server.js";
import { startFakeAria, until, type FakeAria, type LiveConn } from "./voice-fake-aria.js";

const PW = "password123";
const CHAT = "chat-relay-VALUE-333";
const ADMIN = "adm-relay-VALUE-444";

let s: TestServer;
let fake: FakeAria;
let admin = "", alice = "", alice2 = "", bob = "";
let aliceId = "", bobId = "";
let convId = "";
const clients: Client[] = [];
const watchers: WebSocket[] = [];

/** A /voice/ws client. `all` holds every frame from the server in order: JSON objects, binary frames as Buffer. */
class Client {
  all: any[] = [];
  closeCode: number | null = null;
  closeReason = "";
  ws!: WebSocket;
  get ready(): any { return this.all.find((f) => !Buffer.isBuffer(f) && f.type === "ready"); }
  /** the call's frames, except `ready` and the relay's own `omni_stats` */
  get rest(): any[] { return this.all.filter((f) => Buffer.isBuffer(f) || (f.type !== "ready" && f.type !== "omni_stats")); }
  /** the relay's own latency frames, in order */
  get stats(): any[] { return this.all.filter((f) => !Buffer.isBuffer(f) && f.type === "omni_stats"); }
  send(o: Record<string, unknown>) { this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
}

function openClient(q: string): Promise<Client> {
  const c = new Client();
  c.ws = new WebSocket(`ws://127.0.0.1:${s.port}/voice/ws?${q}`);
  c.ws.on("message", (d, bin) => c.all.push(bin ? Buffer.from(d as Buffer) : JSON.parse((d as Buffer).toString("utf8"))));
  c.ws.on("close", (code, reason) => { c.closeCode = code; c.closeReason = reason.toString("utf8"); });
  c.ws.on("error", () => undefined);
  clients.push(c);
  return new Promise((res, rej) => {
    c.ws.once("open", () => res(c));
    c.ws.once("unexpected-response", (_req, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}

/** The HTTP status of a refused handshake. */
function handshakeStatus(q: string): Promise<number> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/voice/ws?${q}`);
    ws.on("unexpected-response", (_req, resp) => { res(resp.statusCode ?? 0); ws.terminate(); });
    ws.on("open", () => { ws.terminate(); rej(new Error("handshake should have been refused")); });
    ws.on("error", () => undefined);
  });
}

/** The fake Aria's live socket for this user (the one still open). */
const fakeConn = (user: string): LiveConn | undefined => fake.liveConnections.find((c) => c.user === user && !c.closed);
const norm = (f: any) => (Buffer.isBuffer(f) ? { binary: f.toString("base64") } : f);
const sync = async (tok: string) => (await api(s.base, "GET", "/sync?since=0", undefined, tok)).json;
const msgsOf = (sy: any, id: string): any[] => sy.messages.filter((m: any) => m.conversationId === id);
const usageToday = async (tok: string) => (await api(s.base, "GET", "/voice/usage", undefined, tok)).json.today as { callSeconds: number; turns: number; replyChars: number };
const today = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

/** Polls until pred(messages of the conversation) holds. */
async function waitMsgs(tok: string, id: string, pred: (ms: any[]) => boolean): Promise<any[]> {
  return pollUntil(async () => msgsOf(await sync(tok), id), pred);
}

/** Polls an async getter until ok(value) holds (deterministic: a short interval, a fixed deadline). */
async function pollUntil<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() - t > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Starts a call on the fake and waits until the client has its ready. */
async function startCall(tok: string, userId: string, conversation = ""): Promise<{ c: Client; fc: LiveConn }> {
  const c = await openClient(`token=${tok}${conversation ? `&conversationId=${conversation}` : ""}`);
  c.send({ type: "hello", codec: "pcm16", values: {} });
  await until(() => !!fakeConn(userId));
  await until(() => !!c.ready);
  return { c, fc: fakeConn(userId)! };
}

/** Writes to the server's database file (the test server's own), for a state that only time would reach. */
function dbWrite(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(s.tmp, "t.db"));
  try { fn(db); } finally { db.close(); }
}

before(async () => {
  fake = await startFakeAria({ chatToken: CHAT, adminToken: ADMIN });
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  const localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  const local = (method: string, path: string, body?: unknown) => api(s.base, method, path, body, "", { "x-local-admin": localTok });
  for (const [username, role] of [["relayadmin", "admin"], ["alice", "user"], ["bob", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username, password: PW, role })).status, 200);
  }
  const login = (username: string, deviceName = "test") => api(s.base, "POST", "/auth/login", { username, password: PW, deviceName, platform: "test" });
  const a = (await login("relayadmin")).json, al = (await login("alice")).json, b = (await login("bob")).json;
  admin = a.token; alice = al.token; aliceId = al.userId; bob = b.token; bobId = b.userId;
  alice2 = (await login("alice", "Tablet")).json.token;
  assert.ok(admin && alice && alice2 && bob, "logins failed");

  const cfg = await api(s.base, "PUT", "/voice/admin/config", { mode: "hosted", baseUrl: fake.baseUrl, chatToken: CHAT, adminToken: ADMIN }, admin);
  assert.equal(cfg.status, 200);
  // saved prefs for alice: voice, pause and barge-in (the relay sends them to Aria as one settings frame after ready)
  assert.equal((await api(s.base, "PUT", "/voice/me", { voice: "v-saved", pauseScale: 0.8, bargeIn: false }, alice)).status, 200);
});
afterEach(async () => {
  for (const c of clients) if (c.closeCode === null) c.ws.terminate();
  // wait until Aria has seen every socket close, so the next test starts from a clean state
  await until(() => fake.liveConnections.every((x) => x.closed), 3000).catch(() => undefined);
});
after(async () => {
  for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
  for (const w of watchers) { try { w.terminate(); } catch { /* ignore */ } }
  await fake?.stop();
  s?.stop();
});

test("1. no token or a bad token -> the handshake is refused with 401", async () => {
  assert.equal(await handshakeStatus(""), 401);
  assert.equal(await handshakeStatus("token=not-a-real-token"), 401);
});

test("2. mode off -> the socket is closed with 4409", async () => {
  assert.equal((await api(s.base, "PUT", "/voice/admin/config", { mode: "off" }, admin)).status, 200);
  try {
    const c = await openClient(`token=${alice}`);
    await until(() => c.closeCode !== null);
    assert.equal(c.closeCode, 4409);
  } finally {
    assert.equal((await api(s.base, "PUT", "/voice/admin/config", { mode: "hosted" }, admin)).status, 200);
  }
});

test("3. no hello change; after Aria's ready, one settings frame carries the saved prefs (speed 1.3 default); the client's later settings pass as sent", async () => {
  const c = await openClient(`token=${alice}`);
  const hello = { type: "hello", codec: "pcm16", values: { voice: "v-client", pause_scale: 1.5 } };
  c.send(hello);
  await until(() => !!fakeConn(aliceId)?.frames.some((f) => f.type === "settings"));
  const fc = fakeConn(aliceId)!;
  assert.deepEqual(fc.frames[0], hello, "the hello reaches Aria exactly as the app sent it");
  assert.equal(fc.frames[1].type, "settings", "the first frame after the hello is the relay's settings");
  assert.deepEqual(fc.frames[1], {
    type: "settings",
    values: { tts_mode: "balanced", speed: 1.3, voice: "v-saved", pause_scale: 0.8, barge_in: false },
    persist: false,
  }, "saved prefs as Aria's names, speed defaulting to 1.3");
  assert.equal(fc.frames.filter((f) => f.type === "settings").length, 1, "sent once per connection");
  assert.equal(c.all.some((f) => !Buffer.isBuffer(f) && f.type === "settings"), false, "the app never gets the relay's settings");
  assert.equal(typeof c.ready.conversationId, "string", "the ready has the conversation");

  const later = { type: "settings", values: { speed: 0.9 } };
  c.send(later);
  await until(() => fc.frames.length >= 3);
  assert.deepEqual(fc.frames[2], later, "the client's own settings pass through as sent");
  c.close();
  await until(() => fc.closed);
});

test("4. happy path: ready with conversationId, frames pass through, history recorded, second device sees upserts", async () => {
  // a second device of alice watches the live broadcasts
  const ups: any[] = [];
  const w = new WebSocket(`ws://127.0.0.1:${s.port}/ws?token=${alice2}`);
  watchers.push(w);
  w.on("message", (d) => { const f = JSON.parse(d.toString()); if (f.type === "upsert") ups.push(f); });
  await new Promise<void>((res, rej) => { w.once("open", () => res()); w.once("error", rej); });

  const { c, fc } = await startCall(alice, aliceId);
  convId = c.ready.conversationId;
  assert.equal(typeof convId, "string");
  assert.ok(convId.length > 0);
  assert.equal(c.ready.codec, "pcm16");
  assert.equal(c.ready.sample_rate, 16000);
  assert.deepEqual(c.ready.tts_modes, ["balanced", "fast"]);
  assert.equal(c.ready.private, false);

  const pcm = randomBytes(640); // 20 ms of PCM16 mono at 16 kHz
  const sent: any[] = [
    { type: "turn_start", turn: 1 },
    { type: "transcript", turn: 1, text: "こんにちは", final: false, source: "mic" },
    { type: "transcript", turn: 1, text: "こんにちは", final: true, source: "mic" },
    { type: "text", turn: 1, delta: "はい、" },
    { type: "text", turn: 1, delta: "こんにちは。" },
    { type: "audio", turn: 1, seq: 1, text: "はい、こんにちは。", codec: "pcm16", sampleRate: 16000, frames: 1 },
    pcm,
    { type: "turn_end", turn: 1, interrupted: false },
  ];
  for (const f of sent) { if (Buffer.isBuffer(f)) fc.sendBinary(f); else fc.send(f); }
  await until(() => c.rest.length >= sent.length);
  assert.deepEqual(c.rest.map(norm), sent.map(norm), "every frame reaches the client unchanged, binary included");
  await until(() => c.stats.length === 1);

  const ms = await waitMsgs(alice, convId, (m) => m.some((x) => x.role === "assistant" && x.status === "done"));
  const user = ms.find((x) => x.role === "user");
  const asst = ms.find((x) => x.role === "assistant");
  assert.equal(user.via, "voice");
  assert.equal(user.content, "こんにちは");
  assert.equal(asst.via, "voice");
  assert.equal(asst.status, "done");
  assert.equal(asst.content, "はい、こんにちは。");
  const conv = (await sync(alice)).conversations.find((x: any) => x.id === convId);
  assert.deepEqual(conv.kinds, ["voice"]);

  await until(() => ups.some((u) => (u.messages ?? []).some((m: any) => m.via === "voice" && m.role === "assistant" && m.status === "done")));
  assert.ok(ups.some((u) => (u.messages ?? []).some((m: any) => m.via === "voice" && m.role === "user")), "user line broadcast too");
  c.close();
  await until(() => fc.closed);
});

test("5. interrupted turn keeps the heard part, status stopped", async () => {
  const { c, fc } = await startCall(alice, aliceId, convId);
  assert.equal(c.ready.conversationId, convId, "the call continues the given conversation");
  fc.send({ type: "turn_start", turn: 2 });
  fc.send({ type: "transcript", turn: 2, text: "もういっかい", final: true, source: "mic" });
  fc.send({ type: "text", turn: 2, delta: "えっと、" });
  fc.send({ type: "interrupted", turn: 2 });
  const ms = await waitMsgs(alice, convId, (m) => m.some((x) => x.content === "えっと、" && x.status === "stopped"));
  assert.equal(ms.find((x) => x.content === "えっと、").via, "voice");
  assert.ok(ms.some((x) => x.role === "user" && x.content === "もういっかい"));
  c.close();
  await until(() => fc.closed);
});

test("6. transcript_retract removes the user message of its utterance_id, even when another turn is named", async () => {
  const { c, fc } = await startCall(alice, aliceId, convId);
  const uA = fc.utterance(6), uB = fc.utterance(7);
  assert.notEqual(uA, uB);
  fc.send({ type: "turn_start", turn: 6 });
  fc.send({ type: "transcript", turn: 6, utterance_id: uA, text: "一つめ", final: true, source: "mic" });
  fc.send({ type: "turn_start", turn: 7 });
  fc.send({ type: "transcript", turn: 7, utterance_id: uB, text: "二つめ", final: true, source: "mic" });
  await waitMsgs(alice, convId, (m) => m.some((x) => x.role === "user" && x.content === "一つめ") && m.some((x) => x.role === "user" && x.content === "二つめ"));
  fc.send({ type: "transcript_retract", turn: 7, utterance_id: uA });
  const ms = await waitMsgs(alice, convId, (m) => !m.some((x) => x.role === "user" && x.content === "一つめ"));
  assert.ok(ms.some((x) => x.role === "user" && x.content === "二つめ"), "the other utterance stays");
  c.close();
  await until(() => fc.closed);
});

test("7. a second concurrent call by the same user -> closed 4429", async () => {
  const { c, fc } = await startCall(alice, aliceId);
  const b = await openClient(`token=${alice}`);
  b.send({ type: "hello", codec: "pcm16", values: {} });
  await until(() => b.closeCode !== null);
  assert.equal(b.closeCode, 4429);
  assert.equal(fake.liveConnections.filter((x) => x.user === aliceId && !x.closed).length, 1, "only the first call reached Aria");
  c.close();
  await until(() => fc.closed);
});

test("8. another user's conversationId -> closed 4404", async () => {
  const b = await openClient(`token=${bob}&conversationId=${convId}`);
  await until(() => b.closeCode !== null);
  assert.equal(b.closeCode, 4404);
  assert.equal(fakeConn(bobId), undefined, "Aria was not called for bob");
});

test("9. disconnect propagates both ways (app left -> Aria closed; Aria closed -> app 1000 aria_closed)", async () => {
  const one = await startCall(alice, aliceId);
  one.c.close();
  await until(() => one.fc.closed);

  const two = await startCall(alice, aliceId);
  two.fc.close(1000);
  await until(() => two.c.closeCode !== null);
  assert.equal(two.c.closeCode, 1000);
  assert.equal(two.c.closeReason, "aria_closed");
});

test("10. private=1: no conversation and no history; Aria gets private=1; ready has no conversationId; the usage still counts", async () => {
  const before = await sync(alice);
  const convsBefore = before.conversations.length;
  const voiceBefore = before.messages.filter((m: any) => m.via === "voice").length;
  const turnsBefore = (await usageToday(alice)).turns;

  const c = await openClient(`token=${alice}&private=1`);
  c.send({ type: "hello", codec: "pcm16", values: {} });
  await until(() => !!c.ready);
  assert.equal("conversationId" in c.ready, false, "no conversation for a private call");
  assert.equal(c.ready.private, true, "Aria echoes the private flag");
  const wsReq = fake.requests.findLast((r) => r.method === "WS" && r.query.user === aliceId);
  assert.equal(wsReq?.query.private, "1", "the Aria URL carries private=1");
  const fc = fakeConn(aliceId)!;

  fc.send({ type: "turn_start", turn: 20 });
  fc.send({ type: "transcript", turn: 20, utterance_id: fc.utterance(20), text: "ないしょの話", final: true, source: "mic" });
  fc.send({ type: "text", turn: 20, delta: "はい、ないしょ。" });
  fc.send({ type: "turn_end", turn: 20, interrupted: false });
  await pollUntil(() => usageToday(alice), (u) => u.turns > turnsBefore);

  const after = await sync(alice);
  assert.equal(after.conversations.length, convsBefore, "no conversation was created");
  assert.equal(after.messages.filter((m: any) => m.via === "voice").length, voiceBefore, "no voice message was stored");
  assert.equal(after.messages.some((m: any) => m.content === "ないしょの話" || m.content === "はい、ないしょ。"), false);
  c.close();
  await until(() => fc.closed);
});

test("11. usage after a call: a turn and its reply characters are counted, call seconds are never negative", async () => {
  const u0 = await usageToday(alice);
  const { c, fc } = await startCall(alice, aliceId, convId);
  fc.send({ type: "turn_start", turn: 21 });
  fc.send({ type: "transcript", turn: 21, utterance_id: fc.utterance(21), text: "使用量", final: true, source: "mic" });
  fc.send({ type: "text", turn: 21, delta: "あ" });
  fc.send({ type: "turn_end", turn: 21, interrupted: false });
  const u1 = await pollUntil(() => usageToday(alice), (u) => u.turns >= u0.turns + 1);
  assert.equal(u1.replyChars - u0.replyChars, 1, "one reply character");
  c.close();
  await until(() => fc.closed);
  const after = (await api(s.base, "GET", "/voice/usage", undefined, alice)).json;
  assert.ok(after.today.callSeconds >= u0.callSeconds, "seconds only grow");
  assert.ok(Number.isInteger(after.today.callSeconds) && after.today.callSeconds >= 0);
  assert.equal(after.days[0].day, today(), "the day row is today's");
});

test("12. omni_stats: one per turn, from Aria's first_audio_ms when sent, else measured; none when there was no audio", async () => {
  const u0 = await usageToday(alice);
  const { c, fc } = await startCall(alice, aliceId, convId);
  fc.send({ type: "turn_start", turn: 8 });
  fc.send({ type: "transcript", turn: 8, utterance_id: fc.utterance(8), text: "すこし", final: true, source: "mic" });
  fc.send({ type: "audio", turn: 8, seq: 1, text: "はい", codec: "pcm16", sampleRate: 16000, frames: 1 });
  fc.turnEnd(8, { first_audio_ms: 42, reply_chars: 9 });
  await until(() => c.stats.length === 1);
  assert.deepEqual(c.stats[0], { type: "omni_stats", latencyMs: 42 });

  // a turn with no user trigger and no audio: no latency frame (the next frame to arrive is turn 10's, so none came for 9)
  fc.turnEnd(9);
  // a turn with a measured latency and no stats: Aria's audio after the final transcript
  fc.send({ type: "turn_start", turn: 10 });
  fc.send({ type: "transcript", turn: 10, utterance_id: fc.utterance(10), text: "もう一度", final: true, source: "mic" });
  fc.send({ type: "audio", turn: 10, seq: 1, text: "はい", codec: "pcm16", sampleRate: 16000, frames: 1 });
  fc.turnEnd(10);
  await until(() => c.stats.length === 2);
  assert.equal(c.stats.length, 2, "one per turn that had audio");
  assert.equal(typeof c.stats[1].latencyMs, "number");
  assert.ok(c.stats[1].latencyMs >= 0);

  // usage: three turns; the reply characters come from Aria's stats (9)
  const u1 = await pollUntil(() => usageToday(alice), (u) => u.turns >= u0.turns + 3);
  assert.equal(u1.turns - u0.turns, 3);
  assert.equal(u1.replyChars - u0.replyChars, 9);
  c.close();
  await until(() => fc.closed);
});

test("13. Aria's abnormal close (1012, or a dropped socket) -> client 1011 aria_restarting; a normal close -> 1000 aria_closed; the reply so far is kept", async () => {
  const { c, fc } = await startCall(alice, aliceId, convId);
  fc.send({ type: "turn_start", turn: 11 });
  fc.send({ type: "transcript", turn: 11, utterance_id: fc.utterance(11), text: "おわり", final: true, source: "mic" });
  fc.send({ type: "text", turn: 11, delta: "途中まで" });
  fc.close(1012);
  await until(() => c.closeCode !== null);
  assert.equal(c.closeCode, 1011);
  assert.equal(c.closeReason, "aria_restarting");
  const ms = await waitMsgs(alice, convId, (m) => m.some((x) => x.content === "途中まで" && x.status === "stopped"));
  assert.equal(ms.find((x) => x.content === "途中まで").via, "voice");
  assert.equal(fakeConn(aliceId), undefined, "the relay does not retry by itself");

  const { c: c2, fc: fc2 } = await startCall(alice, aliceId, convId);
  fc2.terminate();
  await until(() => c2.closeCode !== null);
  assert.equal(c2.closeCode, 1011, "a dropped socket is abnormal too");
  assert.equal(c2.closeReason, "aria_restarting");
});

test("14. daily quota: a new call is refused with 4429 quota before Aria is called; another user is not affected", async () => {
  assert.equal((await api(s.base, "PUT", "/voice/admin/config", { dailyLimitMinutes: 1 }, admin)).status, 200);
  dbWrite((db) => db.prepare("INSERT OR REPLACE INTO voice_usage (user_id, day, call_seconds, turns, reply_chars) VALUES (?,?,?,?,?)")
    .run(aliceId, today(), 60, 0, 0));
  try {
    const c = await openClient(`token=${alice}`);
    c.send({ type: "hello", codec: "pcm16", values: {} });
    await until(() => c.closeCode !== null);
    assert.equal(c.closeCode, 4429);
    assert.equal(c.closeReason, "quota");
    assert.equal(fakeConn(aliceId), undefined, "Aria was not called");

    const { c: cb, fc: fb } = await startCall(bob, bobId);
    assert.equal(typeof cb.ready.conversationId, "string", "bob's call starts");
    cb.close();
    await until(() => fb.closed);
  } finally {
    dbWrite((db) => db.prepare("DELETE FROM voice_usage WHERE user_id = ?").run(aliceId));
    assert.equal((await api(s.base, "PUT", "/voice/admin/config", { dailyLimitMinutes: 0 }, admin)).status, 200);
  }
  // Not covered: the quota running out in the middle of a call. The relay checks it once a minute (USAGE_FLUSH_MS),
  // which would make this test wait over a minute; left out on purpose.
});
