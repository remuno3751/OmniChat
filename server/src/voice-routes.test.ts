// Aria voice call, REST (docs/design/ARIA-HOST.md + ARIA-HOST-ADDENDUM.md: "OmniChat サーバーの API"). A fake Aria runs in this process; the server is a child process.
// Tests run in order and share one server: later tests rely on the admin config and the uploads of earlier ones.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { startServer, api, type TestServer } from "./test-server.js";
import { startFakeAria, fakeWav, type FakeAria } from "./voice-fake-aria.js";

const PW = "password123";
const CHAT = "chat-tok-VALUE-111";
const ADMIN = "adm-tok-VALUE-222";

let s: TestServer;
let fake: FakeAria;
let localTok = "";
let admin = "", alice = "", bob = "";
let aliceId = "", bobId = "";
let aliceVoice = "", bobVoice = "";
/** every response body seen by the tests: no token may appear in any of them */
const seen: string[] = [];
/** the bodies answered to non-admin callers: the Aria URL may not appear in these (the admin config shows it, by spec) */
const userSeen: string[] = [];

/** JSON call against the OmniChat server; the body is kept for the leak checks. */
async function call(method: string, path: string, body?: unknown, tok = "", extra: Record<string, string> = {}) {
  const r = await api(s.base, method, path, body, tok, extra);
  seen.push(r.text);
  if (tok !== admin && !extra["x-local-admin"]) userSeen.push(r.text);
  return r;
}
const local = (method: string, path: string, body?: unknown) => call(method, path, body, "", { "x-local-admin": localTok });

/** Raw upload to POST /voice/voices/models?name=&kind= (binary body, like the app sends it). */
async function upload(tok: string, name: string, bytes: Buffer, extraQuery = "") {
  const r = await fetch(s.base + "/voice/voices/models?name=" + encodeURIComponent(name) + extraQuery, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/octet-stream" },
    body: new Uint8Array(bytes),
  });
  const text = await r.text();
  seen.push(text);
  if (tok !== admin) userSeen.push(text);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

/** Raw GET/POST for binary answers (not kept for the leak checks: they are not text). */
async function raw(method: string, path: string, body: unknown, tok: string) {
  const r = await fetch(s.base + path, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, type: r.headers.get("content-type") ?? "", bytes: Buffer.from(await r.arrayBuffer()) };
}

/** Writes to the server's database file (the test server's own file), for states the API cannot reach in a test (usage by time). */
function dbWrite(fn: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(s.tmp, "t.db"));
  try { fn(db); } finally { db.close(); }
}
const pad = (n: number) => String(n).padStart(2, "0");
/** Today's local day, the same rule as the server's localDay (both run on this machine). */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const login = async (username: string) => (await api(s.base, "POST", "/auth/login", { username, password: PW })).json as { token: string; userId: string };
const adminModels = async () => (await call("GET", "/voice/admin/models", undefined, admin)).json;
const voicesOf = async (tok: string) => (await call("GET", "/voice/voices", undefined, tok)).json.models as any[];

before(async () => {
  fake = await startFakeAria({ chatToken: CHAT, adminToken: ADMIN });
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  for (const [username, role] of [["voiceadmin", "admin"], ["alice", "user"], ["bob", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username, password: PW, role })).status, 200);
  }
  const a = await login("voiceadmin"), al = await login("alice"), b = await login("bob");
  admin = a.token; alice = al.token; aliceId = al.userId; bob = b.token; bobId = b.userId;
  assert.ok(admin && alice && bob, "logins failed");
});
after(async () => { await fake?.stop(); s?.stop(); });

test("1. status is off until the admin turns voice on", async () => {
  const r = await call("GET", "/voice/status", undefined, alice);
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, "off");
  assert.equal(r.json.ready, false);
});

test("2. 401 without a token", async () => {
  assert.equal((await call("GET", "/voice/status")).status, 401);
  assert.equal((await call("GET", "/voice/voices")).status, 401);
  assert.equal((await call("GET", "/voice/usage")).status, 401);
  assert.equal((await call("GET", "/voice/diagnose")).status, 401);
  assert.equal((await call("GET", "/voice/admin/config")).status, 401);
});

test("3. PUT admin config: hosted + URL + tokens; GET shows only the *Set flags; dailyLimitMinutes is kept", async () => {
  const put = await call("PUT", "/voice/admin/config", { mode: "hosted", baseUrl: fake.baseUrl, chatToken: CHAT, adminToken: ADMIN, dailyLimitMinutes: 0 }, admin);
  assert.equal(put.status, 200);
  const g = await call("GET", "/voice/admin/config", undefined, admin);
  assert.equal(g.status, 200);
  assert.equal(g.json.mode, "hosted");
  assert.equal(g.json.chatTokenSet, true);
  assert.equal(g.json.adminTokenSet, true);
  assert.equal(g.json.dailyLimitMinutes, 0);
  assert.equal("chatToken" in g.json, false);
  assert.equal("adminToken" in g.json, false);
  assert.equal("allowedLlm" in g.json, false, "the per-call LLM list is gone");
  const st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.json.mode, "hosted");
  assert.equal(st.json.ready, true, "Aria is up, so ready");
  assert.equal(st.json.canAdmin, false);
  assert.equal((await call("GET", "/voice/status", undefined, admin)).json.canAdmin, true);
});

test("4. /voice/admin/* is 403 for a normal user, 200 for an admin", async () => {
  for (const [m, p, body] of [
    ["GET", "/voice/admin/config", undefined], ["PUT", "/voice/admin/config", { mode: "off" }], ["GET", "/voice/admin/users", undefined],
    ["GET", "/voice/admin/models", undefined], ["GET", "/voice/admin/llm", undefined], ["GET", "/voice/admin/placement", undefined],
    ["GET", "/voice/admin/usage", undefined], ["PUT", "/voice/admin/llm/roles", { role: "fast", model: "m2" }],
    ["PUT", "/voice/admin/quota", { dailyMinutes: 1 }],
  ] as const) {
    assert.equal((await call(m, p, body, alice)).status, 403, `${m} ${p}`);
  }
  for (const p of ["/voice/admin/users", "/voice/admin/usage", "/voice/admin/llm"]) {
    assert.equal((await call("GET", p, undefined, admin)).status, 200, p);
  }
});

test("5. mode off -> 409 voice_off on the call API (status and usage still answer)", async () => {
  assert.equal((await call("PUT", "/voice/admin/config", { mode: "off" }, admin)).status, 200);
  const r = await call("GET", "/voice/voices", undefined, alice);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "voice_off");
  const st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.status, 200);
  assert.equal(st.json.mode, "off");
  assert.equal(st.json.ready, false);
  assert.equal((await call("GET", "/voice/usage", undefined, alice)).status, 200);
  assert.equal((await call("PUT", "/voice/admin/config", { mode: "hosted" }, admin)).status, 200);
});

test("6. /voice/me: ranges are rounded, effective speed 1.3 (balanced) / 1.0 (fast), llm is not a pref any more", async () => {
  assert.equal((await call("PUT", "/voice/me", { ttsMode: "balanced", speed: 9 }, alice)).status, 200);
  assert.equal((await call("GET", "/voice/me", undefined, alice)).json.speed, 2);
  let st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.json.me.effective.speed, 2, "an explicit speed wins over the default");

  assert.equal((await call("PUT", "/voice/me", { ttsMode: "balanced" }, alice)).status, 200);
  st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.json.me.effective.ttsMode, "balanced");
  assert.equal(st.json.me.effective.speed, 1.3);

  assert.equal((await call("PUT", "/voice/me", { ttsMode: "fast" }, alice)).status, 200);
  st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.json.me.effective.speed, 1.0);

  const withLlm = await call("PUT", "/voice/me", { ttsMode: "balanced", llm: { fast: { endpoint: "local", model: "m3" } } }, alice);
  assert.equal(withLlm.status, 200, "an unknown field is dropped, not an error");
  assert.equal("llm" in withLlm.json, false);
  assert.equal("llm" in (await call("GET", "/voice/me", undefined, alice)).json, false);
});

test("7. the per-user LLM routes are gone (admin gets 404 too)", async () => {
  assert.equal((await call("PUT", `/voice/admin/users/${aliceId}/llm`, { llm: null }, admin)).status, 404);
  assert.equal((await call("PUT", "/voice/admin/llm/allowed", { allowedLlm: [] }, admin)).status, 404);
});

test("8. upload .aivmx (200): the fake gets the exact bytes with the admin token; kind and owner are recorded", async () => {
  const bytes = randomBytes(4096);
  const r = await upload(alice, "alice-voice.aivmx", bytes);
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.uuid, "string");
  assert.equal(r.json.kind, "aivmx");
  aliceVoice = r.json.uuid;
  const post = [...fake.requests].reverse().find((x) => x.method === "POST" && x.path === "/voices/models");
  assert.ok(post);
  assert.equal(post.auth, ADMIN);
  assert.equal(post.query.name, "alice-voice.aivmx");
  assert.ok(Buffer.isBuffer(post.body) && post.body.equals(bytes), "body is the exact upload");
  const row = (await adminModels()).models.find((m: any) => m.uuid === aliceVoice);
  assert.equal(row.ownerUserId, aliceId);
  assert.equal(row.kind, "aivmx");
});

test("9. upload .aivmx answered with 204 (no body): the uuid is found by listing Aria's voices", async () => {
  fake.state.uploadNoBody = true;
  let r;
  try { r = await upload(alice, "nobody.aivmx", randomBytes(512)); } finally { fake.state.uploadNoBody = false; }
  assert.equal(r.status, 200, r.text);
  const fakeModel = fake.state.models.find((m) => m.name === "nobody");
  assert.ok(fakeModel, "Aria registered the model");
  assert.equal(r.json.uuid, fakeModel.uuid);
  const mine = (await voicesOf(alice)).find((m) => m.uuid === fakeModel.uuid);
  assert.equal(mine.kind, "aivmx");
  assert.equal(mine.mine, true);
});

test("10. upload .onnx / .zip / .json -> Fast window (piper): name is derived, file is zip / model / config", async () => {
  const z = await upload(alice, "My Voice.zip", randomBytes(300));
  assert.equal(z.status, 200, z.text);
  assert.equal(z.json.id, "my-voice", "lowercase, spaces to -");
  assert.equal(z.json.kind, "piper");
  const zreq = [...fake.requests].reverse().find((x) => x.method === "POST" && x.path === "/voices/fast/models");
  assert.equal(zreq?.query.name, "my-voice");
  assert.equal(zreq?.query.file, "zip");
  assert.equal(zreq?.auth, ADMIN);
  assert.equal(fake.state.fast.find((m) => m.id === "my-voice")?.files.includes("zip"), true);
  const row = (await adminModels()).models.find((m: any) => m.uuid === "my-voice");
  assert.equal(row.kind, "piper");
  assert.equal(row.ownerUserId, aliceId);

  // one Fast voice from an .onnx and its .json: the same id, two files
  assert.equal((await upload(alice, "voice.onnx", Buffer.from("ONNX-BYTES"))).status, 200);
  assert.equal((await upload(alice, "voice.json", Buffer.from("{}"))).status, 200);
  assert.deepEqual(fake.state.fast.find((m) => m.id === "voice")?.files, ["model", "config"]);
  const cfg = fake.requests.findLast((x) => x.path === "/voices/fast/models" && x.query.file === "config");
  assert.equal(cfg?.query.name, "voice");
});

test("11. piper 422 from Aria -> 422 unsupported_format with Aria's message; nothing is stored", async () => {
  const n = fake.state.fast.length;
  const r = await upload(alice, "bad-voice.onnx", Buffer.from("BAD-ONNX"));
  assert.equal(r.status, 422);
  assert.equal(r.json.code, "unsupported_format");
  assert.equal(r.json.error, "not a piper-plus model");
  assert.equal(fake.state.fast.length, n);
  assert.equal((await adminModels()).models.some((m: any) => m.uuid === "bad-voice"), false);
});

test("12. kind and extension must agree; unknown extensions -> 415; a bad kind value -> 400", async () => {
  assert.equal((await upload(alice, "evil.exe", Buffer.from("MZ"))).status, 415);
  assert.equal((await upload(alice, "notes.txt", Buffer.from("hi"))).status, 415);
  assert.equal((await upload(alice, "no-extension", Buffer.from("hi"))).status, 415);
  const x = await upload(alice, "x.onnx", Buffer.from("ONNX"), "&kind=aivmx");
  assert.equal(x.status, 415, "a .onnx file cannot be a standard voice");
  assert.equal(x.json.code, "unsupported_format");
  const y = await upload(alice, "y.aivmx", Buffer.from("AIVMX"), "&kind=piper");
  assert.equal(y.status, 415, "a .aivmx file cannot be a Fast voice");
  assert.equal(y.json.code, "unsupported_format");
  assert.equal((await upload(alice, "z.onnx", Buffer.from("ONNX"), "&kind=bogus")).status, 400);
  assert.ok(!fake.requests.some((x) => x.path === "/voices/models" && x.query.name === "x.onnx"), "415 never reaches Aria");
});

test("13. name derivation for Fast voices: case, non-ASCII, length, path tricks", async () => {
  const up = await upload(alice, "Long Name Here Test.ONNX", Buffer.from("ONNX"));
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.id, "long-name-here-test", "the extension is matched in any case");
  const long = await upload(alice, "a".repeat(60) + ".onnx", Buffer.from("ONNX"));
  assert.equal(long.status, 200, long.text);
  assert.equal(long.json.id.length, 40, "Aria's limit of 40 characters");
  assert.equal((await upload(alice, "あいう.onnx", Buffer.from("ONNX"))).status, 400, "no letters or digits left");
  assert.equal((await upload(alice, "../x.onnx", Buffer.from("ONNX"))).status, 400);
  assert.equal((await upload(alice, "", Buffer.from("ONNX"))).status, 400);
  assert.equal((await upload(alice, "empty.onnx", Buffer.alloc(0))).status, 400, "an empty body");
});

test("14. /voice/voices lists both windows with kind, owner and mine", async () => {
  const models = await voicesOf(alice);
  // Fast entries carry their Aria id as `id` (no `uuid`): see the todo test below
  const by = (u: string) => models.find((m) => (m.uuid ?? m.id) === u);
  assert.equal(by("seed-uuid-1").kind, "aivmx");
  assert.equal(by("seed-uuid-1").ownerUserId, null);
  assert.equal(by("seed-uuid-1").mine, false);
  assert.equal(by("seed-fast").kind, "piper", "the Fast list comes from /voices/fast");
  assert.equal(by("seed-fast").ownerUserId, null);
  assert.equal(by(aliceVoice).kind, "aivmx");
  assert.equal(by(aliceVoice).ownerUserId, aliceId);
  assert.equal(by(aliceVoice).mine, true);
  assert.equal(by("my-voice").kind, "piper");
  assert.equal(by("my-voice").mine, true);
  const b = await voicesOf(bob);
  assert.equal(b.find((m) => (m.uuid ?? m.id) === "my-voice").mine, false);
  assert.equal(b.find((m) => (m.uuid ?? m.id) === "my-voice").ownerUserId, aliceId);
});

// BUG (implementation, not fixed here): GET /voice/voices builds the Fast entries from Aria's /voices/fast with `id` only.
// The standard entries have `uuid`, which is what the client uses for DELETE /voice/voices/models/:uuid. Expected: the same key.
test("14b. every voice entry has a uuid (Fast entries carry uuid = id)", async () => {
  const fastEntry = (await voicesOf(alice)).find((m) => m.id === "seed-fast");
  assert.equal(fastEntry?.uuid, "seed-fast");
});

test("15. delete routes by kind; non-owner 403, unknown 404, the built-in voice 400", async () => {
  // a non-owner cannot delete a Fast voice
  const denied = await call("DELETE", "/voice/voices/models/my-voice", undefined, bob);
  assert.equal(denied.status, 403);
  assert.ok(fake.state.fast.some((m) => m.id === "my-voice"), "still there");
  // a voice with no owner row (Aria's own seed) is not the user's to delete
  const seedFast = await call("DELETE", "/voice/voices/models/seed-fast", undefined, alice);
  assert.ok([403, 404].includes(seedFast.status));
  assert.ok(fake.state.fast.some((m) => m.id === "seed-fast"));
  assert.equal((await call("DELETE", "/voice/voices/models/nope-nope", undefined, alice)).status, 404);
  // the built-in voice is never deleted
  const builtin = await call("DELETE", "/voice/voices/models/tsukuyomi", undefined, admin);
  assert.equal(builtin.status, 400);
  assert.equal(builtin.json.code, "builtin_voice");

  // the owner's Fast voice goes to /voices/fast/<id>
  assert.equal((await call("DELETE", "/voice/voices/models/my-voice", undefined, alice)).status, 200);
  const fdel = fake.requests.findLast((x) => x.method === "DELETE");
  assert.equal(fdel?.path, "/voices/fast/my-voice");
  assert.equal(fake.state.fast.some((m) => m.id === "my-voice"), false);
  assert.equal((await adminModels()).models.some((m: any) => m.uuid === "my-voice"), false);

  // the owner's standard voice goes to /voices/models/<uuid>
  assert.equal((await call("DELETE", `/voice/voices/models/${aliceVoice}`, undefined, alice)).status, 200);
  assert.equal(fake.requests.findLast((x) => x.method === "DELETE")?.path, `/voices/models/${aliceVoice}`);
  assert.equal(fake.state.models.some((m) => m.uuid === aliceVoice), false);
  assert.equal((await adminModels()).models.some((m: any) => m.uuid === aliceVoice), false);

  // an admin may delete any user's standard voice
  bobVoice = (await upload(bob, "bob-voice.aivmx", randomBytes(256))).json.uuid;
  assert.ok(bobVoice);
  assert.equal((await call("DELETE", `/voice/voices/models/${bobVoice}`, undefined, admin)).status, 200);
  assert.equal(fake.state.models.some((m) => m.uuid === bobVoice), false);
});

test("16. usage: zero for a new user; a stored day shows in /voice/usage and the admin views", async () => {
  const z = await call("GET", "/voice/usage", undefined, alice);
  assert.equal(z.status, 200);
  assert.deepEqual(z.json.today, { callSeconds: 0, turns: 0, replyChars: 0 });
  assert.deepEqual(z.json.days, []);
  assert.equal(z.json.dailyLimitMinutes, 0);
  assert.equal(z.json.exceeded, false);

  dbWrite((db) => db.prepare("INSERT OR REPLACE INTO voice_usage (user_id, day, call_seconds, turns, reply_chars) VALUES (?,?,?,?,?)")
    .run(aliceId, today(), 120, 3, 50));
  const u = (await call("GET", "/voice/usage", undefined, alice)).json;
  assert.deepEqual(u.today, { callSeconds: 120, turns: 3, replyChars: 50 });
  assert.equal(u.days.length, 1);
  assert.equal(u.days[0].day, today());
  assert.equal(u.days[0].turns, 3);
  assert.equal((await call("GET", "/voice/usage", undefined, bob)).json.today.turns, 0, "usage is per user");

  const au = (await call("GET", "/voice/admin/usage", undefined, admin)).json;
  const row = au.users.find((x: any) => x.id === aliceId);
  assert.deepEqual(row.today, { callSeconds: 120, turns: 3, replyChars: 50 });
  assert.deepEqual(row.last30, { callSeconds: 120, turns: 3, replyChars: 50 });
  assert.ok(au.users.every((x: any) => "today" in x && "last30" in x));
  const users = (await call("GET", "/voice/admin/users", undefined, admin)).json.users.find((x: any) => x.id === aliceId);
  assert.deepEqual(users.today, { callSeconds: 120, turns: 3, replyChars: 50 });
});

test("17. dailyLimitMinutes: validated 0..1440, and exceeded once today's call time reaches it", async () => {
  assert.equal((await call("PUT", "/voice/admin/config", { dailyLimitMinutes: 1441 }, admin)).status, 400);
  assert.equal((await call("PUT", "/voice/admin/config", { dailyLimitMinutes: 1.5 }, admin)).status, 400);
  assert.equal((await call("PUT", "/voice/admin/config", { dailyLimitMinutes: 1 }, admin)).status, 200);
  assert.equal((await call("GET", "/voice/admin/config", undefined, admin)).json.dailyLimitMinutes, 1);
  const u = (await call("GET", "/voice/usage", undefined, alice)).json;
  assert.equal(u.dailyLimitMinutes, 1);
  assert.equal(u.exceeded, true, "120 s >= 1 minute");
  assert.equal((await call("GET", "/voice/usage", undefined, bob)).json.exceeded, false);
  assert.equal((await call("GET", "/voice/admin/usage", undefined, admin)).json.dailyLimitMinutes, 1);
  assert.equal((await call("PUT", "/voice/admin/config", { dailyLimitMinutes: 0 }, admin)).status, 200);
  assert.equal((await call("GET", "/voice/usage", undefined, alice)).json.exceeded, false, "0 = unlimited");
});

test("17b. per-user daily limit: an override beats the common one (0 = unlimited, null removes it); the common one is set by PUT /voice/admin/quota too", async () => {
  // validation (0..1440 integer or null; userId a string; unknown user 404)
  for (const body of [{ dailyMinutes: 1441 }, { dailyMinutes: 1.5 }, { dailyMinutes: "5" }, {}, { userId: aliceId, dailyMinutes: -1 }, { userId: 7, dailyMinutes: 5 }]) {
    assert.equal((await call("PUT", "/voice/admin/quota", body, admin)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("PUT", "/voice/admin/quota", { userId: "no-such-user", dailyMinutes: 5 }, admin)).status, 404);

  // common 1 minute; alice has 120 s today (over it), bob has none
  assert.equal((await call("PUT", "/voice/admin/quota", { dailyMinutes: 1 }, admin)).status, 200);
  assert.equal((await call("GET", "/voice/admin/config", undefined, admin)).json.dailyLimitMinutes, 1, "no userId = the common limit");

  // alice's override 5 minutes: 120 s is under it, so not exceeded, and her own view shows 5
  const set = await call("PUT", "/voice/admin/quota", { userId: aliceId, dailyMinutes: 5 }, admin);
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.dailyMinutes, 5);
  let u = (await call("GET", "/voice/usage", undefined, alice)).json;
  assert.equal(u.dailyLimitMinutes, 5);
  assert.equal(u.exceeded, false, "120 s < 5 min");

  // bob: 60 s today is over the common 1 minute; an override of 0 lifts it; null goes back to the common one
  dbWrite((db) => db.prepare("INSERT OR REPLACE INTO voice_usage (user_id, day, call_seconds, turns, reply_chars) VALUES (?,?,?,?,?)")
    .run(bobId, today(), 60, 0, 0));
  u = (await call("GET", "/voice/usage", undefined, bob)).json;
  assert.equal(u.dailyLimitMinutes, 1);
  assert.equal(u.exceeded, true, "60 s >= 1 minute (common)");
  assert.equal((await call("PUT", "/voice/admin/quota", { userId: bobId, dailyMinutes: 0 }, admin)).status, 200);
  u = (await call("GET", "/voice/usage", undefined, bob)).json;
  assert.equal(u.dailyLimitMinutes, 0);
  assert.equal(u.exceeded, false, "0 = unlimited for this user");
  const cleared = await call("PUT", "/voice/admin/quota", { userId: bobId, dailyMinutes: null }, admin);
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.dailyMinutes, null);
  assert.equal((await call("GET", "/voice/usage", undefined, bob)).json.exceeded, true, "override removed: the common 1 minute again");

  // the common limit null = unlimited (stored as 0); alice's override still applies to her
  assert.equal((await call("PUT", "/voice/admin/quota", { dailyMinutes: null }, admin)).status, 200);
  assert.equal((await call("GET", "/voice/admin/config", undefined, admin)).json.dailyLimitMinutes, 0);
  assert.equal((await call("GET", "/voice/usage", undefined, bob)).json.exceeded, false, "common 0 = unlimited");
  u = (await call("GET", "/voice/usage", undefined, alice)).json;
  assert.equal(u.dailyLimitMinutes, 5, "alice keeps her override");

  // the admin usage view: the overrides are listed per user (null = none)
  const au = (await call("GET", "/voice/admin/usage", undefined, admin)).json;
  assert.equal(au.defaultDailyMinutes, 0);
  assert.equal(au.users.find((x: any) => x.id === aliceId).dailyMinutes, 5);
  assert.equal(au.users.find((x: any) => x.id === bobId).dailyMinutes, null);

  // the Server app's mirror: PUT /local-admin/voice/quota is the same route
  const m = await call("PUT", "/local-admin/voice/quota", { userId: bobId, dailyMinutes: 2 }, "", { "x-local-admin": localTok });
  assert.equal(m.status, 200, m.text);
  assert.equal((await call("GET", "/voice/admin/usage", undefined, admin)).json.users.find((x: any) => x.id === bobId).dailyMinutes, 2);
  assert.equal((await call("PUT", "/local-admin/voice/quota", { dailyMinutes: 3 }, "", { "x-local-admin": localTok })).status, 200);
  assert.equal((await call("GET", "/voice/admin/config", undefined, admin)).json.dailyLimitMinutes, 3);
  assert.equal((await call("PUT", "/local-admin/voice/quota", { dailyMinutes: 3 })).status, 401, "loopback + local-admin token only");

  // back to the state the later tests expect: common 0, no override for bob, alice's override removed
  assert.equal((await call("PUT", "/voice/admin/quota", { userId: bobId, dailyMinutes: null }, admin)).status, 200);
  assert.equal((await call("PUT", "/voice/admin/quota", { userId: aliceId, dailyMinutes: null }, admin)).status, 200);
  assert.equal((await call("PUT", "/voice/admin/quota", { dailyMinutes: 0 }, admin)).status, 200);
});

test("17c. /voice/admin/usage?days=7|30: callMinutes (one decimal), turns, replyChars for the period; last30 stays 30 days", async () => {
  const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  // alice: today 120 s / 3 turns / 50 chars (test 16); add 10 days ago: 600 s / 2 turns / 40 chars
  dbWrite((db) => db.prepare("INSERT OR REPLACE INTO voice_usage (user_id, day, call_seconds, turns, reply_chars) VALUES (?,?,?,?,?)")
    .run(aliceId, daysAgo(10), 600, 2, 40));

  const d7 = (await call("GET", "/voice/admin/usage?days=7", undefined, admin)).json;
  assert.equal(d7.days, 7);
  const a7 = d7.users.find((x: any) => x.id === aliceId);
  assert.equal(a7.callMinutes, 2, "120 s = 2.0 min (the 10-day-old row is out of the 7 days)");
  assert.equal(a7.turns, 3);
  assert.equal(a7.replyChars, 50);
  assert.deepEqual(a7.today, { callSeconds: 120, turns: 3, replyChars: 50 });
  assert.deepEqual(a7.last30, { callSeconds: 720, turns: 5, replyChars: 90 }, "last30 is always the last 30 days");

  const d30 = (await call("GET", "/voice/admin/usage", undefined, admin)).json;
  assert.equal(d30.days, 30, "default 30");
  const a30 = d30.users.find((x: any) => x.id === aliceId);
  assert.equal(a30.callMinutes, 12, "(120 + 600) s = 12.0 min");
  assert.equal(a30.turns, 5);
  assert.equal(a30.replyChars, 90);
  assert.equal(a30.dailyMinutes, null);
  assert.equal(d30.defaultDailyMinutes, 0);
  assert.equal(d30.dailyLimitMinutes, 0, "the existing field stays");
  assert.ok(d30.users.every((x: any) => "callMinutes" in x && "turns" in x && "replyChars" in x && "dailyMinutes" in x && "today" in x && "last30" in x && "isAdmin" in x && "username" in x));
  const bobRow = d30.users.find((x: any) => x.id === bobId);
  assert.equal(bobRow.callMinutes, 1, "bob's 60 s from test 17b");

  for (const bad of ["days=14", "days=abc", "days=0"]) {
    assert.equal((await call("GET", `/voice/admin/usage?${bad}`, undefined, admin)).status, 400, bad);
  }
  const mirror = await call("GET", "/local-admin/voice/usage?days=7", undefined, "", { "x-local-admin": localTok });
  assert.equal(mirror.status, 200);
  assert.deepEqual(mirror.json, d7, "the mirror passes the query on");
  // the own-usage route is unchanged in shape
  assert.ok(Array.isArray((await call("GET", "/voice/usage", undefined, alice)).json.days));

  dbWrite((db) => db.prepare("DELETE FROM voice_usage WHERE user_id = ? AND day = ?").run(aliceId, daysAgo(10)));
});

test("18. /local-admin/voice/usage and /diagnose mirror the admin side (loopback + local-admin token)", async () => {
  const m = await call("GET", "/local-admin/voice/usage", undefined, "", { "x-local-admin": localTok });
  assert.equal(m.status, 200);
  assert.deepEqual(m.json, (await call("GET", "/voice/admin/usage", undefined, admin)).json);
  const d = await call("GET", "/local-admin/voice/diagnose", undefined, "", { "x-local-admin": localTok });
  assert.equal(d.status, 200);
  assert.ok(Array.isArray(d.json));
  assert.equal((await call("GET", "/local-admin/voice/usage")).status, 401);
});

test("19. diagnose: all ok when Aria is healthy, with [{id, ok, message, hint}] and empty hints", async () => {
  const r = await call("GET", "/voice/diagnose", undefined, alice);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  for (const c of r.json) {
    assert.equal(typeof c.id, "string");
    assert.equal(typeof c.ok, "boolean");
    assert.equal(typeof c.message, "string");
    assert.equal(typeof c.hint, "string");
    assert.equal(c.ok, true, `${c.id}: ${c.message}`);
    assert.equal(c.hint, "");
  }
  const ids = r.json.map((c: any) => c.id);
  for (const id of ["aria_reachable", "aria_health", "stt", "tts_modes", "llm_roles"]) assert.ok(ids.includes(id), id);
});

test("20. diagnose: a degraded /health, a missing role, and a missing Fast mode are reported with a hint", async () => {
  const find = async (id: string) => ((await call("GET", "/voice/diagnose", undefined, alice)).json as any[]).find((c) => c.id === id);

  fake.state.health = "degraded";
  try {
    const h = await find("aria_health");
    assert.equal(h.ok, false);
    assert.ok(h.message.includes("degraded"));
    assert.ok(h.hint.length > 0);
  } finally { fake.state.health = "ok"; }

  (fake.state.llm.roles as any).deep = undefined;
  try {
    const l = await find("llm_roles");
    assert.equal(l.ok, false);
    assert.ok(l.message.includes("deep"));
    assert.ok(l.hint.length > 0);
  } finally { fake.state.llm.roles.deep = { endpoint: "local", model: "m3" }; }

  fake.state.ttsModes = ["balanced"];
  try {
    const t = await find("tts_modes");
    assert.equal(t.ok, false);
    assert.ok(t.message.includes("fast"));
    assert.ok(t.hint.length > 0);
  } finally { fake.state.ttsModes = ["balanced", "fast"]; }

  // the key missing: the list is unknown, treated as the default (balanced and fast), so it is ok
  fake.state.ttsModes = null;
  try {
    const t = await find("tts_modes");
    assert.equal(t.ok, true);
  } finally { fake.state.ttsModes = ["balanced", "fast"]; }

  fake.state.placementOk = false;
  try {
    const st = await find("stt");
    assert.equal(st.ok, false, "placement unreadable");
    assert.equal((await find("tts_modes")).ok, false);
  } finally { fake.state.placementOk = true; }

  const all = await find("aria_health");
  assert.equal(all.ok, true, "restored");
});

test("21. diagnose: mode off -> one voice_off check", async () => {
  assert.equal((await call("PUT", "/voice/admin/config", { mode: "off" }, admin)).status, 200);
  try {
    const r = await call("GET", "/voice/diagnose", undefined, alice);
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id, "voice_off");
    assert.equal(r.json[0].ok, false);
  } finally {
    assert.equal((await call("PUT", "/voice/admin/config", { mode: "hosted" }, admin)).status, 200);
  }
});

test("22. preview: a WAV from Aria is passed through; the request carries the mode and the speed", async () => {
  assert.equal((await call("PUT", "/voice/me", { ttsMode: "balanced" }, alice)).status, 200);
  const r = await raw("POST", "/voice/preview", { text: "テスト" }, alice);
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith("audio/wav"), r.type);
  assert.ok(r.bytes.equals(fakeWav()), "the bytes are Aria's");
  assert.equal(r.bytes.subarray(0, 4).toString("latin1"), "RIFF");
  const req = fake.requests.findLast((x) => x.path === "/tts/preview");
  assert.equal(req?.body.text, "テスト");
  assert.equal(req?.body.tts_mode, "balanced");
  assert.equal(req?.body.speed, 1.3, "balanced default speed");

  const f = await raw("POST", "/voice/preview", { text: "はい", ttsMode: "fast" }, alice);
  assert.equal(f.status, 200);
  const freq = fake.requests.findLast((x) => x.path === "/tts/preview");
  assert.equal(freq?.body.tts_mode, "fast");
  assert.equal(freq?.body.speed, 1, "fast default speed");

  const bad = await call("POST", "/voice/preview", { text: "" }, alice);
  assert.equal(bad.status, 400);
  assert.equal((await call("POST", "/voice/preview", { text: "x".repeat(201) }, alice)).status, 400);
  assert.equal((await call("POST", "/voice/preview", { text: "a", ttsMode: "x" }, alice)).status, 400);
  assert.equal((await call("POST", "/voice/preview", { text: "a" })).status, 401);
});

test("23. preview: Aria without a read-aloud REST (404) -> 501 not_supported_yet", async () => {
  fake.state.previewOk = false;
  try {
    const r = await call("POST", "/voice/preview", { text: "テスト" }, alice);
    assert.equal(r.status, 501);
    assert.equal(r.json.code, "not_supported_yet");
  } finally { fake.state.previewOk = true; }
});

test("24. status ready needs Aria's /health and /voice/placement to answer 200", async () => {
  const ready = async () => (await call("GET", "/voice/status", undefined, alice)).json.ready;
  assert.equal(await ready(), true);
  fake.state.healthCode = 503;
  try { assert.equal(await ready(), false, "/health 503"); } finally { fake.state.healthCode = 200; }
  fake.state.placementOk = false;
  try { assert.equal(await ready(), false, "/voice/placement 500"); } finally { fake.state.placementOk = true; }
  assert.equal(await ready(), true);
});

test("25. admin placement and Whisper settings still relay (admin only)", async () => {
  const g = await call("GET", "/voice/admin/placement", undefined, admin);
  assert.equal(g.status, 200);
  assert.ok(JSON.stringify(g.json).includes("GPU 0 (test)"));
  const p = await call("PUT", "/voice/admin/placement/stt", { model: "large-v3-turbo", device: "cpu", device_index: 0, url: "" }, admin);
  assert.equal(p.status, 200, p.text);
  assert.equal(fake.state.placement.stt.model, "large-v3-turbo");
  assert.equal(fake.requests.findLast((x) => x.path === "/voice/placement/stt")?.auth, ADMIN);
  assert.equal((await call("PUT", "/voice/admin/placement/stt", { model: "tiny" }, alice)).status, 403);
});

test("26. admin LLM: roles are forwarded as target:role; a rejected model passes Aria's available list; the model list is shown", async () => {
  const ok = await call("PUT", "/voice/admin/llm/roles", { role: "fast", endpoint: "local", model: "m2" }, admin);
  assert.equal(ok.status, 200, ok.text);
  const post = fake.requests.findLast((x) => x.method === "POST" && x.path === "/llm/model");
  assert.equal(post?.auth, ADMIN);
  assert.equal(post?.body.target, "role");
  assert.equal(post?.body.name, "fast");
  assert.equal(post?.body.model, "m2");
  assert.equal(fake.state.llm.roles.fast.model, "m2");

  const bad = await call("PUT", "/voice/admin/llm/roles", { role: "deep", endpoint: "local", model: "bad" }, admin);
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.available, ["m1", "m2", "m3"]);

  const g = await call("GET", "/voice/admin/llm", undefined, admin);
  assert.equal(g.status, 200);
  assert.equal(g.json.roles.fast.model, "m2", "Aria's /llm/endpoints answer, normalised: roles");
  assert.ok(Array.isArray(g.json.endpoints), "endpoints is a list of {id, name, models}");
  assert.equal(g.json.models.length, 3, "Aria's /llm/models, under models");
  assert.equal("allowedLlm" in g.json, false);
  assert.equal((await call("PUT", "/voice/admin/llm/roles", { role: "fast", model: "" }, admin)).status, 400);
  assert.equal((await call("PUT", "/voice/admin/llm/roles", { role: "mid", model: "m1" }, admin)).status, 400);
  assert.equal((await call("PUT", "/voice/admin/llm/roles", { role: "fast", model: "m1" }, admin)).status, 200);
});

test("26b. admin models: kind, ready and builtin; Aria's Fast voices without a row are listed; Aria not answering = the rows only", async () => {
  // Aria's built-in Fast voice (no owner), one with Aria's own ready flag, and one ready flag that says no
  fake.state.fast.push({ id: "tsukuyomi", name: "tsukuyomi", files: ["model", "config"] });
  fake.state.fast.push({ id: "flag-only", name: "flag-only", files: [], ready: true });
  fake.state.fast.push({ id: "flag-no", name: "flag-no", files: ["model", "config"], ready: false });
  try {
    const models = (await adminModels()).models as any[];
    const by = (u: string) => models.find((m) => m.uuid === u);
    for (const m of models) {
      assert.equal(typeof m.ready, "boolean", `${m.uuid}: ready is a boolean`);
      assert.equal(typeof m.builtin, "boolean", `${m.uuid}: builtin is a boolean`);
    }
    // the built-in voice: listed although it has no row, owner null, builtin, ready from its files
    assert.equal(by("tsukuyomi").kind, "piper");
    assert.equal(by("tsukuyomi").builtin, true);
    assert.equal(by("tsukuyomi").ownerUserId, null);
    assert.equal(by("tsukuyomi").ready, true);
    assert.equal(by("seed-fast").builtin, true, "Aria's own ownerless Fast voice");
    assert.equal(by("flag-only").ready, true, "Aria's ready flag wins over the files");
    assert.equal(by("flag-only").builtin, true);
    assert.equal(by("flag-no").ready, false, "Aria's ready flag wins over the files");
    // the users' Fast voices: ready when both .onnx and config are there (the voice from test 10), not when one is missing
    assert.equal(by("voice").kind, "piper");
    assert.equal(by("voice").builtin, false);
    assert.equal(by("voice").ownerUserId, aliceId);
    assert.equal(by("voice").ready, true);
    assert.equal(by("long-name-here-test").ready, false, "only the .onnx was uploaded");
    // standard voices are always ready
    assert.equal(by(aliceVoice ?? "x"), undefined, "alice's standard voice was deleted in test 15");
    for (const m of models.filter((x) => x.kind === "aivmx")) assert.equal(m.ready, true);
    // the built-in voice has no delete button: Aria's own, ownerless
    assert.equal(models.filter((m) => m.builtin).every((m) => m.kind === "piper"), true);

    // Aria cannot list its Fast voices: the rows are still there, the Fast ones not ready, no built-in entries
    fake.state.fastCode = 503;
    try {
      const down = (await adminModels()).models as any[];
      assert.equal(down.some((m) => m.uuid === "tsukuyomi"), false, "not listed when Aria cannot be asked");
      assert.equal(down.find((m) => m.uuid === "voice").ready, false);
      assert.equal(down.find((m) => m.uuid === "voice").ownerUserId, aliceId, "the row is still listed");
      assert.ok(down.filter((m) => m.kind === "aivmx").every((m) => m.ready === true));
    } finally { fake.state.fastCode = 200; }
    assert.equal((await adminModels()).models.some((m: any) => m.uuid === "tsukuyomi"), true);
  } finally {
    for (const id of ["tsukuyomi", "flag-only", "flag-no"]) {
      const i = fake.state.fast.findIndex((m) => m.id === id);
      if (i >= 0) fake.state.fast.splice(i, 1);
    }
  }
  assert.equal((await call("GET", "/voice/admin/models", undefined, alice)).status, 403);
});

test("27. no response body contains a token; no non-admin response contains the Aria URL", () => {
  assert.ok(seen.length > 40);
  assert.ok(userSeen.length > 20);
  for (const body of seen) {
    assert.equal(body.includes(CHAT), false);
    assert.equal(body.includes(ADMIN), false);
    assert.equal(body.includes(localTok), false);
  }
  for (const body of userSeen) assert.equal(body.includes(fake.baseUrl), false);
});

test("28. the stored tokens are encrypted in the database", async () => {
  const db = new DatabaseSync(join(s.tmp, "t.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'voice'").get() as { value: string } | undefined;
    assert.ok(row, "voice settings row");
    assert.equal(row.value.includes(CHAT), false, "chat token is not plaintext");
    assert.equal(row.value.includes(ADMIN), false, "admin token is not plaintext");
    const j = JSON.parse(row.value);
    assert.ok(String(j.chatToken).startsWith("enc1:"));
    assert.ok(String(j.adminToken).startsWith("enc1:"));
  } finally {
    db.close();
  }
});

test("29. Aria down -> 502 aria_unreachable; status not ready; diagnose says so; usage still answers (last: stops the fake)", async () => {
  await fake.stop();
  const r = await call("GET", "/voice/voices", undefined, alice);
  assert.equal(r.status, 502);
  assert.equal(r.json.code, "aria_unreachable");
  const st = await call("GET", "/voice/status", undefined, alice);
  assert.equal(st.json.ready, false);
  assert.equal((await call("GET", "/voice/usage", undefined, alice)).status, 200);
  const d = await call("GET", "/voice/diagnose", undefined, alice);
  assert.equal(d.status, 200);
  assert.equal(d.json.find((c: any) => c.id === "aria_reachable").ok, false);
  assert.ok(d.json.every((c: any) => c.ok === false), "nothing is ok when Aria is unreachable");
  assert.equal((await call("POST", "/voice/preview", { text: "a" }, alice)).status, 502);
});
