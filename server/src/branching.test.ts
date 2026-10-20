import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setup, connect, newConv, say, sleep, randomUUID, syncAll, type Ctx, type Client } from "./test-chat-util.js";
import { startServer, api } from "./test-server.js";

let c: Ctx;
let cl: Client;
before(async () => { c = await setup({ ALLOW_REGISTRATION: "1" }); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); });

const lastBody = () => c.be.bodies[c.be.bodies.length - 1];
const conv = async (id: string) => (await syncAll(c)).conversations.find((x: any) => x.id === id);
const msgs = async (id: string) => (await syncAll(c)).messages.filter((m: any) => m.conversationId === id);

test("old-style sends (no parentId) chain linearly and head follows the newest assistant", async () => {
  const id = await newConv(c);
  assert.equal((await conv(id)).headId, null);
  const a = await say(c, cl, id, "one");
  const b = await say(c, cl, id, "two");
  const rows = await msgs(id);
  const by = Object.fromEntries(rows.map((m: any) => [m.id, m]));
  assert.equal(by[a.userMessageId].parentId, null);
  assert.equal(by[a.assistantMessageId].parentId, a.userMessageId);
  assert.equal(by[b.userMessageId].parentId, a.assistantMessageId);
  assert.equal(by[b.assistantMessageId].parentId, b.userMessageId);
  assert.equal((await conv(id)).headId, b.assistantMessageId);
});

test("edit & resend creates a sibling branch; history is the new path; old branch untouched", async () => {
  const id = await newConv(c);
  const t1 = await say(c, cl, id, "u1");
  const t2 = await say(c, cl, id, "u2");
  const before = (await msgs(id)).map((m: any) => ({ id: m.id, parentId: m.parentId, content: m.content }));

  // edit u2 -> parent is a1
  const e = await say(c, cl, id, "u2-edited", { parentId: t1.assistantMessageId });
  assert.deepEqual(lastBody().messages.map((m: any) => m.content), ["u1", "R:u1-end", "u2-edited"]);
  const after = await msgs(id);
  const edited = after.find((m: any) => m.id === e.userMessageId);
  assert.equal(edited.parentId, t1.assistantMessageId);
  assert.equal(after.find((m: any) => m.id === e.assistantMessageId).parentId, e.userMessageId);
  assert.equal((await conv(id)).headId, e.assistantMessageId);
  // old branch rows unchanged
  for (const b of before) {
    const now = after.find((m: any) => m.id === b.id);
    assert.deepEqual({ id: now.id, parentId: now.parentId, content: now.content }, b);
  }
  // siblings of u2 and u2-edited share the parent
  const sibs = after.filter((m: any) => m.parentId === t1.assistantMessageId).map((m: any) => m.id).sort();
  assert.deepEqual(sibs, [t2.userMessageId, e.userMessageId].sort());

  // continuing without parentId follows the new head
  await say(c, cl, id, "u3");
  assert.deepEqual(lastBody().messages.map((m: any) => m.content), ["u1", "R:u1-end", "u2-edited", "R:u2-edited-end", "u3"]);

  // edit the very first message (parentId null) -> new root
  const r = await say(c, cl, id, "root2", { parentId: null });
  assert.deepEqual(lastBody().messages.map((m: any) => m.content), ["root2"]);
  assert.equal((await msgs(id)).find((m: any) => m.id === r.userMessageId).parentId, null);
});

test("unknown parentId yields an error frame and nothing is stored", async () => {
  const id = await newConv(c);
  const n = (await msgs(id)).length;
  cl.send({ type: "send", conversationId: id, content: "x", userMessageId: randomUUID(), assistantMessageId: randomUUID(), parentId: "nope" });
  const f = await cl.waitFrame((x) => x.type === "error" && /parent/i.test(x.message));
  assert.equal(typeof f.message, "string");
  assert.equal((await msgs(id)).length, n);
});

test("regenerate creates a sibling assistant message and moves head", async () => {
  const id = await newConv(c);
  const t1 = await say(c, cl, id, "q");
  const rid = randomUUID();
  const bodies = c.be.bodies.length;
  cl.send({ type: "regenerate", conversationId: id, messageId: t1.assistantMessageId, assistantMessageId: rid });
  const m = await cl.waitMsg(rid);
  assert.equal(m.status, "done");
  assert.equal(m.parentId, t1.userMessageId);
  assert.equal(m.content, "R:q-end");
  assert.equal(c.be.bodies.length, bodies + 1);
  assert.deepEqual(lastBody().messages.map((x: any) => x.content), ["q"], "old reply is not part of the new request");
  assert.equal((await conv(id)).headId, rid);
  const rows = await msgs(id);
  assert.equal(rows.filter((x: any) => x.parentId === t1.userMessageId).length, 2);
  assert.equal(rows.find((x: any) => x.id === t1.assistantMessageId).status, "done");

  // regenerating a user message is an error frame
  cl.send({ type: "regenerate", conversationId: id, messageId: t1.userMessageId, assistantMessageId: randomUUID() });
  await cl.waitFrame((x) => x.type === "error" && /assistant/i.test(x.message));
});

test("headId switching and validation", async () => {
  const id = await newConv(c);
  const t1 = await say(c, cl, id, "a");
  const t2 = await say(c, cl, id, "b", { parentId: null });
  assert.equal((await conv(id)).headId, t2.assistantMessageId);
  const before = (await conv(id)).updatedAt;
  let r = await c.call("PUT", `/conversations/${id}`, { headId: t1.assistantMessageId });
  assert.equal(r.status, 200);
  assert.equal(r.json.headId, t1.assistantMessageId);
  assert.equal(r.json.updatedAt, before, "switching branch is not activity");
  // next message continues from the switched head
  await say(c, cl, id, "c");
  assert.deepEqual(lastBody().messages.map((m: any) => m.content), ["a", "R:a-end", "c"]);

  const other = await newConv(c);
  const o = await say(c, cl, other, "zzz");
  assert.equal((await c.call("PUT", `/conversations/${id}`, { headId: o.assistantMessageId })).status, 400);
  assert.equal((await c.call("PUT", `/conversations/${id}`, { headId: "missing" })).status, 400);
  assert.equal((await c.call("PUT", `/conversations/${id}`, { headId: 5 })).status, 400);
  r = await c.call("GET", "/sync?since=0");
  assert.equal(r.json.conversations.find((x: any) => x.id === id).headId !== o.assistantMessageId, true);
});

test("stop works for regenerate", async () => {
  const id = await newConv(c);
  const t1 = await say(c, cl, id, "slow");
  c.be.slowMs = 300;
  try {
    const rid = randomUUID();
    cl.send({ type: "regenerate", conversationId: id, messageId: t1.assistantMessageId, assistantMessageId: rid });
    await cl.waitMsg(rid, (m) => m.status === "streaming");
    await sleep(100);
    cl.send({ type: "stop", messageId: rid });
    const m = await cl.waitMsg(rid, (x) => x.status !== "streaming");
    assert.equal(m.status, "stopped");
  } finally { c.be.slowMs = 0; }
});

test("dsh-bridge conversations are linear: regenerate and branching are rejected with error frames", async () => {
  const dsh = randomUUID();
  await c.call("PUT", `/providers/${dsh}`, { name: "PC", kind: "dsh-bridge", baseUrl: "no-such-bridge", model: "x" });
  const id = await newConv(c, { providerId: dsh });
  const t = await say(c, cl, id, "hi"); // bridge offline -> assistant error message, still chained
  assert.equal(t.asst.status, "error");
  assert.equal(t.asst.parentId, t.userMessageId);
  const nBefore = (await msgs(id)).length;

  const before = cl.frames.length;
  cl.send({ type: "regenerate", conversationId: id, messageId: t.assistantMessageId, assistantMessageId: randomUUID() });
  const f1 = await cl.waitFrame((x) => cl.frames.indexOf(x) >= before && x.type === "error");
  assert.match(f1.message, /linear|regenerate/i);

  const before2 = cl.frames.length;
  cl.send({ type: "send", conversationId: id, content: "branch", userMessageId: randomUUID(), assistantMessageId: randomUUID(), parentId: null });
  const f2 = await cl.waitFrame((x) => cl.frames.indexOf(x) >= before2 && x.type === "error");
  assert.match(f2.message, /linear|branch/i);
  assert.equal((await msgs(id)).length, nBefore, "nothing stored for rejected frames");

  // parentId equal to head is fine for dsh-bridge
  const ok = await say(c, cl, id, "again", { parentId: t.assistantMessageId });
  assert.equal(ok.asst.parentId, ok.userMessageId);
});

test("legacy migration: existing messages are chained by createdAt and head set to the last one", async () => {
  const s = await startServer({});
  let tmp = s.tmp;
  try {
    const reg = await api(s.base, "POST", "/auth/register", { username: "legacy", password: "password123" });
    const userId = reg.json.userId as string;
    s.child.kill();
    await new Promise((r) => s.child.once("exit", r));
    const db = new DatabaseSync(join(tmp, "t.db"));
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL;");
    const ic = db.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at, deleted, seq) VALUES (?,?,?,?,?,0,?)");
    const im = db.prepare("INSERT INTO messages (id, user_id, conversation_id, role, content, status, created_at, seq) VALUES (?,?,?,?,?,?,?,?)");
    ic.run("lc1", userId, "Old chat", 1, 1, 1001);
    ic.run("lc2", userId, "Empty", 1, 1, 1002);
    ic.run("lc3", userId, "Single", 1, 1, 1003);
    // inserted out of order on purpose
    im.run("m3", userId, "lc1", "user", "third", "done", 300, 1004);
    im.run("m1", userId, "lc1", "user", "first", "done", 100, 1005);
    im.run("m2", userId, "lc1", "assistant", "second", "done", 200, 1006);
    im.run("s1", userId, "lc3", "user", "only", "done", 100, 1007);
    db.prepare("UPDATE counter SET value = 1007 WHERE id = 1").run();
    db.close();

    const s2 = await startServer({}, tmp);
    tmp = "";
    try {
      const tok = (await api(s2.base, "POST", "/auth/login", { username: "legacy", password: "password123" })).json.token;
      const sync = (await api(s2.base, "GET", "/sync?since=0", undefined, tok)).json;
      const by = Object.fromEntries(sync.messages.map((m: any) => [m.id, m]));
      assert.equal(by.m1.parentId, null);
      assert.equal(by.m2.parentId, "m1");
      assert.equal(by.m3.parentId, "m2");
      assert.equal(by.s1.parentId, null);
      const convs = Object.fromEntries(sync.conversations.map((x: any) => [x.id, x]));
      assert.equal(convs.lc1.headId, "m3");
      assert.equal(convs.lc2.headId, null);
      assert.equal(convs.lc3.headId, "s1");
      assert.equal(convs.lc1.projectId, null);
      assert.equal(convs.lc1.systemMode, "append");
      assert.ok(by.m1.seq > 1007, "migrated rows get a fresh seq so clients re-sync them");

      // an old client continues the chat without parentId -> chains after the migrated head
      const be = await (await import("./test-chat-util.js")).startBackend();
      try {
        const prov = randomUUID();
        await api(s2.base, "PUT", `/providers/${prov}`, { name: "F", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${be.port}/v1`, model: "m" }, tok);
        await api(s2.base, "PUT", "/conversations/lc1", { providerId: prov }, tok);
        const { openWs } = await import("./test-server.js");
        const ws = await openWs(`ws://127.0.0.1:${s2.port}/ws?token=${tok}`);
        const um = randomUUID(), am = randomUUID();
        ws.send(JSON.stringify({ type: "send", conversationId: "lc1", content: "fourth", userMessageId: um, assistantMessageId: am }));
        await sleep(600);
        ws.close();
        const sync2 = (await api(s2.base, "GET", "/sync?since=0", undefined, tok)).json;
        assert.equal(sync2.messages.find((m: any) => m.id === um).parentId, "m3");
        assert.deepEqual(be.bodies[0].messages.map((m: any) => m.content), ["first", "second", "third", "fourth"]);
        // idempotent: restarting again does not re-chain
      } finally { be.close(); }
    } finally { s2.stop(); }
  } finally {
    if (tmp) s.stop();
  }
});
