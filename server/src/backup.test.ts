import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { setup, newConv, randomUUID, sleep, type Ctx } from "./test-chat-util.js";
import { startServer, api } from "./test-server.js";

let c: Ctx;
let tok2 = "";
before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1", BACKUP_KEEP: "3", BACKUP_INTERVAL_HOURS: "0" });
  tok2 = (await api(c.s.base, "POST", "/auth/register", { username: "plain", password: "password123" })).json.token;
});
after(() => c?.stop());

test("permissions: unauthenticated 401, non-admin 403 on every endpoint", async () => {
  for (const [m, p] of [["POST", "/admin/backup"], ["GET", "/admin/backups"], ["GET", "/admin/backups/omnichat-20240101-000000.db"], ["DELETE", "/admin/backups/omnichat-20240101-000000.db"]] as const) {
    assert.equal((await api(c.s.base, m, p)).status, 401, `${m} ${p}`);
    assert.equal((await api(c.s.base, m, p, undefined, tok2)).status, 403, `${m} ${p}`);
  }
  assert.equal(existsSync(join(c.s.tmp, "backups")), false);
});

test("create / list / download / restore-by-opening / delete", async () => {
  const id = await newConv(c, { title: "Backed up 日本語" });
  const mk = await c.call("POST", "/admin/backup");
  assert.equal(mk.status, 200, mk.text);
  assert.match(mk.json.name, /^omnichat-\d{8}-\d{6}(-\d+)?\.db$/);
  assert.ok(mk.json.size > 0);
  assert.ok(Math.abs(mk.json.createdAt - Date.now()) < 60_000);
  assert.ok(existsSync(join(c.s.tmp, "backups", mk.json.name)));

  const ls = await c.call("GET", "/admin/backups");
  assert.deepEqual(ls.json.backups.map((b: any) => b.name), [mk.json.name]);

  const dl = await fetch(`${c.s.base}/admin/backups/${mk.json.name}`, { headers: { authorization: `Bearer ${c.token}` } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment/);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(buf.length, mk.json.size);
  assert.equal(buf.subarray(0, 15).toString(), "SQLite format 3");

  // the file opens as a valid database with the same data (incl. the search index)
  const copy = join(c.s.tmp, "restored.db");
  writeFileSync(copy, buf);
  const d = new DatabaseSync(copy);
  assert.equal((d.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
  const row = d.prepare("SELECT title FROM conversations WHERE id = ?").get(id) as any;
  assert.equal(row.title, "Backed up 日本語");
  assert.equal((d.prepare("SELECT count(*) AS n FROM users").get() as any).n, 2);
  assert.equal((d.prepare("SELECT count(*) AS n FROM fts_history WHERE fts_history MATCH ?").get('"日本語"') as any).n, 1);
  d.close();

  assert.equal((await c.call("DELETE", `/admin/backups/${mk.json.name}`)).status, 200);
  assert.equal((await c.call("GET", "/admin/backups")).json.backups.length, 0);
  assert.equal((await c.call("DELETE", `/admin/backups/${mk.json.name}`)).status, 404);
  assert.equal((await c.call("GET", `/admin/backups/${mk.json.name}`)).status, 404);
});

test("names are strictly validated (no path traversal)", async () => {
  writeFileSync(join(c.s.tmp, "secret.db"), "not for you");
  const bad = [
    "..%2Fsecret.db", "..%2f..%2fsecret.db", "%2e%2e%2fsecret.db", "..%5Csecret.db", "..", "omnichat-x.db", "omnichat-20240101-000000.db%00.txt",
    "omnichat-20240101-000000.txt", "omnichat-20240101-000000.db/../../secret.db", "secret.db", "omnichat-20240101-000000.db%20", "C%3A%5Cwindows%5Cwin.ini",
  ];
  for (const n of bad) {
    for (const m of ["GET", "DELETE"]) {
      const r = await api(c.s.base, m, `/admin/backups/${n}`, undefined, c.token);
      assert.ok(r.status === 404 || r.status === 400, `${m} ${n} -> ${r.status}`);
      assert.ok(!r.text.includes("not for you"));
    }
  }
  assert.ok(existsSync(join(c.s.tmp, "secret.db")));
  // a well-formed name that does not exist
  assert.equal((await c.call("GET", "/admin/backups/omnichat-20240101-000000.db")).status, 404);
});

test("backup while the server is busy (WAL) is consistent", async () => {
  const ids = Array.from({ length: 30 }, () => randomUUID());
  const writes = ids.map((id, i) => c.call("PUT", `/conversations/${id}`, { providerId: c.provId, title: `busy ${i}` }));
  const mk = c.call("POST", "/admin/backup");
  const reads = Array.from({ length: 10 }, () => c.call("GET", "/sync?since=0"));
  const [bk, ...rest] = await Promise.all([mk, ...writes, ...reads]);
  assert.equal(bk.status, 200, bk.text);
  assert.ok(rest.every((r) => r.status === 200));
  const dl = await fetch(`${c.s.base}/admin/backups/${bk.json.name}`, { headers: { authorization: `Bearer ${c.token}` } });
  const copy = join(c.s.tmp, "busy.db");
  writeFileSync(copy, Buffer.from(await dl.arrayBuffer()));
  const d = new DatabaseSync(copy);
  assert.equal((d.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
  const n = (d.prepare("SELECT count(*) AS n FROM conversations").get() as any).n;
  assert.ok(n >= 1 && n <= 31 + 1);
  d.close();
  // server still fine after
  assert.equal((await c.call("GET", "/sync?since=0")).status, 200);
});

test("BACKUP_KEEP prunes the oldest backups", async () => {
  const made: string[] = [];
  for (let i = 0; i < 5; i++) { const r = await c.call("POST", "/admin/backup"); assert.equal(r.status, 200, r.text); made.push(r.json.name); await sleep(15); }
  const names = (await c.call("GET", "/admin/backups")).json.backups.map((b: any) => b.name);
  assert.equal(names.length, 3);
  assert.deepEqual(names, made.slice(2).reverse()); // newest first, oldest two gone
  assert.equal(readdirSync(join(c.s.tmp, "backups")).length, 3);
});

test("scheduler creates a backup after the first delay when none exists and respects the interval", async () => {
  const s = await startServer({ BACKUP_INTERVAL_HOURS: "1", BACKUP_FIRST_DELAY_MS: "300", BACKUP_KEEP: "7" });
  try {
    const tok = (await api(s.base, "POST", "/auth/register", { username: "sched", password: "password123" })).json.token;
    let list: any[] = [];
    for (let i = 0; i < 60 && !list.length; i++) { await sleep(100); list = (await api(s.base, "GET", "/admin/backups", undefined, tok)).json.backups; }
    assert.equal(list.length, 1);
    await sleep(800);
    assert.equal((await api(s.base, "GET", "/admin/backups", undefined, tok)).json.backups.length, 1);
  } finally { s.stop(); }

  const off = await startServer({ BACKUP_INTERVAL_HOURS: "0", BACKUP_FIRST_DELAY_MS: "100" });
  try {
    await sleep(700);
    assert.equal(existsSync(join(off.tmp, "backups")), false);
  } finally { off.stop(); }
});
