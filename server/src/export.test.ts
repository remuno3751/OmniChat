import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setup, connect, newConv, say, randomUUID, syncAll, type Ctx, type Client } from "./test-chat-util.js";
import { api } from "./test-server.js";

let c: Ctx;
let cl: Client;
let tok2 = "";
let cl2: Client;
let branched = "";
let t1: Awaited<ReturnType<typeof say>>, t2: Awaited<ReturnType<typeof say>>, e: Awaited<ReturnType<typeof say>>;
let projectId = "";

before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  cl = await connect(c);
  tok2 = (await api(c.s.base, "POST", "/auth/register", { username: "second", password: "password123" })).json.token;
  cl2 = await connect(c, tok2);

  projectId = randomUUID();
  await c.call("PUT", `/projects/${projectId}`, { name: "Proj/One", systemPrompt: "be brief", params: { temperature: 0.3 } });
  await c.call("PUT", `/presets/${randomUUID()}`, { name: "Pirate", text: "Arr" });
  branched = await newConv(c, { title: 'Branchy: "chat" / 日本語?', projectId, model: "fake-model", systemPrompt: "conv prompt", effort: "high", params: { topP: 0.5, stop: ["x"] } });
  t1 = await say(c, cl, branched, "u1");
  t2 = await say(c, cl, branched, "u2");
  e = await say(c, cl, branched, "u2-edited", { parentId: t1.assistantMessageId });
  // reasoning + a second plain conversation + a deleted one
  const d = new DatabaseSync(join(c.s.tmp, "t.db"));
  d.exec("PRAGMA busy_timeout = 5000");
  d.prepare("UPDATE messages SET reasoning = ? WHERE id = ?").run("thinking line 1\nline 2", e.assistantMessageId);
  d.close();
  const plain = await newConv(c, { title: "Second chat" });
  await say(c, cl, plain, "hello there");
  const gone = await newConv(c, { title: "Deleted one" });
  await say(c, cl, gone, "gone message");
  await c.call("DELETE", `/conversations/${gone}`);
});
after(() => { cl?.ws.close(); cl2?.ws.close(); c?.stop(); });

const get = (path: string, tok = c.token) => api(c.s.base, "GET", path, undefined, tok);

test("markdown export: current path vs all branches, reasoning flag, headers", async () => {
  let r = await get(`/conversations/${branched}/export`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/markdown/);
  const cd = r.headers.get("content-disposition") ?? "";
  assert.match(cd, /^attachment; filename="[\x20-\x7e]+\.md"; filename\*=UTF-8''/);
  assert.ok(!/[\/\\:"?*]/.test(cd.match(/filename="([^"]*)"/)![1]), cd);
  assert.ok(cd.includes(encodeURIComponent("日本語")));
  assert.ok(r.text.startsWith('# Branchy: "chat" / 日本語?\n'));
  assert.ok(r.text.includes("Project: Proj/One"));
  assert.ok(r.text.includes("Model: fake-model"));
  assert.ok(r.text.includes("**You:** u1"));
  assert.ok(r.text.includes("**Assistant:** R:u1-end"));
  assert.ok(r.text.includes("**You:** u2-edited"));
  assert.ok(!r.text.includes("**You:** u2\n"), "old branch must not be exported");
  assert.ok(!r.text.includes("Thinking"));

  r = await get(`/conversations/${branched}/export?format=md&branches=current&reasoning=1`);
  assert.ok(r.text.includes("> Thinking"));
  assert.ok(r.text.includes("> thinking line 1"));

  r = await get(`/conversations/${branched}/export?branches=all`);
  assert.ok(r.text.includes("**You:** u2\n"));
  assert.ok(r.text.includes("**You:** u2-edited"));
  assert.ok(r.text.includes("Branch 1/2") && r.text.includes("Branch 2/2"));

  assert.equal((await get(`/conversations/${branched}/export?format=pdf`)).status, 400);
  assert.equal((await get(`/conversations/${branched}/export?branches=weird`)).status, 400);
});

test("json export: current path vs all, ids, head, reasoning flag", async () => {
  let r = await get(`/conversations/${branched}/export?format=json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="[\x20-\x7e]+\.json"/);
  let j = JSON.parse(r.text);
  assert.equal(j.version, 1);
  assert.equal(j.conversations.length, 1);
  const cv = j.conversations[0];
  assert.equal(cv.id, branched);
  assert.equal(cv.projectId, projectId);
  assert.deepEqual(cv.params, { topP: 0.5, stop: ["x"] });
  assert.equal(cv.effort, "high");
  assert.deepEqual(cv.messages.map((m: any) => m.content), ["u1", "R:u1-end", "u2-edited", "R:u2-edited-end"]);
  assert.equal(cv.headId, e.assistantMessageId);
  assert.ok(cv.messages.every((m: any) => m.reasoning === null));
  assert.deepEqual(j.projects.map((p: any) => p.id), [projectId]);

  r = await get(`/conversations/${branched}/export?format=json&branches=all&reasoning=1`);
  j = JSON.parse(r.text);
  assert.equal(j.conversations[0].messages.length, 6);
  assert.equal(j.conversations[0].messages.find((m: any) => m.id === e.assistantMessageId).reasoning, "thinking line 1\nline 2");
});

test("export is owner only and hides deleted conversations", async () => {
  assert.equal((await get(`/conversations/${branched}/export`, tok2)).status, 404);
  assert.equal((await api(c.s.base, "GET", `/conversations/${branched}/export`)).status, 401);
  assert.equal((await get(`/conversations/${randomUUID()}/export`)).status, 404);
  const all = JSON.parse((await get("/export")).text);
  assert.ok(!all.conversations.some((x: any) => x.title === "Deleted one"));
  assert.equal((await api(c.s.base, "GET", "/export")).status, 401);
});

test("full export contains no secrets", async () => {
  await c.call("PUT", `/providers/${randomUUID()}`, { name: "Keyed", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", apiKey: "sk-SUPER-SECRET-KEY" });
  const r = await get("/export");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="omnichat-export-\d{8}\.json"/);
  assert.ok(!r.text.includes("sk-SUPER-SECRET-KEY"));
  assert.ok(!r.text.includes(c.token));
  assert.ok(!r.text.includes(tok2));
  assert.ok(!/apiKey|api_key|token_hash|password|"hash"|"salt"/i.test(r.text));
  const j = JSON.parse(r.text);
  assert.ok(j.providers.length >= 2);
  assert.ok(j.providers.every((p: any) => !("apiKey" in p) && !("hasKey" in p) && p.name && p.baseUrl));
  assert.ok(j.settings && !("seq" in j.settings));
  assert.equal(j.conversations.length, 2);
  assert.equal(j.presets.length, 1);
});

/** Structure of an export with all generated ids replaced by indexes. */
function shape(exp: any) {
  const pIdx = new Map<string, number>(exp.projects.map((p: any, i: number) => [p.id, i]));
  const convs = [...exp.conversations].sort((a: any, b: any) => a.title.localeCompare(b.title) || a.createdAt - b.createdAt);
  return {
    projects: exp.projects.map(({ id: _i, ...p }: any) => p),
    presets: exp.presets.map(({ id: _i, ...p }: any) => p),
    conversations: convs.map((cv: any) => {
      const mIdx = new Map<string, number>(cv.messages.map((m: any, i: number) => [m.id, i]));
      return {
        title: cv.title, model: cv.model, systemPrompt: cv.systemPrompt, systemMode: cv.systemMode, effort: cv.effort, params: cv.params,
        createdAt: cv.createdAt, updatedAt: cv.updatedAt, project: cv.projectId === null ? null : pIdx.get(cv.projectId),
        head: cv.headId === null ? null : mIdx.get(cv.headId),
        messages: cv.messages.map((m: any) => ({ parent: m.parentId === null ? null : mIdx.get(m.parentId), role: m.role, content: m.content, status: m.status, createdAt: m.createdAt, reasoning: m.reasoning })),
      };
    }),
  };
}

test("round trip: export -> import into a second user -> export equals (structure), counts, broadcast, fresh seq", async () => {
  const orig = JSON.parse((await get("/export")).text);
  const beforeSeq = (await syncAll(c)).seq;
  const r = await api(c.s.base, "POST", "/import", orig, tok2);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { projects: 1, presets: 1, conversations: 2, messages: 8 });

  const copy = JSON.parse((await get("/export", tok2)).text);
  assert.deepEqual(shape(copy), shape(orig));
  // new ids everywhere, nothing shared with the original
  const oldIds = new Set<string>([...orig.projects.map((p: any) => p.id), ...orig.presets.map((p: any) => p.id), ...orig.conversations.flatMap((x: any) => [x.id, ...x.messages.map((m: any) => m.id)])]);
  for (const x of [...copy.projects, ...copy.presets, ...copy.conversations, ...copy.conversations.flatMap((x: any) => x.messages)]) assert.ok(!oldIds.has(x.id));
  // the first user is untouched
  assert.deepEqual(shape(JSON.parse((await get("/export")).text)), shape(orig));
  assert.equal((await syncAll(c)).seq, beforeSeq);

  // second user's devices were notified with upserts and rows carry fresh seq values
  await cl2.waitFrame((f) => f.type === "upsert" && f.conversations?.length === 2);
  await cl2.waitFrame((f) => f.type === "upsert" && f.messages?.length === 8);
  await cl2.waitFrame((f) => f.type === "upsert" && f.projects?.length === 1 && f.presets?.length === 1);
  const sync = (await api(c.s.base, "GET", "/sync?since=0", undefined, tok2)).json;
  assert.equal(sync.conversations.length, 2);
  assert.equal(sync.messages.length, 8);
  const seqs = [...sync.conversations, ...sync.messages, ...sync.projects, ...sync.presets].map((x: any) => x.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(Math.min(...seqs) > beforeSeq);
  // parent/head remapped inside the new conversation; project mapped to the new project
  const nc = sync.conversations.find((x: any) => x.title.startsWith("Branchy"));
  assert.equal(nc.projectId, sync.projects[0].id);
  const ms = sync.messages.filter((m: any) => m.conversationId === nc.id);
  assert.ok(ms.some((m: any) => m.id === nc.headId));
  assert.ok(ms.every((m: any) => m.parentId === null || ms.some((p: any) => p.id === m.parentId)));
  // imported messages are searchable by the new owner and not by the old id space
  const s = await api(c.s.base, "GET", "/history/search?q=u2-edited", undefined, tok2);
  assert.ok(s.json.total >= 1);
  // the imported conversation works with the normal export again (md)
  const md = await get(`/conversations/${nc.id}/export`, tok2);
  assert.ok(md.text.includes("**You:** u2-edited"));
});

test("import never overwrites: importing twice duplicates under new ids; own data is kept", async () => {
  const orig = JSON.parse((await get("/export")).text);
  const before1 = (await get("/export")).json;
  void before1;
  const r1 = await api(c.s.base, "POST", "/import", orig, c.token);
  assert.equal(r1.status, 200);
  const r2 = await api(c.s.base, "POST", "/import", orig, c.token);
  assert.equal(r2.status, 200);
  const after = JSON.parse((await get("/export")).text);
  assert.equal(after.conversations.length, 6);
  assert.equal(new Set(after.conversations.map((x: any) => x.id)).size, 6);
  for (const o of orig.conversations) assert.ok(after.conversations.find((x: any) => x.id === o.id), "original conversation intact");
  assert.equal(after.projects.length, 3);
  // own provider ids are kept (user owns them); foreign ones are dropped
  const imported = after.conversations.filter((x: any) => !orig.conversations.some((o: any) => o.id === x.id));
  assert.ok(imported.every((x: any) => x.providerId === c.provId || x.providerId === null));
});

test("foreign ids in the payload are never trusted", async () => {
  const other = JSON.parse((await get("/export")).text);
  const victimProject = other.projects[0].id;
  const victimConv = other.conversations[0].id;
  const victimMsg = other.conversations[0].messages[0].id;
  const payload = {
    version: 1,
    projects: [], // projectId refers to a project that exists for user 1 but is NOT in this payload
    conversations: [{
      id: "x1", title: "evil", projectId: victimProject, providerId: c.provId, headId: victimMsg,
      messages: [{ id: "m1", parentId: victimMsg, role: "user", content: "hi", createdAt: 1 }, { id: "m2", parentId: "m1", role: "assistant", content: "yo", createdAt: 2 }],
    }],
  };
  const r = await api(c.s.base, "POST", "/import", payload, tok2);
  assert.equal(r.status, 200, r.text);
  const sync = (await api(c.s.base, "GET", "/sync?since=0", undefined, tok2)).json;
  const nc = sync.conversations.find((x: any) => x.title === "evil");
  assert.equal(nc.projectId, null);
  assert.equal(nc.providerId, null); // provider belongs to the other user
  assert.notEqual(nc.id, "x1");
  const ms = sync.messages.filter((m: any) => m.conversationId === nc.id);
  assert.equal(ms.length, 2);
  assert.ok(ms.some((m: any) => m.id === nc.headId));
  assert.equal(ms.find((m: any) => m.role === "user").parentId, null);
  assert.ok(ms.every((m: any) => m.id !== victimMsg && m.userId === undefined));
  assert.ok(!sync.conversations.some((x: any) => x.id === victimConv));
});

test("malicious / malformed payloads are rejected atomically", async () => {
  const count = async () => (await syncAll(c, 0)).conversations.length;
  const n0 = await count();
  const msg = (o: any = {}) => ({ id: "m", role: "user", content: "x", ...o });
  const conv = (o: any = {}) => ({ id: "c", title: "t", messages: [msg()], ...o });
  const bads: Array<[string, any]> = [
    ["array body", []],
    ["string body", "hello"],
    ["wrong version", { version: 2, conversations: [] }],
    ["conversations not array", { conversations: {} }],
    ["projects not array", { projects: "x" }],
    ["conversation not object", { conversations: ["x"] }],
    ["conversation id number", { conversations: [conv({ id: 5 })] }],
    ["conversation id missing", { conversations: [conv({ id: undefined })] }],
    ["title number", { conversations: [conv({ title: 5 })] }],
    ["messages not array", { conversations: [conv({ messages: "x" })] }],
    ["role system", { conversations: [conv({ messages: [msg({ role: "system" })] })] }],
    ["role missing", { conversations: [conv({ messages: [msg({ role: undefined })] })] }],
    ["content number", { conversations: [conv({ messages: [msg({ content: 5 })] })] }],
    ["content object", { conversations: [conv({ messages: [msg({ content: { a: 1 } })] })] }],
    ["message id object", { conversations: [conv({ messages: [msg({ id: {} })] })] }],
    ["parent id number", { conversations: [conv({ messages: [msg({ parentId: 3 })] })] }],
    ["duplicate message ids", { conversations: [conv({ messages: [msg(), msg()] })] }],
    ["duplicate conversation ids", { conversations: [conv(), conv()] }],
    ["parent cycle", { conversations: [conv({ messages: [msg({ id: "a", parentId: "b" }), msg({ id: "b", parentId: "a" })] })] }],
    ["self parent", { conversations: [conv({ messages: [msg({ id: "a", parentId: "a" })] })] }],
    ["project name missing", { projects: [{ id: "p" }] }],
    ["preset name number", { presets: [{ name: 7 }] }],
    ["bad entry after a good one", { conversations: [conv({ id: "ok" }), conv({ id: "bad", messages: [msg({ role: "root" })] })] }],
  ];
  for (const [name, body] of bads) {
    const r = await api(c.s.base, "POST", "/import", body, c.token);
    assert.equal(r.status, 400, `${name}: ${r.status} ${r.text}`);
    assert.ok(r.json?.error, name);
  }
  assert.equal(await count(), n0, "nothing was written by rejected imports");

  // invalid JSON syntax -> 400, no auth -> 401
  const raw = await fetch(`${c.s.base}/import`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: "{not json" });
  assert.equal(raw.status, 400);
  assert.equal((await api(c.s.base, "POST", "/import", { conversations: [] })).status, 401);

  // odd but harmless input is sanitised, not trusted
  const weird = {
    version: 1,
    __proto__: { polluted: true },
    conversations: [{
      id: "__proto__", title: "x".repeat(2000), systemMode: "evil", effort: "ultra", params: { temperature: "hot", maxTokens: 5, evil: 1 }, headId: "nope",
      messages: [{ id: "constructor", role: "assistant", content: "<script>alert(1)</script>", status: "streaming", createdAt: "yesterday", parentId: "missing" }],
    }],
    "__proto__x": 1,
  };
  const raw2 = JSON.stringify(weird).replace('"version":1', '"version":1,"__proto__":{"isAdmin":true}');
  const r = await fetch(`${c.s.base}/import`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: raw2 });
  assert.equal(r.status, 200, await r.text());
  const sync = await syncAll(c, 0);
  const nc = sync.conversations.find((x: any) => x.title.startsWith("xxxx"));
  assert.equal(nc.title.length, 500);
  assert.equal(nc.systemMode, "append");
  assert.equal(nc.effort, null);
  assert.deepEqual(nc.params, { maxTokens: 5 });
  const m = sync.messages.find((x: any) => x.conversationId === nc.id);
  assert.equal(m.status, "done"); // never 'streaming'
  assert.equal(m.parentId, null);
  assert.equal(m.id === "constructor", false);
  assert.equal(nc.headId, m.id);
  assert.equal(({} as any).polluted, undefined);
});

test("size limit: > 50 MB is refused, large valid payloads work, server stays healthy", async () => {
  const big = JSON.stringify({ version: 1, conversations: [{ id: "big", title: "big", messages: [{ id: "m", role: "user", content: "a".repeat(51 * 1024 * 1024) }] }] });
  // The server may answer 413 and close the socket while the client is still writing the body; on Linux the
  // client then sees EPIPE/ECONNRESET before it can read the response. Both mean "refused".
  try {
    const r = await fetch(`${c.s.base}/import`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: big });
    assert.equal(r.status, 413);
    await r.text();
  } catch (e: any) {
    assert.match(String(e?.cause?.code ?? e?.code), /^(EPIPE|ECONNRESET|UND_ERR_SOCKET)$/, String(e));
  }
  assert.equal((await get("/sync?since=0")).status, 200);

  const ok = { version: 1, conversations: [{ id: "big", title: "bigok", messages: [{ id: "m", role: "user", content: "b".repeat(8 * 1024 * 1024) }] }] };
  const r2 = await api(c.s.base, "POST", "/import", ok, c.token);
  assert.equal(r2.status, 200, r2.text.slice(0, 200));
  assert.deepEqual(r2.json, { projects: 0, presets: 0, conversations: 1, messages: 1 });

  // many messages
  const many = { version: 1, conversations: [{ id: "many", title: "many", messages: Array.from({ length: 3000 }, (_, i) => ({ id: `m${i}`, parentId: i ? `m${i - 1}` : null, role: i % 2 ? "assistant" : "user", content: `msg ${i}`, createdAt: i + 1 })) }] };
  const r3 = await api(c.s.base, "POST", "/import", many, c.token);
  assert.deepEqual(r3.json, { projects: 0, presets: 0, conversations: 1, messages: 3000 });
  const exp = JSON.parse((await get("/export")).text).conversations.find((x: any) => x.title === "many");
  assert.equal(exp.messages.length, 3000);
  assert.equal(exp.messages[2999].content, "msg 2999");
  assert.equal(exp.headId, exp.messages[2999].id);
});
