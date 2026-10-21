/* eslint-disable @typescript-eslint/no-explicit-any */
// Token-usage analytics (usage.ts + routes-usage.ts): pure day-bucket helpers, the SQL on a scratch database, and the
// HTTP endpoints against a real server child process (setup()/say() from test-chat-util).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, connect, newConv, say, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { api } from "./test-server.js";

// The SQL tests write rows into THIS process's database: point it at a throwaway directory before db.js loads
// (db.ts opens DB_PATH at import time, so the import has to be dynamic and come after the env is set).
const scratch = mkdtempSync(join(tmpdir(), "omni-usage-unit-"));
process.env.DATA_DIR = scratch;
process.env.DB_PATH = join(scratch, "t.db");
const usage = await import("./usage.js");
const { rawDb } = await import("./db.js");
after(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } });

const DAY = 86_400_000;
const T1 = Date.parse("2026-10-17T15:30:00Z"); // 00:30 on the 18th in JST, 03:30 on the 17th in UTC-12
const T2 = Date.parse("2026-10-17T11:30:00Z"); // 20:30 on the 17th in JST, 23:30 on the 16th in UTC-12
const NOW = Date.parse("2026-10-19T12:00:00Z");

// ---------- pure helpers ----------

test("clampTz: integer minutes, clamped, junk -> 0", () => {
  assert.equal(usage.clampTz(540), 540);
  assert.equal(usage.clampTz("-300"), -300);
  assert.equal(usage.clampTz(9999), 840);
  assert.equal(usage.clampTz(-9999), -840);
  assert.equal(usage.clampTz(5.9), 5);
  assert.equal(usage.clampTz("abc"), 0);
  assert.equal(usage.clampTz(undefined), 0);
});

test("parseMs: missing or non-numeric values are ignored (null)", () => {
  assert.equal(usage.parseMs("1700000000000"), 1700000000000);
  assert.equal(usage.parseMs(undefined), null);
  assert.equal(usage.parseMs(""), null);
  assert.equal(usage.parseMs("soon"), null);
});

test("local day buckets follow the offset, not the server zone", () => {
  // the same instant lands on different local days per tz
  const dayAt = (ms: number, tz: number) => usage.dayKey(usage.localDayIndex(ms, tz));
  assert.deepEqual([0, 540, -300, -720].map((tz) => dayAt(T1, tz)), ["2026-10-17", "2026-10-18", "2026-10-17", "2026-10-17"]);
  assert.deepEqual([0, 540, -300, -720].map((tz) => dayAt(T2, tz)), ["2026-10-17", "2026-10-17", "2026-10-17", "2026-10-16"]);
  for (const tz of [0, 540, -300, -720, 840, -840]) {
    for (const ms of [T1, T2]) {
      const start = usage.dayStartMs(usage.localDayIndex(ms, tz), tz);
      assert.ok(start <= ms && ms < start + DAY, `tz ${tz}: ${ms} inside its local day`);
    }
  }
  // local midnight of 2026-10-18 at JST is 2026-10-17T15:00Z
  assert.equal(usage.dayStartMs(usage.dayIndexOfKey("2026-10-18"), 540), Date.parse("2026-10-17T15:00:00Z"));
  assert.equal(usage.dayStartMs(usage.dayIndexOfKey("2026-10-18"), 0), Date.parse("2026-10-18T00:00:00Z"));
  assert.equal(usage.dayStartMs(usage.dayIndexOfKey("2026-10-18"), -300), Date.parse("2026-10-18T05:00:00Z"));
});

test("dayBuckets: N consecutive days, oldest first, ending at the given day", () => {
  const end = usage.localDayIndex(NOW, 540);
  const b = usage.dayBuckets(end, 3, 540);
  assert.equal(b.length, 3);
  assert.deepEqual(b.map((x) => x.day), ["2026-10-17", "2026-10-18", "2026-10-19"]);
  assert.equal(b[2].start - b[1].start, DAY);
  assert.equal(usage.dayBuckets(end, 1, 540)[0].day, "2026-10-19");
});

// ---------- SQL on the scratch database (persistent store, not the eph schema) ----------

const U1 = "pu-user-1", U2 = "pu-user-2";
const insertMetric = (id: string, user: string, conv: string, model: string, t: number, prompt: number, completion: number, reasoning: number, exact: number) => {
  rawDb.prepare(
    "INSERT INTO metrics (message_id, user_id, conversation_id, provider_id, provider_kind, model, prompt_tokens, completion_tokens, reasoning_tokens, source, usage_exact, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, user, conv, "pp-1", "openai-compatible", model, prompt, completion, reasoning, "backend", exact, t);
};
before(() => {
  for (const [id, user, title, del] of [["pc-1", U1, "Pure one", 0], ["pc-2", U1, "Gone", 1], ["pc-3", U2, "Other", 0]] as const) {
    rawDb.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,?,?)")
      .run(id, user, title, T1, T1, del, 1);
  }
  insertMetric("pm-1", U1, "pc-1", "m1", T1, 10, 5, 2, 1); // day 17 (UTC)
  insertMetric("pm-2", U1, "pc-1", "m2", T2, 4, 4, 0, 0); // estimated; day 17 (UTC)
  insertMetric("pm-3", U1, "pc-2", "m1", T1 + DAY, 1, 1, 0, 1); // deleted chat; day 18 (UTC)
  insertMetric("pm-4", U2, "pc-3", "m1", T1, 100, 0, 0, 1); // other user
  insertMetric("pm-5", U1, "eph_guard", "m1", T1, 1000, 1000, 0, 1); // ephemeral id in the persistent table: guard must hide it
});

test("summary: totals, estimated flag, avg, top model; deleted chats still count; eph guard hides eph_ rows", () => {
  const s = usage.usageSummary({ userId: U1, from: null, to: null, conversationId: null }, 0);
  assert.deepEqual(s.totals, {
    promptTokens: 15, completionTokens: 10, reasoningTokens: 2, totalTokens: 25,
    messages: 3, chats: 2, avgTokensPerAnswer: 8, estimatedMessages: 1,
  });
  assert.equal(s.estimated, true);
  assert.equal(s.topModel?.model, "m1");
  assert.equal(s.topModel?.totalTokens, 17);
  assert.equal(s.topModel?.providerName, null);
  assert.equal(s.from, null);
  assert.equal(s.tz, 0);
});

test("summary: from inclusive, to exclusive; scope null = all users", () => {
  assert.equal(usage.usageSummary({ userId: U1, from: T1, to: T1 + 1 }, 0).totals.messages, 1);
  assert.equal(usage.usageSummary({ userId: U1, from: T1, to: T1 }, 0).totals.messages, 0);
  assert.equal(usage.usageSummary({ userId: U1, from: T1 + 1, to: null }, 0).totals.messages, 1, "only the day-18 row");
  assert.equal(usage.usageSummary({ userId: null }, 0).totals.messages, 4, "eph_ row excluded, other user included");
  assert.equal(usage.usageSummary({ userId: U1, conversationId: "pc-2" }, 0).totals.totalTokens, 2);
});

test("daily days=0 (all): buckets from the first local day to today, zero-filled, totals match summary (tz 0)", () => {
  const d = usage.usageDaily({ userId: U1, days: 0, tz: 0, now: NOW }, rawDb);
  assert.deepEqual(d.days.map((x) => x.day), ["2026-10-17", "2026-10-18", "2026-10-19"]);
  assert.deepEqual(d.days.map((x) => x.messages), [2, 1, 0]);
  assert.deepEqual(d.days.map((x) => x.totalTokens), [23, 2, 0]);
  assert.equal(d.estimated, true);
  assert.equal(d.days.reduce((s, x) => s + x.totalTokens, 0), usage.usageSummary({ userId: U1 }, 0).totals.totalTokens);
});

test("daily: tz moves the same rows to other buckets; counts stay N", () => {
  const at540 = usage.usageDaily({ userId: U1, days: 0, tz: 540, now: NOW }, rawDb);
  assert.deepEqual(at540.days.map((x) => [x.day, x.messages]), [["2026-10-17", 1], ["2026-10-18", 1], ["2026-10-19", 1]]);
  const atM720 = usage.usageDaily({ userId: U1, days: 0, tz: -720, now: NOW }, rawDb);
  assert.deepEqual(atM720.days.map((x) => [x.day, x.messages]), [["2026-10-16", 1], ["2026-10-17", 1], ["2026-10-18", 1], ["2026-10-19", 0]]);
  assert.equal(atM720.days.length, 4);
});

test("daily: fixed N keeps only the window, zero-fills, starts at local midnight", () => {
  const d2 = usage.usageDaily({ userId: U1, days: 2, tz: 0, now: NOW }, rawDb);
  assert.deepEqual(d2.days.map((x) => [x.day, x.messages]), [["2026-10-18", 1], ["2026-10-19", 0]]);
  assert.equal(d2.days[0].start, Date.parse("2026-10-18T00:00:00Z"));
  const other = usage.usageDaily({ userId: U2, days: 3, tz: 0, now: NOW }, rawDb);
  assert.deepEqual(other.days.map((x) => x.messages), [1, 0, 0]);
  assert.equal(other.estimated, false);
  const d1 = usage.usageDaily({ userId: U1, days: 1, tz: 540, now: NOW }, rawDb);
  assert.equal(d1.days.length, 1);
  assert.equal(d1.days[0].day, "2026-10-19");
  assert.equal(d1.days[0].start, Date.parse("2026-10-18T15:00:00Z"));
  assert.deepEqual(usage.usageDaily({ userId: "nobody", days: 0, tz: 0, now: NOW }, rawDb), { tz: 0, days: [], estimated: false });
});

test("chats: deleted chats excluded, ordering, models per chat (most used first)", () => {
  const c = usage.usageChats({ userId: U1 }, 20, rawDb);
  assert.equal(c.chats.length, 1);
  assert.equal(c.chats[0].conversationId, "pc-1");
  assert.equal(c.chats[0].title, "Pure one");
  assert.equal(c.chats[0].totalTokens, 23);
  assert.deepEqual(c.chats[0].models, ["m1", "m2"]);
  assert.equal(c.chats[0].lastActivity, T1);
  assert.equal(c.estimated, true);
});

test("models: grouped per provider + model, share sums to 1", () => {
  const m = usage.usageModels({ userId: U1 }, rawDb);
  assert.deepEqual(m.models.map((x) => [x.model, x.totalTokens, x.messages, x.estimatedMessages]), [["m1", 17, 2, 0], ["m2", 8, 1, 1]]);
  assert.ok(Math.abs(m.models.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  assert.equal(m.models[0].providerId, "pp-1");
  assert.equal(m.estimated, true);
});

// ---------- HTTP endpoints against a real server ----------

let c: Ctx;
let cl: Client;
let bobTok = "";
let bobCl: Client;
let bobConv = "";
const convA = { id: "", title: "Alpha" }, convB = { id: "", title: "Beta" }, convC = { id: "", title: "Gone" }, convD = { id: "", title: "Delta" };
let ephId = "";

const get = (path: string, tok = c.token) => api(c.s.base, "GET", path, undefined, tok);
const ephemeralId = () => `eph_${randomUUID()}`;

before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  cl = await connect(c);
  // admin = first registered user (c.token)
  for (const x of [convA, convB, convC, convD]) x.id = await newConv(c, { title: x.title });
  for (let i = 0; i < 3; i++) await say(c, cl, convA.id, `a${i}`);
  await say(c, cl, convB.id, "b");
  for (let i = 0; i < 2; i++) await say(c, cl, convC.id, `c${i}`);
  await c.call("DELETE", `/conversations/${convC.id}`);
  await say(c, cl, convD.id, "d");

  // ephemeral chat: its tokens must never show up
  ephId = ephemeralId();
  const r = await c.call("PUT", `/conversations/${ephId}`, { ephemeral: true, providerId: c.provId, model: "fake-model", title: "Secret" });
  assert.equal(r.status, 200, r.text);
  for (let i = 0; i < 2; i++) {
    const userMessageId = ephemeralId(), assistantMessageId = ephemeralId();
    cl.send({ type: "send", conversationId: ephId, content: `e${i}`, userMessageId, assistantMessageId });
    await cl.waitMsg(assistantMessageId);
  }

  // second, non-admin user with one chat
  const reg = await api(c.s.base, "POST", "/auth/register", { username: "bob", password: "password123" });
  assert.equal(reg.status, 200, reg.text);
  assert.equal(reg.json.isAdmin, false);
  bobTok = reg.json.token;
  const provId = randomUUID();
  await api(c.s.base, "PUT", `/providers/${provId}`, { name: "BobProv", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model" }, bobTok);
  bobConv = randomUUID();
  const pr = await api(c.s.base, "PUT", `/conversations/${bobConv}`, { providerId: provId, title: "Bobs" }, bobTok);
  assert.equal(pr.status, 200, pr.text);
  bobCl = await connect(c, bobTok);
  await say(c, bobCl, bobConv, "hi from bob");
});

after(() => { bobCl?.ws.close(); cl?.ws.close(); c?.stop(); });

test("unauthenticated -> 401 on every usage route", async () => {
  for (const p of ["/usage/summary", "/usage/daily", "/usage/chats", "/usage/models"]) {
    const r = await api(c.s.base, "GET", p);
    assert.equal(r.status, 401, p);
  }
});

test("summary for the caller: exact totals, top model, ephemeral excluded", async () => {
  const r = await get("/usage/summary");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.totals, {
    promptTokens: 35, completionTokens: 14, reasoningTokens: 0, totalTokens: 49,
    messages: 7, chats: 4, avgTokensPerAnswer: 7, estimatedMessages: 0,
  });
  assert.equal(r.json.estimated, false);
  assert.equal(r.json.from, null);
  assert.equal(r.json.to, null);
  assert.equal(r.json.tz, 0);
  assert.equal(r.json.topModel.providerId, c.provId);
  assert.equal(r.json.topModel.providerName, "Fake");
  assert.equal(r.json.topModel.model, "fake-model");
  assert.equal(r.json.topModel.totalTokens, 49);
});

test("ephemeral chat never counted; its id is 404 for every filter", async () => {
  const s = await get("/usage/summary");
  assert.equal(s.json.totals.messages, 7, "the two ephemeral replies are not in the totals");
  const ch = await get("/usage/chats?limit=200");
  assert.ok(!ch.json.chats.some((x: any) => x.conversationId === ephId));
  const m = await get("/usage/models");
  assert.equal(m.json.models.reduce((n: number, x: any) => n + x.messages, 0), 7);
  assert.equal((await get(`/usage/summary?conversationId=${ephId}`)).status, 404);
});

test("conversationId filter: own chat only; deleted own chat still counted", async () => {
  const a = await get(`/usage/summary?conversationId=${convA.id}`);
  assert.equal(a.json.totals.messages, 3);
  assert.equal(a.json.totals.totalTokens, 21);
  assert.equal(a.json.totals.chats, 1);
  const cDel = await get(`/usage/summary?conversationId=${convC.id}`);
  assert.equal(cDel.json.totals.messages, 2, "deleted chat still in summary");
  assert.equal((await get(`/usage/summary?conversationId=${bobConv}`)).status, 404, "bob's chat is not the admin's");
  assert.equal((await get(`/usage/summary?conversationId=${randomUUID()}`)).status, 404);
});

test("from/to: inclusive from, exclusive to; junk values ignored", async () => {
  const none = await get(`/usage/summary?from=1&to=2`);
  assert.equal(none.json.totals.messages, 0);
  assert.equal(none.json.topModel, null);
  assert.equal(none.json.from, 1);
  assert.equal(none.json.to, 2);
  const junk = await get(`/usage/summary?from=soon&to=`);
  assert.equal(junk.status, 200);
  assert.equal(junk.json.totals.messages, 7);
  assert.equal(junk.json.from, null);
});

test("tz is clamped to [-840, 840]", async () => {
  assert.equal((await get("/usage/summary?tz=99999")).json.tz, 840);
  assert.equal((await get("/usage/summary?tz=-99999")).json.tz, -840);
  assert.equal((await get("/usage/summary?tz=540")).json.tz, 540);
});

test("chats: ranking by tokens then recency, deleted excluded, limit", async () => {
  const r = await get("/usage/chats");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.chats.map((x: any) => x.title), ["Alpha", "Delta", "Beta"]);
  assert.deepEqual(r.json.chats.map((x: any) => x.totalTokens), [21, 7, 7]);
  assert.deepEqual(r.json.chats.map((x: any) => x.messages), [3, 1, 1]);
  assert.deepEqual(r.json.chats[0].models, ["fake-model"]);
  assert.equal(r.json.estimated, false);
  assert.equal(typeof r.json.chats[0].lastActivity, "number");
  const one = await get("/usage/chats?limit=1");
  assert.deepEqual(one.json.chats.map((x: any) => x.title), ["Alpha"]);
  assert.equal((await get("/usage/chats?limit=0")).status, 400);
  assert.equal((await get("/usage/chats?limit=201")).status, 400);
});

test("daily days=1: one bucket for today in the requested zone, start = its local midnight", async () => {
  for (const tz of [0, 540, -720]) {
    const r = await get(`/usage/daily?days=1&tz=${tz}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tz, tz);
    assert.equal(r.json.days.length, 1);
    const today = new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10);
    assert.equal(r.json.days[0].day, today, `tz ${tz}`);
    assert.equal(r.json.days[0].start, Date.parse(`${today}T00:00:00Z`) - tz * 60_000);
    assert.equal(r.json.days[0].messages, 7);
    assert.equal(r.json.days[0].totalTokens, 49);
  }
});

test("daily days=7 zero-fills N buckets; totals equal summary; days=0 matches for every tz", async () => {
  const summary = (await get("/usage/summary")).json.totals;
  for (const tz of [0, 540, -720]) {
    const r = await get(`/usage/daily?days=7&tz=${tz}`);
    assert.equal(r.json.days.length, 7);
    for (let i = 1; i < 7; i++) assert.equal(r.json.days[i].start - r.json.days[i - 1].start, 86_400_000);
    assert.equal(r.json.days[6].day, new Date(Date.now() + tz * 60_000).toISOString().slice(0, 10));
    const sum = r.json.days.reduce((s: any, x: any) => ({ t: s.t + x.totalTokens, m: s.m + x.messages }), { t: 0, m: 0 });
    assert.deepEqual(sum, { t: summary.totalTokens, m: summary.messages });
    const all = await get(`/usage/daily?days=0&tz=${tz}`);
    assert.equal(all.json.days.length, 1, "every row is from today, so one bucket");
    assert.equal(all.json.days.reduce((s: number, x: any) => s + x.totalTokens, 0), summary.totalTokens);
  }
  assert.equal((await get("/usage/daily")).json.days.length, 30, "default N is 30");
});

test("daily: invalid days -> 400", async () => {
  assert.equal((await get("/usage/daily?days=3661")).status, 400);
  assert.equal((await get("/usage/daily?days=-1")).status, 400);
  assert.equal((await get("/usage/daily?days=abc")).status, 400);
  assert.equal((await get("/usage/daily?days=3660")).status, 200);
});

test("models: one row for the caller, share 1, ephemeral excluded", async () => {
  const r = await get("/usage/models");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.models.length, 1);
  assert.deepEqual(
    { providerId: r.json.models[0].providerId, providerName: r.json.models[0].providerName, providerKind: r.json.models[0].providerKind, model: r.json.models[0].model, messages: r.json.models[0].messages, totalTokens: r.json.models[0].totalTokens, share: r.json.models[0].share },
    { providerId: c.provId, providerName: "Fake", providerKind: "openai-compatible", model: "fake-model", messages: 7, totalTokens: 49, share: 1 },
  );
  assert.equal(r.json.estimated, false);
});

test("scope=all is admin-only (403 for a regular user); unknown scope -> 400", async () => {
  for (const p of ["/usage/summary", "/usage/daily", "/usage/chats", "/usage/models"]) {
    const r = await api(c.s.base, "GET", `${p}?scope=all`, undefined, bobTok);
    assert.equal(r.status, 403, p);
  }
  assert.equal((await api(c.s.base, "GET", "/usage/summary?scope=everyone", undefined, c.token)).status, 400);
});

test("regular user sees only own rows; admin scope=all sees everyone; scope=mine stays own", async () => {
  const bob = await api(c.s.base, "GET", "/usage/summary", undefined, bobTok);
  assert.equal(bob.json.totals.messages, 1);
  assert.equal(bob.json.totals.totalTokens, 7);
  const all = await get("/usage/summary?scope=all");
  assert.equal(all.json.totals.messages, 8, "7 admin messages + 1 bob message (ephemeral still excluded)");
  assert.equal(all.json.totals.chats, 5);
  assert.equal((await get("/usage/summary?scope=mine")).json.totals.messages, 7);
  const allChats = await get("/usage/chats?scope=all");
  assert.ok(allChats.json.chats.some((x: any) => x.title === "Bobs"));
  const allModels = await get("/usage/models?scope=all");
  assert.equal(allModels.json.models.length, 2);
  assert.equal(allModels.json.models[0].totalTokens, 49);
  assert.ok(Math.abs(allModels.json.models.reduce((s: number, x: any) => s + x.share, 0) - 1) < 1e-9);
  assert.equal(allModels.json.models[1].providerName, "BobProv");
});

test("usageByUser: per-user tokens, active slots, totals; users without answers are listed; eph_ rows are hidden", () => {
  for (const [id, name] of [[U1, "pu-one"], [U2, "pu-two"], ["pu-idle", "pu-idle"]]) rawDb.prepare("INSERT OR IGNORE INTO users (id, username, salt, hash, created_at) VALUES (?,?,?,?,?)").run(id, name, "s", "h", T1);
  const r = usage.usageByUser({}, 0, rawDb);
  const u1 = r.users.find((u) => u.userId === U1)!;
  const u2 = r.users.find((u) => u.userId === U2)!;
  assert.equal(u1.totalTokens, 23 + 2);
  assert.equal(u1.messages, 3);
  assert.equal(u1.chats, 2);
  assert.equal(u1.activeDays, 2, "day 17 and day 18 (UTC)");
  assert.equal(u1.activeMinutes, 15, "three distinct 5-minute slots");
  assert.equal(u1.lastActivity, T1 + DAY);
  assert.equal(u2.totalTokens, 100);
  assert.equal(r.totals.totalTokens, u1.totalTokens + u2.totalTokens, "the eph_ row is not counted");
  assert.equal(r.totals.messages, 4);
  assert.equal(r.totals.activeUsers, 2);
  assert.equal(r.estimated, true);
  const none = usage.usageByUser({ from: T1 + 2 * DAY }, 0, rawDb);
  assert.equal(none.totals.totalTokens, 0);
  assert.equal(none.users.length, r.users.length, "every user stays in the list");
  assert.equal(none.users[0].lastActivity, null);
});
