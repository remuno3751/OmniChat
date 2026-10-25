import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setup, connect, newConv, randomUUID, syncAll, type Ctx, type Client } from "./test-chat-util.js";
import { migrate as migrateFolders } from "./migrate-folders.js";

let c: Ctx;
let cl: Client;
let otherTok: string;
before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  cl = await connect(c);
  const reg = await c.call("POST", "/auth/register", { username: "folderother", password: "password123" }, "");
  assert.equal(reg.status, 200);
  otherTok = reg.json.token;
});
after(() => { cl?.ws.close(); c?.stop(); });

test("folder CRUD: defaults, trimmed name, mode only on create, broadcast and sync", async () => {
  const id = randomUUID();
  let r = await c.call("PUT", `/folders/${id}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.name, "New folder");
  assert.equal(r.json.mode, "chat");
  assert.equal(r.json.deleted, false);
  assert.equal(typeof r.json.seq, "number");

  r = await c.call("PUT", `/folders/${id}`, { name: "  Work  " });
  assert.equal(r.json.name, "Work");
  assert.equal(r.json.mode, "chat", "mode is not changed on update");
  r = await c.call("PUT", `/folders/${id}`, { name: "x".repeat(150) });
  assert.equal(r.json.name.length, 100);

  await cl.waitFrame((f) => f.type === "upsert" && f.folders?.some((x: any) => x.id === id));
  const s = await syncAll(c);
  assert.ok(s.folders.some((x: any) => x.id === id && x.name.length === 100));

  const code = randomUUID();
  r = await c.call("PUT", `/folders/${code}`, { name: "Code", mode: "code" });
  assert.equal(r.json.mode, "code");
  r = await c.call("PUT", `/folders/${code}`, { mode: "chat" });
  assert.equal(r.json.mode, "code", "mode stays after update");
  assert.equal((await c.call("PUT", `/folders/${randomUUID()}`, { mode: "nope" })).status, 400);
});

test("folders are private: other user gets 403 and cannot use the folder", async () => {
  const id = randomUUID();
  await c.call("PUT", `/folders/${id}`, { name: "Mine" });
  assert.equal((await c.call("PUT", `/folders/${id}`, { name: "Hijack" }, otherTok)).status, 403);
  assert.equal((await c.call("DELETE", `/folders/${id}`, undefined, otherTok)).status, 404);
  const conv = await newConv(c);
  assert.equal((await c.call("PUT", `/conversations/${conv}`, { folderId: id }, otherTok)).status, 403);
  const foreign = randomUUID();
  const r = await c.call("PUT", `/conversations/${foreign}`, { providerId: c.provId, folderId: id }, otherTok);
  assert.equal(r.status, 400);
  assert.equal(r.json.error ?? r.json.message, "Unknown folder");
});

test("moving a chat into and out of a folder via PUT conversation", async () => {
  const fid = randomUUID();
  await c.call("PUT", `/folders/${fid}`, { name: "Move" });
  const a = await newConv(c, { folderId: fid });
  const b = await newConv(c);
  assert.equal((await c.call("GET", "/sync?since=0")).json.conversations.find((x: any) => x.id === a).folderId, fid);
  let r = await c.call("PUT", `/conversations/${b}`, { folderId: fid });
  assert.equal(r.json.folderId, fid);
  r = await c.call("PUT", `/conversations/${b}`, { title: "Renamed" });
  assert.equal(r.json.folderId, fid, "absent folderId keeps the folder");
  r = await c.call("PUT", `/conversations/${b}`, { folderId: null });
  assert.equal(r.json.folderId, null);
  assert.equal((await c.call("PUT", `/conversations/${b}`, { folderId: "nope" })).status, 400);
  assert.equal((await c.call("PUT", `/conversations/${b}`, { folderId: 5 })).status, 400);
  assert.equal((await c.call("PUT", `/conversations/${b}`, { folderId: fid })).status, 200);
});

test("sync includes folders and sends only changed ones after a seq", async () => {
  const fid = randomUUID();
  await c.call("PUT", `/folders/${fid}`, { name: "Sync" });
  const full = await syncAll(c);
  assert.ok(Array.isArray(full.folders));
  assert.ok(full.folders.some((x: any) => x.id === fid));
  assert.ok(full.seq >= Math.max(...full.folders.map((x: any) => x.seq)));
  const since = await syncAll(c, full.seq);
  assert.deepEqual(since.folders, []);
  await c.call("PUT", `/folders/${fid}`, { name: "Sync 2" });
  const delta = await syncAll(c, full.seq);
  assert.deepEqual(delta.folders.map((x: any) => x.name), ["Sync 2"]);
});

test("deleting a folder returns its chats to Unclassified without deleting them", async () => {
  const fid = randomUUID();
  await c.call("PUT", `/folders/${fid}`, { name: "Doomed" });
  const c1 = await newConv(c, { folderId: fid });
  const c2 = await newConv(c, { folderId: fid });
  const c3 = await newConv(c);
  const before = cl.frames.length;
  const r = await c.call("DELETE", `/folders/${fid}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
  const f = await cl.waitFrame((x) => cl.frames.indexOf(x) >= before && x.type === "upsert" && x.folders?.some((y: any) => y.id === fid && y.deleted));
  assert.deepEqual((f.conversations ?? []).map((x: any) => x.id).sort(), [c1, c2].sort());
  for (const x of f.conversations) assert.equal(x.folderId, null);

  const s = await syncAll(c);
  const byId = Object.fromEntries(s.conversations.map((x: any) => [x.id, x]));
  assert.equal(byId[c1].folderId, null);
  assert.equal(byId[c2].folderId, null);
  assert.equal(byId[c3].folderId, null);
  assert.equal(byId[c1].deleted, false, "chats are kept");
  assert.equal(s.folders.find((x: any) => x.id === fid).deleted, true);
  assert.equal((await c.call("DELETE", `/folders/${randomUUID()}`)).status, 404);
});

test("ephemeral chats cannot be in a folder", async () => {
  const fid = randomUUID();
  await c.call("PUT", `/folders/${fid}`, { name: "Eph" });
  const id = `eph_${randomUUID()}`;
  let r = await c.call("PUT", `/conversations/${id}`, { ephemeral: true, providerId: c.provId, model: "fake-model", folderId: fid });
  assert.equal(r.status, 400);
  r = await c.call("PUT", `/conversations/${id}`, { ephemeral: true, providerId: c.provId, model: "fake-model" });
  assert.equal(r.status, 200);
  assert.equal(r.json.folderId, null);
  r = await c.call("PUT", `/conversations/${id}`, { folderId: fid });
  assert.equal(r.json.folderId, null, "folder is forced to null on live ephemeral chats");
  await c.call("DELETE", `/conversations/${id}`);
});

test("migration adds folders and conversations.folder_id idempotently and keeps old rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)");
  db.exec("INSERT INTO conversations (id, user_id, title, created_at, updated_at, seq) VALUES ('c1', 'u1', 'Old', 1, 1, 1)");
  migrateFolders(db);
  migrateFolders(db);
  const cols = (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((x) => x.name);
  assert.equal(cols.filter((x) => x === "folder_id").length, 1);
  const row = db.prepare("SELECT title, folder_id FROM conversations WHERE id = 'c1'").get() as { title: string; folder_id: string | null };
  assert.deepEqual({ ...row }, { title: "Old", folder_id: null });
  const folders = db.prepare("PRAGMA table_info(chat_folders)").all() as { name: string }[];
  assert.ok(folders.some((x) => x.name === "mode"));
  db.close();
});
