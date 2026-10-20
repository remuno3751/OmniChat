// Attachments on the chat path: send.attachmentIds, message JSON, what the model receives, context usage, deletion, export.
// One server, tests run in order. A fake upstream (node:http) lists models (one reads images, one does not) and records chat bodies.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { connect, newConv, type Client, type Ctx } from "./test-chat-util.js";
import { estimateTokens } from "./tokens.js";

const PW = "password123";
const OWNER_KEY = "OWNER-KEY-ATT-777";
const VIS = "vis-model";
const TXT = "text-model";

let s: TestServer;
let fake: Server;
let fakeBase = "";
const up = { chats: [] as { key: string; body: any }[] };
let tokBoss = "", tokAlice = "", tokBob = "", tokCarol = "";
let pAlice = "", pBob = "", pCarol = "", pShared = "";
let dbm: typeof import("./db.js");
let att: any;
const uidOf = (u: string) => (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: string }).id;

const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* shared server, stopped in after() */ },
});

async function upload(tok: string, name: string, body: Buffer | string, mime: string) {
  const r = await fetch(s.base + "/attachments", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": mime, "x-file-name": encodeURIComponent(name) },
    body: new Uint8Array(typeof body === "string" ? Buffer.from(body) : body),
  });
  const json: any = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json.attachment as { id: string; name: string; mime: string; kind: string; size: number; status: string };
}
const pngOf = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, n)]);
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;

interface SendOpts { attachmentIds?: unknown; parentId?: string | null; userMessageId?: string }
function send(cl: Client, conversationId: string, content: string, o: SendOpts = {}) {
  const userMessageId = o.userMessageId ?? randomUUID(), assistantMessageId = randomUUID();
  cl.send({
    type: "send", conversationId, content, userMessageId, assistantMessageId,
    ...(o.attachmentIds !== undefined ? { attachmentIds: o.attachmentIds } : {}),
    ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
  });
  return { userMessageId, assistantMessageId };
}
async function sendOk(cl: Client, conversationId: string, content: string, o: SendOpts = {}) {
  const r = send(cl, conversationId, content, o);
  const asst = await cl.waitMsg(r.assistantMessageId);
  assert.equal(asst.status, "done", JSON.stringify(asst));
  return { ...r, asst };
}
const lastChat = () => up.chats[up.chats.length - 1];
const lastUser = (body: any) => [...body.messages].reverse().find((m: any) => m.role === "user");
const msgCount = (conv: string) => (dbm.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(conv) as { n: number }).n;
const linkCount = (conv: string) => (dbm.db.prepare("SELECT COUNT(*) AS n FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE m.conversation_id = ?").get(conv) as { n: number }).n;
const row = (id: string) => att.getAttachmentRow(id);
const fileOf = (id: string) => join(s.tmp, "attachments", row(id).userId, id);

before(async () => {
  const port = await freePort();
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [
        { id: VIS, architecture: { input_modalities: ["text", "image"] } },
        { id: TXT, architecture: { input_modalities: ["text"] } },
      ] }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    up.chats.push({ key, body: JSON.parse(raw || "{}") });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1");
  fakeBase = `http://127.0.0.1:${port}/v1`;

  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1" });
  const reg = async (u: string) => (await api(s.base, "POST", "/auth/register", { username: u, password: PW, deviceName: "t", platform: "test" })).json.token as string;
  tokBoss = await reg("boss");
  tokAlice = await reg("alice");
  tokBob = await reg("bob");
  tokCarol = await reg("carol");
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = join(s.tmp, "t.db");
  dbm = await import("./db.js");
  att = await import("./attachments.js");

  const mk = async (tok: string, key: string) => {
    const id = randomUUID();
    assert.equal((await api(s.base, "PUT", `/providers/${id}`, { name: "Fake", kind: "openai-compatible", baseUrl: fakeBase, model: TXT, apiKey: key }, tok)).status, 200);
    return id;
  };
  pAlice = await mk(tokAlice, "ALICE-KEY"); pBob = await mk(tokBob, "BOB-KEY"); pCarol = await mk(tokCarol, "CAROL-KEY");
  pShared = await mk(tokBoss, OWNER_KEY);
  assert.equal((await api(s.base, "PUT", `/admin/providers/${pShared}/shared`, { shared: true }, tokBoss)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/users/${uidOf("alice")}/grants/${pShared}`, { mode: "all" }, tokBoss)).status, 200);
});
after(() => { s?.stop(); fake?.close(); });

test("a. a text attachment reaches the model as a note, and the message JSON carries its metadata", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "note.txt", "BODY-OF-THE-NOTE", "text/plain");
  const r = await sendOk(cl, conv, "summarize this", { attachmentIds: [a.id] });
  const sent = lastUser(lastChat().body).content;
  assert.equal(typeof sent, "string");
  assert.equal(sent, "[添付: note.txt]\nBODY-OF-THE-NOTE\n\nsummarize this");

  const want = [{ id: a.id, name: "note.txt", mime: a.mime, kind: "document", size: a.size, status: "ready" }];
  assert.deepEqual(cl.msg(r.userMessageId).attachments, want, "WS upsert");
  assert.equal(cl.msg(r.userMessageId).content, "summarize this", "the stored text has no note");
  const sync = (await api(s.base, "GET", "/sync?since=0", undefined, tokAlice)).json;
  assert.deepEqual(sync.messages.find((m: any) => m.id === r.userMessageId).attachments, want, "/sync");
  assert.equal(sync.messages.find((m: any) => m.id === r.assistantMessageId).attachments, undefined, "assistant messages have none");
  const ex = (await api(s.base, "GET", `/conversations/${conv}/export?format=json`, undefined, tokAlice)).json;
  assert.ok(!JSON.stringify(ex).includes("BODY-OF-THE-NOTE"), "no content in the export");
  cl.ws.close();
});

test("b. images: vision yes sends image_url, a text-only model gets a note, 5 images send the newest 4", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const vconv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: VIS });
  const one = await upload(tokAlice, "one.png", pngOf(1), "image/png");
  await sendOk(cl, vconv, "what is this", { attachmentIds: [one.id] });
  const c = lastUser(lastChat().body).content;
  assert.ok(Array.isArray(c));
  assert.deepEqual(c[0], { type: "text", text: "what is this" });
  assert.deepEqual(c[1], { type: "image_url", image_url: { url: dataUrl(pngOf(1)) } });

  const tconv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const two = await upload(tokAlice, "two.png", pngOf(2), "image/png");
  await sendOk(cl, tconv, "look", { attachmentIds: [two.id] });
  const t = lastUser(lastChat().body).content;
  assert.equal(t, "[画像 two.png は、このモデルでは読めません]\n\nlook");
  assert.ok(!JSON.stringify(lastChat().body).includes("base64"));

  const five = [];
  for (let i = 1; i <= 5; i++) five.push(await upload(tokAlice, `img${i}.png`, pngOf(10 + i), "image/png"));
  const m = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: VIS });
  await sendOk(cl, m, "five", { attachmentIds: five.map((x) => x.id) });
  const f = lastUser(lastChat().body).content;
  assert.ok(Array.isArray(f));
  const urls = f.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url);
  assert.deepEqual(urls, [2, 3, 4, 5].map((i) => dataUrl(pngOf(10 + i))), "the newest four, in order");
  assert.equal(f[0].text, "[画像: img1.png(省略)]\n\nfive");
  cl.ws.close();
});

test("c. bad attachments are refused with attachment_invalid, nothing stored, upstream not called", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const bobs = await upload(tokBob, "bobs.txt", "bob secret", "text/plain");
  const mine = await upload(tokAlice, "mine.txt", "mine", "text/plain");
  const other = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  await sendOk(cl, other, "claim it", { attachmentIds: [mine.id] });

  const cases: [string, unknown][] = [
    ["foreign", [bobs.id]],
    ["unknown id", [randomUUID()]],
    ["other conversation", [mine.id]],
    ["too many", Array.from({ length: 11 }, () => randomUUID())],
    ["not an array", "abc"],
    ["bad element", [1]],
    ["duplicate", [mine.id, mine.id]],
  ];
  for (const [label, ids] of cases) {
    const calls = up.chats.length;
    const r = send(cl, conv, "hello", { attachmentIds: ids });
    const e = await cl.waitFrame((f) => f.type === "error" && f.messageId === r.assistantMessageId);
    assert.equal(e.code, "attachment_invalid", label);
    assert.equal(e.conversationId, conv, label);
    assert.ok(typeof e.message === "string" && e.message.length > 0, label);
    assert.equal(up.chats.length, calls, label + ": upstream not called");
    assert.equal(msgCount(conv), 0, label + ": nothing stored");
  }
  assert.match((await cl.waitFrame((f) => f.type === "error" && /too_many/.test(f.message ?? ""))).message, /attachment_too_many/);
  assert.equal(row(bobs.id).conversationId, null, "bob's file stays unattached");
  cl.ws.close();
});

test("d. edit and resend reuses an attachment; regenerate keeps it", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "keep.txt", "KEEP-ME", "text/plain");
  const first = await sendOk(cl, conv, "first", { attachmentIds: [a.id] });
  const second = await sendOk(cl, conv, "edited", { attachmentIds: [a.id], parentId: null });
  assert.equal(lastUser(lastChat().body).content, "[添付: keep.txt]\nKEEP-ME\n\nedited");
  assert.equal(cl.msg(second.userMessageId).attachments[0].id, a.id);
  assert.equal(cl.msg(first.userMessageId).attachments[0].id, a.id);
  assert.equal(row(a.id).messageId, first.userMessageId, "message_id is set the first time only");

  const calls = up.chats.length;
  const aid = randomUUID();
  cl.send({ type: "regenerate", conversationId: conv, messageId: second.assistantMessageId, assistantMessageId: aid, attachmentIds: [randomUUID()] });
  await cl.waitMsg(aid);
  assert.equal(up.chats.length, calls + 1);
  assert.equal(lastUser(lastChat().body).content, "[添付: keep.txt]\nKEEP-ME\n\nedited");
  cl.ws.close();
});

test("e. a deleted attachment shows as deleted in later requests", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "gone.txt", "GONE-TEXT", "text/plain");
  await sendOk(cl, conv, "with file", { attachmentIds: [a.id] });
  assert.equal((await api(s.base, "DELETE", `/attachments/${a.id}`, undefined, tokAlice)).status, 200);
  await sendOk(cl, conv, "follow up");
  const users = lastChat().body.messages.filter((m: any) => m.role === "user");
  assert.equal(users[0].content, "[添付: gone.txt(削除済み)]\n\nwith file");
  assert.equal(users[1].content, "follow up");
  const sync = (await api(s.base, "GET", "/sync?since=0", undefined, tokAlice)).json;
  const m = sync.messages.find((x: any) => x.conversationId === conv && x.role === "user" && x.content === "with file");
  assert.equal(m.attachments[0].status, "deleted");
  const reuse = send(cl, conv, "again", { attachmentIds: [a.id] });
  const err = await cl.waitFrame((f) => f.type === "error" && f.messageId === reuse.assistantMessageId);
  assert.equal(err.code, "attachment_invalid");
  cl.ws.close();
});

test("f. messages without attachments are sent as plain strings", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: VIS });
  await sendOk(cl, conv, "plain text", { attachmentIds: [] });
  const msgs = lastChat().body.messages;
  for (const m of msgs) {
    assert.equal(typeof m.content, "string");
    assert.deepEqual(Object.keys(m).sort(), ["content", "role"]);
  }
  assert.equal(lastUser(lastChat().body).content, "plain text");
  const u = (await api(s.base, "GET", "/sync?since=0", undefined, tokAlice)).json.messages.find((m: any) => m.content === "plain text");
  assert.equal("attachments" in u, false);
  cl.ws.close();
});

test("g. context usage counts the attachments once (text and 800 per image)", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: VIS });
  const base = (await api(s.base, "GET", `/conversations/${conv}/context`, undefined, tokAlice)).json;
  assert.equal(base.used.attachments, 0);
  const doc = await upload(tokAlice, "doc.txt", "x".repeat(900), "text/plain");
  const img = await upload(tokAlice, "pic.png", pngOf(3), "image/png");
  await sendOk(cl, conv, "count me", { attachmentIds: [doc.id, img.id] });
  const u = (await api(s.base, "GET", `/conversations/${conv}/context`, undefined, tokAlice)).json;
  const note = `[添付: doc.txt]\n${"x".repeat(900)}`;
  assert.equal(u.used.attachments, estimateTokens(note) + 800);
  assert.equal(u.total, u.used.system + u.used.history + u.used.attachments + u.used.input);
  assert.ok(u.used.history > 0);
  cl.ws.close();
});

test("h. deleting a conversation or a user removes the files; a file still used elsewhere stays", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const c1 = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const c2 = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "a.txt", "AAA", "text/plain");
  const b = await upload(tokAlice, "b.txt", "BBB", "text/plain");
  await sendOk(cl, c1, "m1", { attachmentIds: [a.id, b.id] });
  const m2 = await sendOk(cl, c2, "m2");
  assert.ok(existsSync(fileOf(a.id)) && existsSync(fileOf(b.id)));
  // b is also attached to a message of the live conversation c2
  dbm.db.prepare("INSERT INTO message_attachments (message_id, attachment_id, position) VALUES (?, ?, 0)").run(m2.userMessageId, b.id);
  assert.equal((await api(s.base, "DELETE", `/conversations/${c1}`, undefined, tokAlice)).status, 200);
  assert.equal(row(a.id).status, "deleted");
  assert.equal(existsSync(fileOf(a.id)), false);
  assert.equal(row(b.id).status, "ready", "still used by a live conversation");
  assert.ok(existsSync(fileOf(b.id)));
  assert.equal((await api(s.base, "DELETE", `/conversations/${c2}`, undefined, tokAlice)).status, 200);
  assert.equal(row(b.id).status, "deleted");
  assert.equal(existsSync(fileOf(b.id)), false);
  cl.ws.close();

  // hard delete of a user
  const cc = await connect(ctxFor(tokCarol, pCarol));
  const cconv = await newConv(ctxFor(tokCarol, pCarol), { providerId: pCarol, model: TXT });
  const f1 = await upload(tokCarol, "c1.txt", "CCC", "text/plain");
  const f2 = await upload(tokCarol, "c2.txt", "DDD", "text/plain");
  await sendOk(cc, cconv, "carol", { attachmentIds: [f1.id] });
  const p1 = fileOf(f1.id), p2 = fileOf(f2.id);
  assert.ok(existsSync(p1) && existsSync(p2));
  cc.ws.close();
  const del = await api(s.base, "DELETE", `/admin/users/${uidOf("carol")}`, { confirm: "carol", hard: true }, tokBoss);
  assert.equal(del.status, 200, del.text);
  assert.equal(existsSync(p1), false);
  assert.equal(existsSync(p2), false);
  assert.equal(row(f1.id), undefined);
});

test("i. a shared provider passes the attachment upstream with the owner's key; foreign attachments stay unusable", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: TXT });
  const mine = await upload(tokAlice, "shared.txt", "SHARED-BODY", "text/plain");
  await sendOk(cl, conv, "via shared", { attachmentIds: [mine.id] });
  assert.equal(lastChat().key, OWNER_KEY);
  assert.equal(lastUser(lastChat().body).content, "[添付: shared.txt]\nSHARED-BODY\n\nvia shared");
  const bossFile = await upload(tokBoss, "boss.txt", "BOSS-ONLY", "text/plain");
  const calls = up.chats.length;
  const r = send(cl, conv, "steal", { attachmentIds: [bossFile.id] });
  const e = await cl.waitFrame((f) => f.type === "error" && f.messageId === r.assistantMessageId);
  assert.equal(e.code, "attachment_invalid");
  assert.equal(up.chats.length, calls);
  cl.ws.close();
});

test("j. the export lists attachments without content; import ignores the field", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "export.txt", "EXPORT-SECRET-BODY", "text/plain");
  await sendOk(cl, conv, "to export", { attachmentIds: [a.id] });
  const js = await api(s.base, "GET", `/conversations/${conv}/export?format=json`, undefined, tokAlice);
  const um = js.json.conversations[0].messages.find((m: any) => m.role === "user");
  assert.deepEqual(um.attachments, [{ name: "export.txt", kind: "document", mime: a.mime, size: a.size, status: "ready" }]);
  assert.ok(!js.text.includes("EXPORT-SECRET-BODY"));
  const md = await api(s.base, "GET", `/conversations/${conv}/export?format=md`, undefined, tokAlice);
  assert.match(md.text, /Attachments:\n- export\.txt \(document, \d+ bytes\)/);
  assert.ok(!md.text.includes("EXPORT-SECRET-BODY"));
  const full = (await api(s.base, "GET", "/export", undefined, tokAlice)).json;
  const imp = await api(s.base, "POST", "/import", full, tokBob);
  assert.equal(imp.status, 200, imp.text);
  assert.ok(!JSON.stringify((await api(s.base, "GET", "/sync?since=0", undefined, tokBob)).json.messages).includes('"attachments"'));
  assert.equal(linkCount(conv) >= 1, true);
  cl.ws.close();
});

test("k. deleting an attachment tells connected devices (the message is sent again as deleted) and /sync picks it up", async () => {
  const cl = await connect(ctxFor(tokAlice, pAlice));
  const conv = await newConv(ctxFor(tokAlice, pAlice), { providerId: pAlice, model: TXT });
  const a = await upload(tokAlice, "notify.txt", "NOTIFY-TEXT", "text/plain");
  await sendOk(cl, conv, "notify me", { attachmentIds: [a.id] });
  const before = (await api(s.base, "GET", "/sync?since=0", undefined, tokAlice)).json.seq as number;
  const frame = cl.waitFrame((f) => f.type === "upsert" && Array.isArray(f.messages) && f.messages.some((m: any) => m.attachments?.[0]?.id === a.id && m.attachments[0].status === "deleted"));
  assert.equal((await api(s.base, "DELETE", `/attachments/${a.id}`, undefined, tokAlice)).status, 200);
  await frame;
  const since = (await api(s.base, "GET", `/sync?since=${before}`, undefined, tokAlice)).json;
  assert.ok(since.messages.some((m: any) => m.attachments?.[0]?.id === a.id && m.attachments[0].status === "deleted"), "a device that was offline learns about the deletion from /sync");
  cl.ws.close();
});
