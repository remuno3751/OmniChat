import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setup, connect, newConv, say, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { api } from "./test-server.js";

let c: Ctx;
let cl: Client;
let tok2 = "";
before(async () => {
  c = await setup({ ALLOW_REGISTRATION: "1" });
  cl = await connect(c);
  tok2 = (await api(c.s.base, "POST", "/auth/register", { username: "other", password: "password123" })).json.token;
});
after(() => { cl?.ws.close(); c?.stop(); });

const search = async (q: string, extra = "", tok = c.token) =>
  api(c.s.base, "GET", `/history/search?q=${encodeURIComponent(q)}${extra}`, undefined, tok);

test("bundled SQLite supports FTS5 with the trigram tokenizer", () => {
  const d = new DatabaseSync(":memory:");
  d.exec("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram')");
  d.prepare("INSERT INTO t (c) VALUES (?)").run("日本語のテキスト");
  assert.equal((d.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get('"本語の"') as any).n, 1);
  // the server reports the tokenizer it actually uses
  const dbf = new DatabaseSync(join(c.s.tmp, "t.db"));
  dbf.exec("PRAGMA busy_timeout = 5000");
  assert.equal((dbf.prepare("SELECT v FROM fts_meta WHERE k = 'tokenizer'").get() as any).v, "trigram");
  dbf.close();
});

test("requires auth", async () => {
  assert.equal((await api(c.s.base, "GET", "/history/search?q=abc")).status, 401);
});

test("Japanese, emoji, short queries, case-insensitivity, snippets", async () => {
  const id = await newConv(c, { title: "Plain" });
  await say(c, cl, id, "今日は日本語のテキストを検索します😀🎉🚀 Hello World");
  let r = await search("本語の");
  assert.equal(r.status, 200);
  assert.ok(r.json.total >= 2); // user + assistant echo
  const hit = r.json.results.find((x: any) => x.role === "user");
  assert.equal(hit.conversationId, id);
  assert.equal(hit.conversationTitle, "Plain");
  assert.ok(hit.messageId);
  assert.ok(hit.snippet.includes("\u0001本語の\u0002"), hit.snippet);
  assert.ok(typeof hit.createdAt === "number");
  assert.equal(hit.projectId, null);

  r = await search("😀🎉🚀"); // 3 code points -> FTS
  assert.ok(r.json.total >= 1);
  assert.ok(r.json.results[0].snippet.includes("\u0001😀🎉🚀\u0002"));

  r = await search("😀"); // 1 char -> LIKE fallback
  assert.ok(r.json.total >= 1);
  r = await search("日本"); // 2 chars -> LIKE fallback
  assert.ok(r.json.total >= 1);
  assert.ok(r.json.results[0].snippet.includes("\u0001日本\u0002"));

  r = await search("HELLO world"); // case-insensitive, multiple terms
  assert.ok(r.json.total >= 1);
  assert.ok(r.json.results[0].snippet.includes("\u0001Hello\u0002"));
  assert.ok(r.json.results[0].snippet.includes("\u0001World\u0002"));

  r = await search("zzzzqqqq");
  assert.deepEqual(r.json, { results: [], total: 0 });
  r = await search("   ");
  assert.deepEqual(r.json, { results: [], total: 0 });
  r = await search("");
  assert.deepEqual(r.json, { results: [], total: 0 });
});

test("FTS syntax characters never cause errors", async () => {
  const id = await newConv(c, { title: "Specials" });
  await say(c, cl, id, 'weird "quoted" (parens) AND OR NOT NEAR(a b) col:val a*b -minus ^caret {x} \' single');
  for (const q of ['"', '""', '"quoted"', "(", ")", "AND", "OR", "NOT", "NEAR(", "NEAR(a b)", "col:val", "a*b", "*", "-minus", "^caret", "{x}", "'", "'; DROP TABLE messages;--", "%", "_", "\\", "\u0000x\u0001y", "a".repeat(5000), "\"unterminated phrase"]) {
    const r = await search(q);
    assert.equal(r.status, 200, `query ${JSON.stringify(q.slice(0, 20))}: ${r.text}`);
    assert.ok(Array.isArray(r.json.results));
  }
  let r = await search('"quoted" (parens)');
  assert.ok(r.json.total >= 1);
  r = await search("NEAR(a b)");
  assert.ok(r.json.total >= 1);
  r = await search("a*b");
  assert.ok(r.json.total >= 1);
  r = await search("%"); // LIKE wildcard is escaped: only literal percent signs match
  assert.equal(r.json.total, 0);
  assert.equal((await api(c.s.base, "GET", "/history/search", undefined, c.token)).status, 200); // no q
  assert.equal((await api(c.s.base, "GET", "/history/search?q=abc&limit=zzz&offset=-4", undefined, c.token)).status, 200);
});

test("conversation titles are searchable (messageId null) and follow renames", async () => {
  const id = await newConv(c, { title: "Quarterly roadmap planning" });
  let r = await search("roadmap");
  let t = r.json.results.find((x: any) => x.messageId === null && x.conversationId === id);
  assert.ok(t);
  assert.ok(t.snippet.includes("\u0001roadmap\u0002"));
  assert.equal(t.role, null);
  assert.equal(t.conversationTitle, "Quarterly roadmap planning");

  assert.equal((await c.call("PUT", `/conversations/${id}`, { title: "Budget review" })).status, 200);
  r = await search("roadmap");
  assert.equal(r.json.results.filter((x: any) => x.conversationId === id).length, 0);
  r = await search("Budget");
  assert.ok(r.json.results.some((x: any) => x.messageId === null && x.conversationId === id));
  r = await search("Bu"); // short title search
  assert.ok(r.json.results.some((x: any) => x.messageId === null && x.conversationId === id));
});

test("projectId filter, pagination and total", async () => {
  const pid = randomUUID();
  assert.equal((await c.call("PUT", `/projects/${pid}`, { name: "P" })).status, 200);
  const inProj = await newConv(c, { title: "In project", projectId: pid });
  const other = await newConv(c, { title: "No project" });
  for (let i = 0; i < 3; i++) await say(c, cl, inProj, `pagetoken alpha ${i}`);
  await say(c, cl, other, "pagetoken outside");

  let r = await search("pagetoken", `&projectId=${pid}`);
  assert.equal(r.json.total, 6);
  assert.ok(r.json.results.every((x: any) => x.conversationId === inProj && x.projectId === pid));

  r = await search("pagetoken");
  assert.equal(r.json.total, 8);
  const p1 = await search("pagetoken", "&limit=3&offset=0");
  const p2 = await search("pagetoken", "&limit=3&offset=3");
  const p3 = await search("pagetoken", "&limit=3&offset=6");
  const p4 = await search("pagetoken", "&limit=3&offset=9");
  assert.equal(p1.json.total, 8);
  assert.deepEqual([p1, p2, p3, p4].map((x) => x.json.results.length), [3, 3, 2, 0]);
  const ids = [p1, p2, p3].flatMap((x) => x.json.results.map((y: any) => y.messageId));
  assert.equal(new Set(ids).size, 8);
  // newest first
  const times = [p1, p2, p3].flatMap((x) => x.json.results.map((y: any) => y.createdAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times);
  assert.equal((await search("pagetoken", "&limit=1000")).json.results.length, 8); // clamped, not an error
  assert.equal((await search("pagetoken", "&projectId=nope")).json.total, 0);
});

test("results are isolated between users", async () => {
  const id = await newConv(c, { title: "Secret plan" });
  await say(c, cl, id, "isolationtoken only for tester");
  assert.ok((await search("isolationtoken")).json.total >= 1);
  assert.equal((await search("isolationtoken", "", tok2)).json.total, 0);
  assert.equal((await search("Secret plan", "", tok2)).json.total, 0);
  assert.equal((await search("Se", "", tok2)).json.total, 0);
});

test("deleted conversations are excluded; restoring brings them back", async () => {
  const id = await newConv(c, { title: "Doomed chat" });
  await say(c, cl, id, "deletiontoken inside");
  assert.ok((await search("deletiontoken")).json.total >= 2);
  assert.equal((await c.call("DELETE", `/conversations/${id}`)).status, 200);
  assert.equal((await search("deletiontoken")).json.total, 0);
  assert.equal((await search("Doomed")).json.total, 0);
  assert.equal((await search("de", "")).json.results.filter((x: any) => x.conversationId === id).length, 0);
  assert.equal((await c.call("PUT", `/conversations/${id}`, { title: "Doomed chat" })).status, 200);
  assert.ok((await search("deletiontoken")).json.total >= 2);
});

test("migration backfills rows written before the index existed", async () => {
  // simulate a legacy row by writing directly to the DB, bypassing nothing (triggers fire), then wiping the index
  const id = await newConv(c, { title: "Legacy" });
  await say(c, cl, id, "backfilltoken here");
  const d = new DatabaseSync(join(c.s.tmp, "t.db"));
  d.exec("PRAGMA busy_timeout = 5000");
  d.exec("DELETE FROM fts_history; DELETE FROM fts_map;");
  d.close();
  assert.equal((await search("backfilltoken")).json.total, 0);
  // restarting the server re-runs the migration
  c.s.child.kill();
  await new Promise((r) => c.s.child.once("exit", r));
  const { startServer } = await import("./test-server.js");
  const s2 = await startServer({ ALLOW_REGISTRATION: "1" }, c.s.tmp);
  try {
    const r = await api(s2.base, "GET", `/history/search?q=backfilltoken`, undefined, c.token);
    assert.ok(r.json.total >= 2, r.text);
    const t = await api(s2.base, "GET", `/history/search?q=Legacy`, undefined, c.token);
    assert.ok(t.json.results.some((x: any) => x.messageId === null && x.conversationId === id));
  } finally {
    s2.child.kill();
    await new Promise((r) => s2.child.once("exit", r));
    c.s.child = s2.child; // keep after() cleanup (rmSync) working
  }
});
