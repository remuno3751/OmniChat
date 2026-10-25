/* eslint-disable @typescript-eslint/no-explicit-any */
// Ephemeral chats (docs/EPHEMERAL.md, docs/PROTOCOL-v7-ephemeral.md): creation rules, streaming, no disk trace,
// exclusion from sync/search/export/stats/backup/debug/diagnostics, title and notify, destruction, idle, logout,
// device grace, restart, settings. Each test spawns its own server (setup()/startServer()) and stops it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, connect, newConv, say, sleep, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { startServer, api, type TestServer } from "./test-server.js";

// ---------- helpers ----------

const ephId = (): string => `eph_${randomUUID()}`;
/** Alphanumeric so the FTS trigram search can find it; unique per call. */
const marker = (): string => `MK${randomUUID().replace(/-/g, "")}`;

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(20);
  }
}

/** Creates a live ephemeral chat as the given token (default: device A = the registering device). */
async function createEph(c: Ctx, token = c.token, body: Record<string, unknown> = {}): Promise<string> {
  const id = ephId();
  const r = await c.call("PUT", `/conversations/${id}`, { ephemeral: true, providerId: c.provId, model: "fake-model", ...body }, token);
  assert.equal(r.status, 200, r.text);
  return id;
}

/** Sends a user message with eph_ ids and waits for the assistant reply to leave the streaming state. */
async function ephSay(cl: Client, conversationId: string, content: string) {
  const userMessageId = ephId(), assistantMessageId = ephId();
  cl.send({ type: "send", conversationId, content, userMessageId, assistantMessageId });
  const asst = await cl.waitMsg(assistantMessageId);
  return { userMessageId, assistantMessageId, asst };
}

/** Opens a fresh WS (new view of the server) and returns its ephemeral_state frame. */
async function freshState(c: Ctx, token = c.token): Promise<any> {
  const cl = await connect(c, token);
  try {
    return await cl.waitFrame((f) => f.type === "ephemeral_state", 3000);
  } finally {
    cl.ws.close();
  }
}

async function loginDevice(c: Ctx, deviceName = "device-b", username = "tester", password = "password123"): Promise<string> {
  const r = await api(c.s.base, "POST", "/auth/login", { username, password, deviceName, platform: "test" });
  assert.equal(r.status, 200, r.text);
  return r.json.token as string;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Every file under dir whose bytes contain the needle as UTF-8. */
function filesContaining(dir: string, needle: string): string[] {
  const n = Buffer.from(needle, "utf8");
  return listFiles(dir).filter((f) => readFileSync(f).includes(n));
}

/** Asserts that no needle appears in t.db, t.db-wal, t.db-shm (when present) nor in any file under the temp dir. */
function assertNoTrace(tmp: string, needles: string[], where: string): void {
  for (const f of ["t.db", "t.db-wal", "t.db-shm"]) {
    const p = join(tmp, f);
    if (!existsSync(p)) continue;
    const buf = readFileSync(p);
    for (const nd of needles) assert.equal(buf.includes(Buffer.from(nd, "utf8")), false, `${where}: ${nd.slice(0, 40)} found in ${f}`);
  }
  for (const nd of needles) {
    assert.deepEqual(filesContaining(tmp, nd), [], `${where}: needle found on disk`);
  }
}

const assertGone = (state: any, id: string) => {
  assert.equal(state.conversations.some((x: any) => x.id === id), false, "conversation still listed");
  assert.equal(state.messages.some((m: any) => m.conversationId === id), false, "messages still listed");
};

// ---------- 1. creation ----------

test("creation: forced title/pin/project, id-prefix rules, live limit", async () => {
  const c = await setup();
  try {
    // title, pinned and mode are forced
    const id = ephId();
    const r = await c.call("PUT", `/conversations/${id}`, { ephemeral: true, providerId: c.provId, model: "fake-model", title: "Secret plan", pinned: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ephemeral, true);
    assert.equal(r.json.title, "Ephemeral chat");
    assert.equal(r.json.pinned, false);
    assert.equal(r.json.projectId ?? null, null);

    // eph_ id without the flag on creation -> 410 (PROTOCOL-v7: no longer exists)
    const noFlag = await c.call("PUT", `/conversations/${ephId()}`, { providerId: c.provId, model: "fake-model" });
    assert.equal(noFlag.status, 410, noFlag.text);

    // ephemeral:true on a normal (non eph_) id -> 400
    const wrongId = await c.call("PUT", `/conversations/${randomUUID()}`, { ephemeral: true, providerId: c.provId, model: "fake-model" });
    assert.equal(wrongId.status, 400, wrongId.text);

    // projectId on creation -> 400
    const withProject = await c.call("PUT", `/conversations/${ephId()}`, { ephemeral: true, providerId: c.provId, model: "fake-model", projectId: "p1" });
    assert.equal(withProject.status, 400, withProject.text);

    // limit: 5 live per user (the first one above counts), the 6th -> 429
    for (let i = 0; i < 4; i++) await createEph(c);
    const sixth = await c.call("PUT", `/conversations/${ephId()}`, { ephemeral: true, providerId: c.provId, model: "fake-model" });
    assert.equal(sixth.status, 429, sixth.text);
    assert.match(sixth.text, /Too many ephemeral chats/);

    // the refused attempts left nothing behind: exactly 5 live
    const st = await freshState(c);
    assert.equal(st.conversations.length, 5);
    assert.equal(st.conversations.some((x: any) => x.id === id), true);
  } finally {
    c.stop();
  }
});

// ---------- 2. streaming ----------

test("streaming: frames, reconnect state, regenerate, rejected non-eph ids", async () => {
  const c = await setup();
  const cl = await connect(c);
  try {
    const id = await createEph(c);
    const M = marker();
    const { userMessageId, assistantMessageId, asst } = await ephSay(cl, id, M);

    // the user message was upserted, deltas streamed, the final assistant message is done
    assert.ok(cl.frames.some((f) => f.type === "upsert" && (f.messages ?? []).some((m: any) => m.id === userMessageId)));
    assert.ok(cl.frames.some((f) => f.type === "delta" && f.messageId === assistantMessageId), "no delta frames");
    assert.equal(asst.status, "done");
    assert.equal(asst.content, `R:${M}-end`);
    assert.equal(asst.parentId, userMessageId);
    assert.ok(assistantMessageId.startsWith("eph_") && userMessageId.startsWith("eph_"));

    // a reconnecting device gets the chat and both messages from ephemeral_state
    const st = await freshState(c);
    const conv = st.conversations.find((x: any) => x.id === id);
    assert.ok(conv, "conversation missing from ephemeral_state");
    assert.equal(conv.ephemeral, true);
    const ids = st.messages.map((m: any) => m.id).sort();
    assert.ok(ids.includes(userMessageId) && ids.includes(assistantMessageId));
    assert.equal(st.messages.find((m: any) => m.id === assistantMessageId).content, `R:${M}-end`);

    // regenerate: a new sibling assistant message with an eph_ id, same parent
    const rid = ephId();
    cl.send({ type: "regenerate", conversationId: id, messageId: assistantMessageId, assistantMessageId: rid });
    const re = await cl.waitMsg(rid);
    assert.equal(re.status, "done");
    assert.equal(re.parentId, userMessageId);
    assert.equal(re.content, `R:${M}-end`);
    const st2 = await freshState(c);
    assert.equal(st2.messages.filter((m: any) => m.parentId === userMessageId).length, 2);

    // non-eph message ids -> error frame code ephemeral_ids, nothing stored
    const before = st2.messages.length;
    const badU = randomUUID(), badA = randomUUID();
    cl.send({ type: "send", conversationId: id, content: "should not be stored", userMessageId: badU, assistantMessageId: badA });
    const err = await cl.waitFrame((f) => f.type === "error" && f.code === "ephemeral_ids", 3000);
    assert.equal(err.conversationId, id);
    const st3 = await freshState(c);
    assert.equal(st3.messages.length, before);
    assert.equal(st3.messages.some((m: any) => m.id === badU || m.id === badA), false);
  } finally {
    cl.ws.close();
    c.stop();
  }
});

// ---------- 3. no trace on disk ----------

test("no trace on disk: ephemeral text is in no file; a normal chat's marker is (positive control)", async () => {
  const c = await setup();
  const cl = await connect(c);
  try {
    // positive control: a normal chat, its text MUST be found on disk (proves the scan works)
    const ctl = marker();
    const nid = await newConv(c);
    await say(c, cl, nid, ctl);
    await waitFor("control on disk", () => {
      const hits = filesContaining(c.s.tmp, ctl);
      return hits.some((f) => /t\.db(-wal)?$/.test(f)) ? hits : null;
    });

    // ephemeral chat 1: exchange, check while live, then end it and check again
    const M1 = marker();
    const dup1 = `${M1} ${M1}`;
    const reply1 = `R:${dup1}-end`;
    const id1 = await createEph(c);
    const r1 = await ephSay(cl, id1, dup1);
    assert.equal(r1.asst.content, reply1);
    await sleep(300); // let any post-reply bookkeeping run
    assertNoTrace(c.s.tmp, [M1, reply1], "live chat 1");

    const del = await c.call("DELETE", `/conversations/${id1}`);
    assert.equal(del.status, 200);
    await sleep(200);
    assertNoTrace(c.s.tmp, [M1, reply1], "after ending chat 1");

    // ephemeral chat 2: a separate live chat with its own marker
    const M2 = marker();
    const dup2 = `${M2} ${M2}`;
    const reply2 = `R:${dup2}-end`;
    const id2 = await createEph(c);
    await ephSay(cl, id2, dup2);
    await sleep(300);
    assertNoTrace(c.s.tmp, [M1, reply1, M2, reply2], "live chat 2 (chat 1 ended)");
  } finally {
    cl.ws.close();
    c.stop();
  }
});

// ---------- 4. exclusion ----------

test("exclusion: sync, history search, export, stats, backup, debug, diagnostics never see ephemeral data", async () => {
  const c = await setup();
  const cl = await connect(c);
  try {
    // positive control: a normal exchange, so every "not found" below is meaningful
    const CM = marker();
    const nid = await newConv(c);
    const ctl = await say(c, cl, nid, CM);
    // metrics of the control exchange are written after the reply; poll until /stats sees them
    let statsBefore = (await c.call("GET", "/stats")).json;
    for (const t0 = Date.now(); statsBefore.overall.count < 1 && Date.now() - t0 < 5000; ) {
      await sleep(50);
      statsBefore = (await c.call("GET", "/stats")).json;
    }
    assert.ok(statsBefore.overall.count >= 1, "control exchange did not produce metrics (stats baseline)");
    const beforeCount = statsBefore.overall.count;

    const M = marker();
    const id = await createEph(c);
    const eph = await ephSay(cl, id, `${M} ${M}`);

    // /sync
    const sync = await c.call("GET", "/sync?since=0");
    assert.equal(sync.status, 200);
    assert.equal(sync.text.includes(id), false, "eph conversation id in /sync");
    assert.equal(sync.text.includes(eph.assistantMessageId), false, "eph message id in /sync");
    assert.equal(sync.text.includes(M), false, "eph marker in /sync");
    assert.equal(sync.text.includes(CM), true, "control chat missing from /sync (method check)");

    // history search: eph marker -> no hit; control marker -> hit
    const hitEph = await c.call("GET", `/history/search?q=${M}`);
    assert.equal(hitEph.status, 200);
    assert.equal(hitEph.json.results.length, 0, "ephemeral marker found by history search");
    const hitCtl = await c.call("GET", `/history/search?q=${CM}`);
    assert.ok(hitCtl.json.results.length >= 1, "control marker not found by history search");

    // stats: the ephemeral exchange adds nothing (text lacks the eph id too)
    await sleep(300);
    const statsAfter = (await c.call("GET", "/stats")).json;
    assert.equal(statsAfter.overall.count, beforeCount, "ephemeral reply counted in /stats");
    assert.equal(JSON.stringify(statsAfter).includes(id), false);
    const csv = await c.call("GET", "/stats/export");
    assert.equal(csv.text.includes(eph.assistantMessageId), false);

    // debug record of an ephemeral reply
    const dbg = await c.call("GET", `/messages/${eph.assistantMessageId}/debug`);
    assert.equal(dbg.status, 404);

    // backup (admin = first registered user): VACUUM INTO copies only the disk database
    const bk = await c.call("POST", "/admin/backup");
    assert.equal(bk.status, 200, bk.text);
    const backupFiles = listFiles(join(c.s.tmp, "backups"));
    assert.ok(backupFiles.length >= 1, "no backup file written");
    for (const f of backupFiles) {
      const buf = readFileSync(f);
      assert.equal(buf.includes(Buffer.from(M, "utf8")), false, "ephemeral marker in backup");
      assert.equal(buf.includes(Buffer.from(eph.assistantMessageId, "utf8")), false, "ephemeral message id in backup");
    }
    assert.ok(backupFiles.some((f) => readFileSync(f).includes(Buffer.from(CM, "utf8"))), "control marker not in backup (method check)");

    // diagnostics log ring: no marker, no conversation title text
    const diag = await fetchText(c, "/admin/diagnostics");
    assert.equal(diag.includes(M), false, "ephemeral marker in diagnostics");
    assert.equal(diag.includes("Ephemeral chat"), false, "title text in diagnostics");
    assert.equal(ctl.asst.status, "done");

    // export of an ephemeral chat is never available (docs/EPHEMERAL.md). Checked last so the other
    // exclusion checks still run when this one fails.
    for (const fmt of ["json", "md"]) {
      const exp = await c.call("GET", `/conversations/${id}/export?format=${fmt}`);
      assert.equal(exp.status, 404, `export ${fmt}: status ${exp.status}, body starts: ${exp.text.slice(0, 120)}`);
      assert.equal(exp.text.includes(M), false, `export ${fmt} contains the ephemeral marker`);
    }
  } finally {
    cl.ws.close();
    c.stop();
  }
});

async function fetchText(c: Ctx, path: string): Promise<string> {
  const r = await c.call("GET", path);
  assert.equal(r.status, 200, r.text);
  return r.text;
}

// ---------- 5. title and notification ----------

test("title stays fixed (no title call) and notify is generic", async () => {
  const c = await setup({ AUTO_TITLE_DEFAULT: "1" });
  const cl = await connect(c);
  try {
    // positive control: a normal chat with auto title DOES make a title call (second backend request)
    const b0 = c.be.bodies.length;
    const nid = await newConv(c);
    await say(c, cl, nid, "normal topic");
    await waitFor("normal title call", () => c.be.bodies.length >= b0 + 2 ? true : null, 5000);

    await sleep(1500); // the title request of the control chat is retried once after 500 ms: let it finish before counting
    const b1 = c.be.bodies.length;
    const M = marker();
    const id = await createEph(c);
    const eph = await ephSay(cl, id, M);
    assert.equal(eph.asst.status, "done");
    await sleep(800); // a title call would start right after the reply
    assert.equal(c.be.bodies.length - b1, 1, "ephemeral chat made more than one backend call");

    const st = await freshState(c);
    assert.equal(st.conversations.find((x: any) => x.id === id).title, "Ephemeral chat");

    const n = await cl.waitFrame((f) => f.type === "notify" && f.conversationId === id, 5000);
    assert.equal(n.title, "Ephemeral chat");
    assert.equal(n.body, "Ephemeral chat finished");
    assert.equal(JSON.stringify(n).includes(M), false, "marker inside notify frame");
  } finally {
    cl.ws.close();
    c.stop();
  }
});

// ---------- 6. destruction ----------

test("destruction: DELETE, ephemeral_end, DELETE /ephemeral; other devices notified; later sends refused; other user refused", async () => {
  const c = await setup({ ALLOW_REGISTRATION: "1" });
  const a = await connect(c);
  const tokB = await loginDevice(c, "device-b");
  const b = await connect(c, tokB);
  try {
    const destroyed = (cl: Client, id: string) => cl.waitFrame((f) => f.type === "ephemeral_destroyed" && f.conversationId === id, 3000);

    // DELETE
    const id = await createEph(c);
    await ephSay(a, id, marker());
    const del = await c.call("DELETE", `/conversations/${id}`);
    assert.equal(del.status, 200, del.text);
    assert.deepEqual(del.json, { ok: true, ephemeral: true });
    const fa = await destroyed(a, id), fb = await destroyed(b, id);
    assert.equal(fa.reason, "ended");
    assert.equal(fb.reason, "ended");

    // a send after destruction -> ephemeral_gone, nothing stored
    const gone = { userMessageId: ephId(), assistantMessageId: ephId() };
    a.send({ type: "send", conversationId: id, content: "late", ...gone });
    const e = await a.waitFrame((f) => f.type === "error" && f.code === "ephemeral_gone", 3000);
    assert.equal(e.conversationId, id);
    const st = await freshState(c);
    assertGone(st, id);
    assert.equal(st.messages.some((m: any) => m.id === gone.userMessageId), false);

    // destruction is idempotent
    const again = await c.call("DELETE", `/conversations/${id}`);
    assert.equal(again.status, 200);

    // WS ephemeral_end
    const id2 = await createEph(c);
    await ephSay(a, id2, marker());
    a.send({ type: "ephemeral_end", conversationId: id2 });
    assert.equal((await destroyed(a, id2)).reason, "ended");
    assert.equal((await destroyed(b, id2)).reason, "ended");
    assertGone(await freshState(c), id2);

    // DELETE /ephemeral destroys all live chats of the user
    await createEph(c);
    await createEph(c);
    const all = await c.call("DELETE", "/ephemeral");
    assert.equal(all.status, 200);
    assert.equal(all.json.destroyed, 2);
    const st2 = await freshState(c);
    assert.equal(st2.conversations.length, 0);

    // another user can neither destroy nor take over a live chat
    const reg = await api(c.s.base, "POST", "/auth/register", { username: "other", password: "password123" });
    assert.equal(reg.status, 200, reg.text);
    const other = reg.json.token as string;
    const live = await createEph(c);
    const d1 = await c.call("DELETE", `/conversations/${live}`, undefined, other);
    assert.equal(d1.status, 404, d1.text);
    const d2 = await c.call("PUT", `/conversations/${live}`, { ephemeral: true, providerId: c.provId }, other);
    assert.equal(d2.status, 403, d2.text);
    assert.equal((await freshState(c)).conversations.some((x: any) => x.id === live), true, "other user destroyed the chat");
    assert.equal((await c.call("DELETE", `/conversations/${live}`)).status, 200);
  } finally {
    a.ws.close();
    b.ws.close();
    c.stop();
  }
});

// ---------- 7. idle ----------

test("idle: destroyed after inactivity; a send before the deadline postpones it", async () => {
  const c = await setup({ OMNICHAT_EPHEMERAL_IDLE_MS: "800", OMNICHAT_EPHEMERAL_SWEEP_MS: "100" });
  const cl = await connect(c);
  try {
    const idle = await createEph(c);
    const active = await createEph(c);
    const t0 = Date.now();
    // keep `active` busy: a send every 300 ms (< 800 ms idle limit) while `idle` gets nothing
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      await ephSay(cl, active, marker());
      assert.equal(cl.frames.some((f) => f.type === "ephemeral_destroyed" && f.conversationId === active), false, "active chat destroyed");
    }
    const f = await cl.waitFrame((x) => x.type === "ephemeral_destroyed" && x.conversationId === idle, 3000);
    assert.equal(f.reason, "idle");
    assert.ok(Date.now() - t0 >= 700, "idle chat destroyed too early");
    // the active chat is still live until it too goes quiet
    const st = await freshState(c);
    assert.equal(st.conversations.some((x: any) => x.id === active), true);
    assert.equal(st.conversations.some((x: any) => x.id === idle), false);
    const f2 = await cl.waitFrame((x) => x.type === "ephemeral_destroyed" && x.conversationId === active, 3000);
    assert.equal(f2.reason, "idle");
  } finally {
    cl.ws.close();
    c.stop();
  }
});

// ---------- 8. logout ----------

test("logout of the creating device destroys its chats on the other devices", async () => {
  const c = await setup();
  const tokB = await loginDevice(c, "device-b");
  const b = await connect(c, tokB);
  try {
    const id = await createEph(c, c.token); // device A
    const r = await c.call("POST", "/auth/logout", undefined, c.token);
    assert.equal(r.status, 200, r.text);
    const f = await b.waitFrame((x) => x.type === "ephemeral_destroyed" && x.conversationId === id, 3000);
    assert.equal(f.reason, "logout");
    assertGone(await freshState(c, tokB), id);
  } finally {
    b.ws.close();
    c.stop();
  }
});

// ---------- 9. grace on device disconnect ----------

test("device grace: closing the creating device's WS destroys after the grace period", async () => {
  const c = await setup({ OMNICHAT_EPHEMERAL_GRACE_MS: "400" });
  const tokB = await loginDevice(c, "device-b");
  const b = await connect(c, tokB);
  const a = await connect(c); // device A creates the chat
  try {
    const id = await createEph(c, c.token);
    const closedAt = Date.now();
    a.ws.close();
    const f = await b.waitFrame((x) => x.type === "ephemeral_destroyed" && x.conversationId === id, 4000);
    assert.equal(f.reason, "disconnected");
    assert.ok(Date.now() - closedAt >= 300, "destroyed before the grace period");
  } finally {
    b.ws.close();
    a.ws.close();
    c.stop();
  }
});

test("device grace: reconnecting within the grace period keeps the chat", async () => {
  const c = await setup({ OMNICHAT_EPHEMERAL_GRACE_MS: "400" });
  const tokB = await loginDevice(c, "device-b");
  const b = await connect(c, tokB);
  let a = await connect(c);
  let a2: Client | null = null;
  try {
    const id = await createEph(c, c.token);
    a.ws.close();
    await sleep(100);
    a2 = await connect(c, c.token); // back within the grace period
    await sleep(900); // well past the grace period
    assert.equal(b.frames.some((x) => x.type === "ephemeral_destroyed" && x.conversationId === id), false, "chat destroyed despite reconnect");
    const st = await freshState(c);
    assert.equal(st.conversations.some((x: any) => x.id === id), true);
    const e = await ephSay(a2, id, marker());
    assert.equal(e.asst.status, "done");
  } finally {
    b.ws.close();
    a.ws.close();
    a2?.ws.close();
    c.stop();
  }
});

// ---------- 10. restart ----------

test("restart: chats are memory-only; after a server restart they are gone and no trace remains", async () => {
  const c = await setup();
  const cl = await connect(c);
  let s2: TestServer | null = null;
  try {
    // positive control on disk, and the ephemeral exchange
    const ctl = marker();
    const nid = await newConv(c);
    await say(c, cl, nid, ctl);
    const M = marker();
    const id = await createEph(c);
    const eph = await ephSay(cl, id, M);
    assert.equal(eph.asst.status, "done");
    await sleep(200);
    cl.ws.close();

    // kill the server (no graceful shutdown) and start a new one on the same data dir
    const tmp = c.s.tmp;
    const exited = new Promise<void>((res) => c.s.child.once("exit", () => res()));
    c.s.child.kill();
    await exited;
    s2 = await startServer({}, tmp);
    const c2 = { ...c, s: s2 } as Ctx;

    // the new server knows no ephemeral chat; the old id is no longer live
    const st = await freshState(c2);
    assert.equal(st.conversations.length, 0);
    assert.equal(st.messages.length, 0);
    const put = await api(s2.base, "PUT", `/conversations/${id}`, { providerId: c.provId, model: "fake-model" }, c.token);
    assert.equal(put.status, 410, put.text);
    const cl2 = await connect(c2, c.token);
    try {
      cl2.send({ type: "send", conversationId: id, content: "still there?", userMessageId: ephId(), assistantMessageId: ephId() });
      const e = await cl2.waitFrame((f) => f.type === "error" && f.code === "ephemeral_gone", 3000);
      assert.equal(e.conversationId, id);
    } finally {
      cl2.ws.close();
    }

    // the disk store survived the restart (control), the ephemeral marker never reached it
    assert.ok(filesContaining(tmp, ctl).length > 0, "control chat not on disk after restart (method check)");
    assertNoTrace(tmp, [M, eph.asst.content], "after restart");
  } finally {
    cl.ws.close();
    s2?.stop();
    c.stop();
  }
});

// ---------- 11. settings ----------

test("settings: ephemeralIdleMinutes default 30, valid 1..1440 integers only", async () => {
  const c = await setup();
  try {
    const d = await c.call("GET", "/settings");
    assert.equal(d.status, 200);
    assert.equal(d.json.ephemeralIdleMinutes, 30);

    for (const bad of [0, 1441, 1.5]) {
      const r = await c.call("PUT", "/settings", { ephemeralIdleMinutes: bad });
      assert.equal(r.status, 400, `value ${bad}: ${r.text}`);
    }
    const ok = await c.call("PUT", "/settings", { ephemeralIdleMinutes: 45 });
    assert.equal(ok.status, 200, ok.text);
    const g = await c.call("GET", "/settings");
    assert.equal(g.json.ephemeralIdleMinutes, 45);
  } finally {
    c.stop();
  }
});
