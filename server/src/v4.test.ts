import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { setup, connect, newConv, say, syncAll, sleep, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { api, openWs, freePort } from "./test-server.js";
import { startLlm, startSearx, writePlugin, answerApprovals, type Llm, type Searx } from "./test-tools-util.js";

// Keep the in-process imports below away from the real database.
process.env.DB_PATH = ":memory:";
const { readSheetSize } = await import("./pets.js");
const { globMatch } = await import("./approval-rules.js");

/* PROTOCOL-v4.md server part: modes, phases, approval rules, notify, templates, pets, diagnostics, bridge frames. */

let c: Ctx;
let cl: Client;
let llm: Llm;
let sx: Searx;
let provId: string;
let tok2 = "";
const ntfy = { posts: [] as { headers: Record<string, any>; body: string; url: string }[], srv: null as unknown as Server, port: 0 };

const call = (method: string, path: string, body?: unknown, tok?: string) => c.call(method, path, body, tok);
const conv = (body: Record<string, unknown> = {}) => newConv(c, { providerId: provId, model: "llm-1", ...body });
const lastText = (b: any) => [...b.messages].reverse().find((m: any) => m.role === "user")?.content ?? "";
const until = async (f: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await sleep(20); }
};
const phaseSeq = (cl2: Client, messageId: string) =>
  cl2.frames.filter((f) => f.type === "phase" && f.messageId === messageId).map((f) => `${f.phase}:${f.state}`);
const syncedMsg = async (id: string) => ((await syncAll(c)).messages as any[]).find((m) => m.id === id);
const convRow = async (id: string) => ((await syncAll(c)).conversations as any[]).find((x) => x.id === id);

before(async () => {
  sx = await startSearx();
  c = await setup({ ALLOW_REGISTRATION: "1", SEARXNG_URL: sx.url, TOOL_APPROVAL_TIMEOUT_MS: "2000", AUTO_TITLE_DEFAULT: "0", OMNICHAT_SEARCH_STATUS_TTL_MS: "0" });
  llm = await startLlm();
  provId = randomUUID();
  await call("PUT", `/providers/${provId}`, { name: "LLM", kind: "openai-compatible", baseUrl: llm.base, model: "llm-1" });
  tok2 = (await api(c.s.base, "POST", "/auth/register", { username: "second", password: "password123" })).json.token;
  writePlugin(c.s.tmp, "v4plug", {
    "plugin.json": JSON.stringify({
      id: "v4plug", name: "V4", version: "1.0.0", description: "test", main: "index.mjs",
      tools: [
        { name: "echo", description: "echo", parameters: { type: "object", properties: { text: { type: "string" } } }, permissions: [] },
        { name: "fsread", description: "needs approval", parameters: { type: "object", properties: {} }, permissions: ["filesystem-read"] },
      ],
    }),
    "index.mjs": 'export const tools = { async echo(a) { return "echo:" + a.text; }, async fsread() { return "fs-ok"; } };',
  });
  await sleep(300);
  assert.equal((await call("POST", "/tools/reload")).status, 200);
  await call("PUT", "/settings", { autoTitle: false });
  // fake ntfy-like listener
  ntfy.port = await freePort();
  ntfy.srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => { ntfy.posts.push({ headers: req.headers, body: raw, url: String(req.url) }); res.writeHead(200).end("{}"); });
  }).listen(ntfy.port, "127.0.0.1");
  cl = await connect(c);
});
after(() => {
  cl?.ws.close();
  llm?.close();
  sx?.close();
  ntfy.srv?.closeAllConnections();
  ntfy.srv?.close();
  c?.stop();
});

/* ---------------- 1. mode and codeStatus ---------------- */

test("mode: default chat, explicit code, validation, projects, dsh-bridge default, /code/sessions", async () => {
  const a = await conv();
  assert.equal((await convRow(a)).mode, "chat");
  assert.equal((await convRow(a)).codeStatus, "idle");
  const b = await conv({ mode: "code" });
  assert.equal((await convRow(b)).mode, "code");
  assert.equal((await call("PUT", `/conversations/${a}`, { mode: "nope" })).status, 400);
  assert.equal((await call("PUT", `/conversations/${a}`, { title: "renamed" })).json.mode, "chat", "mode is kept on update");
  assert.equal((await call("PUT", `/conversations/${a}`, { mode: "code" })).json.mode, "code");
  assert.equal((await call("PUT", `/conversations/${a}`, { mode: "chat" })).json.mode, "chat");

  const pid = randomUUID();
  assert.equal((await call("PUT", `/projects/${pid}`, { name: "P" })).json.mode, "chat");
  assert.equal((await call("PUT", `/projects/${pid}`, { mode: "code" })).json.mode, "code");
  assert.equal((await call("PUT", `/projects/${pid}`, { mode: "x" })).status, 400);
  assert.equal((await call("PUT", `/projects/${pid}`, { name: "P2" })).json.mode, "code", "project mode kept");

  const dsh = randomUUID();
  await call("PUT", `/providers/${dsh}`, { name: "PC", kind: "dsh-bridge", baseUrl: "pc-mode", model: "x" });
  const d = randomUUID();
  const r = await call("PUT", `/conversations/${d}`, { providerId: dsh });
  assert.equal(r.json.mode, "code", "a dsh-bridge conversation defaults to code mode");

  const s = (await call("GET", "/code/sessions")).json.sessions as any[];
  const ids = s.map((x) => x.conversationId);
  assert.ok(ids.includes(b) && ids.includes(d) && !ids.includes(a));
  const sd = s.find((x) => x.conversationId === d);
  assert.equal(sd.bridge, "pc-mode");
  assert.equal(sd.codeStatus, "idle");
  assert.equal(sd.pendingApprovals, 0);
  assert.equal((await call("GET", "/code/sessions", undefined, tok2)).json.sessions.length, 0);
  assert.equal((await call("GET", "/code/sessions", undefined, "")).status, 401);
});

test("codeStatus: running while generating, done at the end, error on failure, synced", async () => {
  const id = await conv();
  llm.script = () => ({ text: ["a", "b"], delayMs: 150 });
  const aid = randomUUID();
  cl.send({ type: "send", conversationId: id, content: "hi", userMessageId: randomUUID(), assistantMessageId: aid });
  await until(() => cl.frames.some((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === id && x.codeStatus === "running")));
  await cl.waitMsg(aid);
  await until(() => cl.frames.some((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === id && x.codeStatus === "done")));
  assert.equal((await convRow(id)).codeStatus, "done");

  llm.script = () => ({ status: 500 });
  const e = await say(c, cl, id, "again");
  assert.equal(e.asst.status, "error");
  await until(() => cl.frames.some((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === id && x.codeStatus === "error")));
  assert.equal((await convRow(id)).codeStatus, "error");
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

/* ---------------- 2. phases ---------------- */

test("phases: thinking -> answering in order, persisted closed, survive reload", async () => {
  const id = await conv();
  llm.script = () => ({ reasoning: ["think a", "think b"], text: ["hello ", "world"] });
  const { assistantMessageId: aid } = await say(c, cl, id, "plain question");
  await until(() => phaseSeq(cl, aid).includes("answering:end"));
  assert.deepEqual(phaseSeq(cl, aid), ["thinking:start", "thinking:end", "answering:start", "answering:end"]);
  const frame = cl.frames.find((f) => f.type === "phase" && f.messageId === aid);
  assert.equal(frame.conversationId, id);
  assert.equal(typeof frame.at, "number");
  const m = await syncedMsg(aid);
  assert.deepEqual(m.phases.map((p: any) => p.phase), ["thinking", "answering"]);
  assert.ok(m.phases.every((p: any) => typeof p.start === "number" && typeof p.end === "number" && p.end >= p.start));
  // a second device sees the same history from the snapshot of the message
  const full = await syncedMsg(aid);
  assert.equal(full.status, "done");
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

test("phases: searching (label = query) and tool phases around calls; closed on completion", async () => {
  const rule = await call("PUT", `/approval-rules/${randomUUID()}`, { kind: "tool", pattern: "web_search", action: "allow" });
  assert.equal(rule.status, 200);
  const id = await conv({ searchMode: "always", tools: ["echo"] });
  llm.script = (b, n) => (b.messages.some((m: any) => m.role === "tool") ? { text: ["final answer"] } : { calls: [{ id: "e1", name: "echo", args: { text: "x" } }] });
  const { assistantMessageId: aid } = await say(c, cl, id, "find pandas please");
  await until(() => phaseSeq(cl, aid).includes("answering:end"));
  const seq = phaseSeq(cl, aid);
  assert.equal(seq[0], "searching:start", JSON.stringify(seq));
  assert.ok(seq.indexOf("searching:end") > 0 && seq.indexOf("searching:end") < seq.indexOf("tool:start"), JSON.stringify(seq));
  assert.ok(seq.includes("tool:start") && seq.includes("tool:end"));
  assert.ok(seq.indexOf("tool:end") < seq.lastIndexOf("answering:start"));
  const start = cl.frames.find((f) => f.type === "phase" && f.messageId === aid && f.phase === "searching" && f.state === "start");
  assert.match(start.label, /pandas/);
  const toolStart = cl.frames.find((f) => f.type === "phase" && f.messageId === aid && f.phase === "tool" && f.state === "start");
  assert.equal(toolStart.label, "echo");
  assert.ok(toolStart.id && toolStart.id !== "tool", "tool phases have an id per call");
  const m = await syncedMsg(aid);
  assert.ok(m.phases.length >= 3 && m.phases.every((p: any) => typeof p.end === "number"));
  assert.equal(m.toolCalls.find((t: any) => t.name === "web_search").decidedBy?.startsWith("rule:"), true, "search decided by the allow rule");
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

test("phases: an aborted run closes open phases", async () => {
  const id = await conv();
  llm.script = () => ({ reasoning: ["pondering"], text: Array.from({ length: 400 }, (_, i) => `w${i} `) });
  const aid = randomUUID();
  cl.send({ type: "send", conversationId: id, content: "stop me", userMessageId: randomUUID(), assistantMessageId: aid });
  await until(() => phaseSeq(cl, aid).includes("answering:start"));
  cl.send({ type: "stop", messageId: aid });
  const m = await cl.waitMsg(aid, (x) => x.status === "stopped");
  assert.equal(m.status, "stopped");
  const synced = await syncedMsg(aid);
  assert.ok(synced.phases.length >= 1 && synced.phases.every((p: any) => typeof p.end === "number"), JSON.stringify(synced.phases));
  assert.equal((await convRow(id)).codeStatus, "idle");
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

/* ---------------- 3. approval rules ---------------- */

test("globMatch: * and ? with literal escaping, anchored", () => {
  assert.ok(globMatch("git *", "git status -s"));
  assert.ok(!globMatch("git *", "xgit status"));
  assert.ok(globMatch("a?c", "abc") && !globMatch("a?c", "abbc"));
  assert.ok(globMatch("src/**/*.ts", "src/a/b/c.ts"));
  assert.ok(!globMatch("a.b", "axb"), "dot is literal");
  assert.ok(globMatch("(x)+[y]", "(x)+[y]"));
});

test("globMatch: pathological patterns finish instantly (no regex backtracking)", () => {
  const t = Date.now();
  assert.equal(globMatch("*a".repeat(30), "a".repeat(200) + "b"), false);
  assert.ok(Date.now() - t < 500);
});

test("approval rules REST: validation, upsert, filters, ownership, delete", async () => {
  const pid = randomUUID();
  await call("PUT", `/projects/${pid}`, { name: "RP" });
  const id = randomUUID();
  const mk = (b: any, tok?: string) => call("PUT", `/approval-rules/${id}`, b, tok);
  assert.equal((await mk({ kind: "bogus", pattern: "x", action: "allow" })).status, 400);
  assert.equal((await mk({ kind: "tool", pattern: "x", action: "maybe" })).status, 400);
  assert.equal((await mk({ kind: "tool", pattern: "", action: "allow" })).status, 400);
  assert.equal((await mk({ kind: "tool", pattern: "x".repeat(301), action: "allow" })).status, 400);
  assert.equal((await mk({ kind: "tool", pattern: "x", action: "allow", projectId: "missing" })).status, 400);
  const ok = await mk({ kind: "command", pattern: "git *", action: "allow", projectId: pid, note: "n" });
  assert.equal(ok.status, 200);
  assert.deepEqual({ ...ok.json, createdAt: 0 }, { id, projectId: pid, kind: "command", pattern: "git *", action: "allow", createdAt: 0, note: "n" });
  assert.equal((await mk({ kind: "command", pattern: "git *", action: "deny" })).json.projectId, pid, "project kept when omitted");
  assert.equal((await mk({ kind: "command", pattern: "git *", action: "deny" }, tok2)).status, 403);
  const all = (await call("GET", "/approval-rules")).json.rules as any[];
  assert.ok(all.some((r) => r.id === id));
  assert.ok((await call("GET", `/approval-rules?projectId=${pid}`)).json.rules.some((r: any) => r.id === id));
  assert.ok(!(await call("GET", "/approval-rules?projectId=global")).json.rules.some((r: any) => r.id === id));
  assert.equal((await call("GET", "/approval-rules", undefined, tok2)).json.rules.length, 0);
  assert.equal((await call("DELETE", `/approval-rules/${id}`, undefined, tok2)).status, 404);
  assert.equal((await call("DELETE", `/approval-rules/${id}`)).status, 200);
  assert.equal((await call("DELETE", `/approval-rules/${id}`)).status, 404);
  assert.equal((await call("GET", "/approval-rules", undefined, "")).status, 401);
});

test("approval rules: allow skips the prompt, deny answers immediately, project beats global, always creates a rule", async () => {
  await call("DELETE", "/tool-grants/fsread");
  llm.script = (b) => (b.messages.some((m: any) => m.role === "tool") ? { text: ["done"] } : { calls: [{ id: "f1", name: "fsread", args: {} }] });
  const seen = answerApprovals(cl, () => "deny");
  const runTool = async (cv: string) => (await say(c, cl, cv, "use it")).asst;

  // global deny -> denied without a prompt
  const denyId = randomUUID();
  await call("PUT", `/approval-rules/${denyId}`, { kind: "tool", pattern: "fsread", action: "deny" });
  const cv1 = await conv({ tools: ["fsread"], searchMode: "off" });
  let m = await runTool(cv1);
  assert.equal(m.toolCalls[0].status, "denied");
  assert.equal(m.toolCalls[0].decidedBy, `rule:${denyId}`);
  assert.equal(seen.length, 0, "no prompt was shown");

  // project allow beats global deny
  const pid = randomUUID();
  await call("PUT", `/projects/${pid}`, { name: "Allowing" });
  const allowId = randomUUID();
  await call("PUT", `/approval-rules/${allowId}`, { kind: "tool", pattern: "fsread", action: "allow", projectId: pid });
  const cv2 = await conv({ tools: ["fsread"], searchMode: "off", projectId: pid });
  m = await runTool(cv2);
  assert.equal(m.toolCalls[0].status, "done");
  assert.equal(m.toolCalls[0].decidedBy, `rule:${allowId}`);
  assert.equal(seen.length, 0);

  // deny beats allow inside the same scope
  const deny2 = randomUUID();
  await call("PUT", `/approval-rules/${deny2}`, { kind: "tool", pattern: "fsread", action: "deny", projectId: pid });
  m = await runTool(await conv({ tools: ["fsread"], searchMode: "off", projectId: pid }));
  assert.equal(m.toolCalls[0].status, "denied");
  for (const r of [denyId, allowId, deny2]) await call("DELETE", `/approval-rules/${r}`);

  // no rule: ask; "always" stores an allow rule (and the grant)
  const seen2 = answerApprovals(cl, () => "always");
  m = await runTool(await conv({ tools: ["fsread"], searchMode: "off" }));
  assert.equal(seen2.length, 1);
  assert.equal(m.toolCalls[0].status, "done");
  const rules = (await call("GET", "/approval-rules")).json.rules as any[];
  assert.ok(rules.some((r) => r.kind === "tool" && r.pattern === "fsread" && r.action === "allow"), "an allow rule was created");
  assert.ok((await call("GET", "/tool-grants")).json.grants.some((g: any) => g.tool === "fsread"), "grants keep working");
  answerApprovals(cl, () => null);
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

/* ---------------- 4. notifications ---------------- */

test("settings: notify prefs and notifyUrl validation, the URL is never echoed", async () => {
  const s0 = (await call("GET", "/settings")).json;
  assert.deepEqual(s0.notify, { done: true, approval: true, error: true });
  assert.equal(s0.notifyUrlSet, false);
  assert.equal("notifyUrl" in s0, false);
  assert.equal((await call("PUT", "/settings", { notifyUrl: "ftp://x/y" })).status, 400);
  assert.equal((await call("PUT", "/settings", { notifyUrl: "not a url" })).status, 400);
  assert.equal((await call("PUT", "/settings", { notify: "yes" })).status, 400);
  const url = `http://127.0.0.1:${ntfy.port}/secret-topic-xyz`;
  const put = await call("PUT", "/settings", { notifyUrl: url, notify: { done: true, approval: true, error: true } });
  assert.equal(put.status, 200);
  assert.equal(put.json.notifyUrlSet, true);
  assert.ok(!put.text?.includes("secret-topic-xyz") && !JSON.stringify(put.json).includes("secret-topic-xyz"));
  assert.ok(!JSON.stringify((await call("GET", "/settings")).json).includes("secret-topic-xyz"));
  assert.ok(!JSON.stringify((await syncAll(c)).settings ?? {}).includes("secret-topic-xyz"));
  assert.equal((await call("GET", "/settings", undefined, tok2)).json.notifyUrlSet, false);
});

test("notify: WS frame and ntfy POST on done/error, respects the switches, non-ASCII titles are encoded", async () => {
  ntfy.posts.length = 0;
  llm.script = () => ({ text: ["finished text"] });
  const id = await conv();
  const { assistantMessageId: aid } = await say(c, cl, id, "ASCII title");
  const n = await cl.waitFrame((f) => f.type === "notify" && f.conversationId === id && f.kind === "done");
  assert.equal(n.body, "finished text");
  assert.equal(typeof n.at, "number");
  await until(() => ntfy.posts.length >= 1);
  assert.equal(ntfy.posts[0].url, "/secret-topic-xyz");
  assert.equal(ntfy.posts[0].body, "finished text");
  assert.equal(ntfy.posts[0].headers.title, "ASCII title");
  assert.equal(ntfy.posts[0].headers.priority, "default");
  assert.ok(aid);

  // non-ASCII title is RFC 2047 encoded
  ntfy.posts.length = 0;
  const jp = await conv();
  await say(c, cl, jp, "こんにちは世界");
  await until(() => ntfy.posts.length >= 1);
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(ntfy.posts[0].headers.title));
  assert.ok(m, String(ntfy.posts[0].headers.title));
  assert.equal(Buffer.from(m![1], "base64").toString("utf8"), "こんにちは世界");

  // error notification (high priority)
  ntfy.posts.length = 0;
  llm.script = () => ({ status: 500 });
  await say(c, cl, await conv(), "boom");
  await until(() => ntfy.posts.length >= 1);
  assert.equal(ntfy.posts[0].headers.priority, "high");
  assert.ok(cl.frames.some((f) => f.type === "notify" && f.kind === "error"));

  // switched off: neither WS nor ntfy
  await call("PUT", "/settings", { notify: { done: false, approval: true, error: true } });
  ntfy.posts.length = 0;
  const before = cl.frames.length;
  llm.script = () => ({ text: ["quiet"] });
  const q = await conv();
  await say(c, cl, q, "quiet please");
  await sleep(400);
  assert.equal(ntfy.posts.length, 0);
  assert.ok(!cl.frames.slice(before).some((f) => f.type === "notify" && f.conversationId === q));
  await call("PUT", "/settings", { notify: { done: true, approval: true, error: true } });
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

test("notify: approval requests notify, POST /notify/test", async () => {
  await call("DELETE", "/tool-grants/fsread");
  const rules = (await call("GET", "/approval-rules")).json.rules as any[];
  for (const r of rules) if (r.pattern === "fsread") await call("DELETE", `/approval-rules/${r.id}`);
  ntfy.posts.length = 0;
  llm.script = (b) => (b.messages.some((m: any) => m.role === "tool") ? { text: ["ok"] } : { calls: [{ id: "g1", name: "fsread", args: {} }] });
  const seen = answerApprovals(cl, () => "once");
  const id = await conv({ tools: ["fsread"], searchMode: "off" });
  await say(c, cl, id, "need approval");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conversationId, id);
  assert.equal(seen[0].codeStatus, "awaiting_approval");
  assert.ok(cl.frames.some((f) => f.type === "notify" && f.kind === "approval" && f.conversationId === id));
  await until(() => ntfy.posts.some((p) => p.headers.priority === "high" && /fsread/.test(p.headers.title as string)));
  assert.ok(cl.frames.some((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === id && x.codeStatus === "awaiting_approval")));
  answerApprovals(cl, () => null);

  ntfy.posts.length = 0;
  const t = await call("POST", "/notify/test", {});
  assert.equal(t.status, 200);
  await until(() => ntfy.posts.some((p) => p.body === "Test notification"));
  assert.equal((await call("POST", "/notify/test", {}, tok2)).status, 400, "no URL configured for the other user");
  assert.equal((await call("POST", "/notify/test", {}, "")).status, 401);
  llm.script = (b) => ({ text: [`R:${lastText(b)}`] });
});

/* ---------------- 5. templates ---------------- */

test("templates: CRUD, validation, per-scope names, sync and WS upsert", async () => {
  const id = randomUUID();
  const put = (i: string, b: any, tok?: string) => call("PUT", `/templates/${i}`, b, tok);
  assert.equal((await put(id, { body: "x" })).status, 400, "name required");
  assert.equal((await put(id, { name: "n" })).status, 400, "body required");
  assert.equal((await put(id, { name: "x".repeat(61), body: "b" })).status, 400);
  assert.equal((await put(id, { name: "n", body: "b".repeat(20_001) })).status, 400);
  assert.equal((await put(id, { name: "n", body: "b", kind: "weird" })).status, 400);
  assert.equal((await put(id, { name: "n", body: "not an action", kind: "action" })).status, 400);
  assert.equal((await put(id, { name: "n", body: "b", projectId: "missing" })).status, 400);
  const from = (await syncAll(c)).seq;
  const ok = await put(id, { name: "Review", body: "Review {{file}} please", description: "d" });
  assert.equal(ok.status, 200);
  assert.deepEqual({ ...ok.json, createdAt: 0, updatedAt: 0, seq: 0 }, { id, projectId: null, name: "Review", body: "Review {{file}} please", description: "d", kind: "prompt", createdAt: 0, updatedAt: 0, deleted: false, seq: 0 });
  await cl.waitFrame((f) => f.type === "upsert" && (f.templates ?? []).some((t: any) => t.id === id));

  const id2 = randomUUID();
  assert.equal((await put(id2, { name: "Review", body: "dup" })).status, 400, "unique per scope");
  const pid = randomUUID();
  await call("PUT", `/projects/${pid}`, { name: "TP" });
  assert.equal((await put(id2, { name: "Review", body: "scoped", projectId: pid })).status, 200, "same name in another scope");
  const act = randomUUID();
  assert.equal((await put(act, { name: "Search off", body: "search:off", kind: "action" })).status, 200);
  assert.equal((await put(randomUUID(), { name: "Bad action", body: "approval_mode:never", kind: "action" })).status, 400);
  assert.equal((await put(id, { name: "Hijack", body: "x" }, tok2)).status, 403);

  assert.equal((await put(id, { description: "changed" })).json.body, "Review {{file}} please", "omitted fields kept");
  const listAll = (await call("GET", "/templates")).json.templates as any[];
  assert.equal(listAll.length, 3);
  assert.deepEqual((await call("GET", `/templates?projectId=${pid}`)).json.templates.map((t: any) => t.name).sort(), ["Review", "Review", "Search off"]);
  assert.deepEqual((await call("GET", "/templates?projectId=global")).json.templates.map((t: any) => t.id).sort(), [act, id].sort());
  assert.equal((await call("GET", "/templates", undefined, tok2)).json.templates.length, 0);

  const sync = await syncAll(c, from);
  assert.equal(sync.templates.length, 3);
  assert.ok(sync.seq >= Math.max(...sync.templates.map((t: any) => t.seq)));
  assert.equal((await call("DELETE", `/templates/${id2}`, undefined, tok2)).status, 404);
  const del = await call("DELETE", `/templates/${id2}`);
  assert.equal(del.json.deleted, true);
  const after = await syncAll(c, sync.seq);
  assert.deepEqual(after.templates.map((t: any) => [t.id, t.deleted]), [[id2, true]]);
  assert.equal((await call("GET", "/templates")).json.templates.length, 2);
  assert.equal((await syncAll(c, 0)).templates.length >= 3, true, "full sync includes deleted rows");
});

/* ---------------- 6. pets ---------------- */

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function webpX(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
function webpL(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8L", 12, "latin1");
  b[20] = 0x2f; b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
}
function webpLossy(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); b.write("VP8 ", 12, "latin1");
  b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
}
const manifest = (id: string, v = 2) => ({ id, displayName: "Test Pet", description: "d", spriteVersionNumber: v, spritesheetPath: "spritesheet.png" });

test("readSheetSize: PNG IHDR and the three WebP flavours", () => {
  assert.deepEqual(readSheetSize(pngHeader(1536, 2288), "image/png"), { width: 1536, height: 2288 });
  assert.deepEqual(readSheetSize(webpX(1536, 2288), "image/webp"), { width: 1536, height: 2288 });
  assert.deepEqual(readSheetSize(webpL(1536, 1872), "image/webp"), { width: 1536, height: 1872 });
  assert.deepEqual(readSheetSize(webpLossy(1536, 2288), "image/webp"), { width: 1536, height: 2288 });
  assert.equal(readSheetSize(Buffer.alloc(40), "image/png"), null);
  assert.equal(readSheetSize(pngHeader(1, 1), "image/webp"), null);
});

test("pets: upload validates manifest, mime and pixel size; list/sheet/delete; per-user", async () => {
  const post = (b: any, tok?: string) => call("POST", "/pets", b, tok);
  const png = pngHeader(1536, 2288);
  const ok = await post({ manifest: manifest("mint"), sheetBase64: png.toString("base64"), mime: "image/png" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.id, "mint");
  assert.equal(ok.json.spriteVersionNumber, 2);
  assert.equal(ok.json.size, png.length);

  assert.equal((await post({ manifest: manifest("bad id!"), sheetBase64: png.toString("base64"), mime: "image/png" })).status, 400);
  assert.equal((await post({ manifest: { ...manifest("a"), spriteVersionNumber: 3 }, sheetBase64: png.toString("base64"), mime: "image/png" })).status, 400);
  assert.equal((await post({ manifest: manifest("a"), sheetBase64: png.toString("base64"), mime: "image/gif" })).status, 400);
  const wrong = await post({ manifest: manifest("a"), sheetBase64: pngHeader(1536, 1872).toString("base64"), mime: "image/png" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /1536x2288/);
  assert.match(wrong.json.error, /1536x1872/);
  assert.equal((await post({ manifest: manifest("a", 1), sheetBase64: pngHeader(1536, 1872).toString("base64"), mime: "image/png" })).status, 200, "v1 size accepted");
  assert.equal((await post({ manifest: manifest("a"), sheetBase64: webpX(1536, 2288).toString("base64"), mime: "image/png" })).status, 400, "mime must match the bytes");
  assert.equal((await post({ manifest: manifest("w"), sheetBase64: webpX(1536, 2288).toString("base64"), mime: "image/webp" })).status, 200);
  assert.equal((await post({ manifest: manifest("big"), sheetBase64: Buffer.alloc(9 * 1024 * 1024).toString("base64"), mime: "image/png" })).status, 400, "over 8 MB");
  assert.equal((await post({ manifest: manifest("e"), sheetBase64: "", mime: "image/png" })).status, 400);

  const list = (await call("GET", "/pets")).json.pets as any[];
  assert.deepEqual(list.map((p) => p.id).sort(), ["a", "mint", "w"]);
  assert.ok(!JSON.stringify(list).includes("sheetBase64"));
  const sheet = await fetch(`${c.s.base}/pets/mint/sheet`, { headers: { authorization: `Bearer ${c.token}` } });
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await sheet.arrayBuffer()), png);
  assert.equal((await fetch(`${c.s.base}/pets/mint/sheet`, { headers: { authorization: `Bearer ${tok2}` } })).status, 404);
  assert.equal((await fetch(`${c.s.base}/pets/mint/sheet`)).status, 401);

  // the same pet id can be imported by another user
  assert.equal((await post({ manifest: manifest("mint"), sheetBase64: webpL(1536, 2288).toString("base64"), mime: "image/webp" }, tok2)).status, 200);
  assert.equal((await call("GET", "/pets", undefined, tok2)).json.pets.length, 1);
  assert.equal((await call("GET", "/pets")).json.pets.find((p: any) => p.id === "mint").mime, "image/png", "other user did not overwrite");

  // replacing keeps one row
  assert.equal((await post({ manifest: manifest("mint"), sheetBase64: webpL(1536, 2288).toString("base64"), mime: "image/webp" })).status, 200);
  assert.equal((await call("GET", "/pets")).json.pets.filter((p: any) => p.id === "mint").length, 1);
  assert.equal((await call("DELETE", "/pets/mint")).status, 200);
  assert.equal((await call("DELETE", "/pets/mint")).status, 404);
  assert.equal((await call("GET", "/pets", undefined, tok2)).json.pets.length, 1);
});

const REAL_PET = join(homedir(), ".codex", "pets", "mintcodexpet");
test("pets: a real Codex pet (spritesheet.webp, v2) uploads when present", { skip: !existsSync(join(REAL_PET, "spritesheet.webp")) }, async () => {
  const sheet = readFileSync(join(REAL_PET, "spritesheet.webp"));
  const size = readSheetSize(sheet, "image/webp");
  assert.deepEqual(size, { width: 1536, height: 2288 });
  const r = await call("POST", "/pets", { manifest: manifest("real-mint"), sheetBase64: sheet.toString("base64"), mime: "image/webp" });
  assert.equal(r.status, 200, r.text);
  const back = await fetch(`${c.s.base}/pets/real-mint/sheet`, { headers: { authorization: `Bearer ${c.token}` } });
  assert.equal(Buffer.compare(Buffer.from(await back.arrayBuffer()), sheet), 0);
  await call("DELETE", "/pets/real-mint");
});

/* ---------------- 7. diagnostics ---------------- */

test("diagnostics: admin-only Markdown, no secrets, bounded log", async () => {
  const secretKey = "sk-SECRETKEY123456";
  const p2 = randomUUID();
  await call("PUT", `/providers/${p2}`, { name: "Cred", kind: "openai-compatible", baseUrl: "http://uzer:hunter2pw@127.0.0.1:9/v1", model: "m", apiKey: secretKey });
  console.log("test log line with Bearer abcdef0123456789 and token=tok_ZZZ999");
  assert.equal((await call("GET", "/admin/diagnostics", undefined, "")).status, 401);
  assert.equal((await call("GET", "/admin/diagnostics", undefined, tok2)).status, 403, "non-admin");
  const r = await fetch(`${c.s.base}/admin/diagnostics`, { headers: { authorization: `Bearer ${c.token}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/markdown/);
  const md = await r.text();
  assert.match(md, /^#/m);
  for (const secret of [secretKey, "hunter2pw", "uzer:", c.token, tok2, "secret-topic-xyz", "tok_ZZZ999", "abcdef0123456789"]) {
    assert.ok(!md.includes(secret), `leaked ${secret}`);
  }
  assert.match(md, /127\.0\.0\.1/);
  assert.match(md, new RegExp(process.version.replace(/\./g, "\\.")));
  assert.match(md, /Cred/);
  assert.ok(md.split("\n").length < 400);
  await call("DELETE", `/providers/${p2}`);
});

/* ---------------- 8. bridge frames (changes, agents, checkpoints, approvals, rewind) ---------------- */

interface FakeBridge { ws: WebSocket; got: any[]; send(o: unknown): void }
async function fakeBridge(name: string): Promise<FakeBridge> {
  const ws = await openWs(`ws://127.0.0.1:${c.s.port}/bridge?token=${c.token}&name=${name}`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: "ready", name, cwd: "C:\\proj" }));
  await sleep(100);
  return { ws, got, send: (o) => ws.send(JSON.stringify(o)) };
}

test("bridge frames: changes, agents, checkpoint, approvals (rules + user), rewind", async () => {
  const bridge = await fakeBridge("pc-v4");
  const dsh = randomUUID();
  await call("PUT", `/providers/${dsh}`, { name: "PC4", kind: "dsh-bridge", baseUrl: "pc-v4", model: "x" });
  const cv = randomUUID();
  assert.equal((await call("PUT", `/conversations/${cv}`, { providerId: dsh })).json.mode, "code");
  const pid = randomUUID();
  const denyRule = randomUUID();
  await call("PUT", `/approval-rules/${denyRule}`, { kind: "command", pattern: "rm *", action: "deny" });
  const allowRule = randomUUID();
  await call("PUT", `/approval-rules/${allowRule}`, { kind: "tool", pattern: "read_file", action: "allow" });
  void pid;

  const aid = randomUUID();
  cl.send({ type: "send", conversationId: cv, content: "build it", userMessageId: randomUUID(), assistantMessageId: aid });
  await until(() => bridge.got.some((m) => m.type === "run"));
  const runId = bridge.got.find((m) => m.type === "run").runId;

  // checkpoint
  bridge.send({ type: "checkpoint", requestId: runId, checkpointId: "cp-1", ref: "refs/omnichat/checkpoints/cp-1", createdAt: 1000, dirty: true });
  await cl.waitFrame((f) => f.type === "checkpoint" && f.checkpointId === "cp-1");
  const cps = (await call("GET", `/code/checkpoints?conversationId=${cv}`)).json.checkpoints as any[];
  assert.equal(cps.length, 1);
  assert.deepEqual({ ...cps[0], createdAt: 0 }, { id: "cp-1", conversationId: cv, messageId: aid, bridge: "pc-v4", cwd: "C:\\proj", ref: "refs/omnichat/checkpoints/cp-1", unavailable: null, dirty: true, createdAt: 0 });
  assert.equal((await call("GET", `/code/checkpoints?conversationId=${cv}`, undefined, tok2)).status, 404);
  assert.equal((await call("GET", "/code/checkpoints")).status, 400);

  // approval answered by a deny rule (command)
  bridge.send({ type: "approval", requestId: runId, approvalId: "ap-deny", tool: "bash", command: "rm -rf build" });
  await until(() => bridge.got.some((m) => m.type === "approval_reply" && m.approvalId === "ap-deny"));
  assert.equal(bridge.got.find((m) => m.approvalId === "ap-deny").decision, "rejected");
  // approval answered by an allow rule (tool)
  bridge.send({ type: "approval", requestId: runId, approvalId: "ap-allow", tool: "read_file", path: "a.txt" });
  await until(() => bridge.got.some((m) => m.type === "approval_reply" && m.approvalId === "ap-allow"));
  assert.equal(bridge.got.find((m) => m.approvalId === "ap-allow").decision, "allowed-once");
  assert.ok(!cl.frames.some((f) => f.type === "tool_approval" && (f.approvalId === "ap-deny" || f.approvalId === "ap-allow")), "rules answered without a prompt");

  // approval that goes to the user
  bridge.send({ type: "approval", requestId: runId, approvalId: "ap-user", tool: "bash", command: "npm test", reason: "run tests" });
  const ta = await cl.waitFrame((f) => f.type === "tool_approval" && f.approvalId === "ap-user");
  assert.equal(ta.conversationId, cv);
  assert.equal(ta.codeStatus, "awaiting_approval");
  assert.equal(ta.tool, "bash");
  assert.equal((await call("GET", "/code/sessions")).json.sessions.find((x: any) => x.conversationId === cv).pendingApprovals, 1);
  assert.equal((await convRow(cv)).codeStatus, "awaiting_approval");
  cl.send({ type: "tool_approval_reply", approvalId: "ap-user", decision: "once" });
  await until(() => bridge.got.some((m) => m.type === "approval_reply" && m.approvalId === "ap-user"));
  assert.equal(bridge.got.find((m) => m.approvalId === "ap-user").decision, "allowed-once");
  await until(() => (cl.frames.filter((f) => f.type === "upsert").flatMap((f) => f.conversations ?? []).filter((x: any) => x.id === cv).at(-1)?.codeStatus) === "running");

  // approval for a user decision "deny"
  bridge.send({ type: "approval", requestId: runId, approvalId: "ap-user2", tool: "bash", command: "curl x" });
  await cl.waitFrame((f) => f.type === "tool_approval" && f.approvalId === "ap-user2");
  cl.send({ type: "tool_approval_reply", approvalId: "ap-user2", decision: "deny" });
  await until(() => bridge.got.some((m) => m.approvalId === "ap-user2"));
  assert.equal(bridge.got.find((m) => m.approvalId === "ap-user2").decision, "rejected");

  // agents
  bridge.send({ type: "agents", requestId: runId, agents: [{ id: "a1", role: "reviewer", status: "running", startedAt: 5, endedAt: null }, { id: "bad", role: 5 }] });
  await until(() => cl.frames.some((f) => f.type === "upsert" && (f.messages ?? []).some((m: any) => m.id === aid && m.agents?.length)));
  bridge.send({ type: "agents", requestId: runId, agents: [{ id: "a1", role: "reviewer", status: "done", startedAt: 5, endedAt: 9, summary: "looked fine", log: "x".repeat(70_000) }] });
  // changes (one small patch, one patch > 20 KB, one > 200 KB capped)
  const big = "+" + "z".repeat(30_000);
  bridge.send({
    type: "changes", requestId: runId,
    changes: [
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" },
      { path: "src/big.ts", status: "added", additions: 1, deletions: 0, patch: big },
      { path: "src/huge.ts", status: "added", additions: 1, deletions: 0, patch: "+" + "h".repeat(250_000) },
      { path: "old.txt", status: "weird", additions: -4, deletions: 0 },
    ],
  });
  bridge.send({ type: "event", runId, event: { type: "text", text: "all done" } });
  bridge.send({ type: "done", runId, ok: true, sessionId: "sess-4" });
  const final = await cl.waitMsg(aid, (m) => m.status === "done");
  assert.equal(final.content, "all done");

  const m = await syncedMsg(aid);
  assert.equal(m.agents.length, 1);
  assert.equal(m.agents[0].status, "done");
  assert.equal(m.agents[0].summary, "looked fine");
  assert.ok(m.agents[0].log.length <= 64 * 1024);
  assert.deepEqual(m.changes.map((x: any) => [x.path, x.status, x.additions]), [["src/a.ts", "modified", 2], ["src/big.ts", "added", 1], ["src/huge.ts", "added", 1], ["old.txt", "modified", 0]]);
  assert.ok(m.changes[0].patch.includes("+b"), "small patch is synced");
  assert.equal("patch" in m.changes[1], false, "patch > 20 KB is omitted from sync");
  const full = (await call("GET", `/messages/${aid}/changes`)).json;
  assert.equal(full.messageId, aid);
  assert.equal(full.changes[1].patch, big);
  assert.ok(full.changes[2].patch.length <= 200 * 1024, "per-file cap");
  assert.equal((await call("GET", `/messages/${aid}/changes`, undefined, tok2)).status, 404);

  assert.equal((await convRow(cv)).codeStatus, "done");

  // rewind: the bridge is asked and answers
  bridge.got.length = 0;
  const rw = call("POST", "/code/checkpoints/cp-1/rewind", { removeNew: true });
  await until(() => bridge.got.some((x) => x.type === "rewind"));
  const rew = bridge.got.find((x) => x.type === "rewind");
  assert.deepEqual({ ref: rew.ref, cwd: rew.cwd, removeNew: rew.removeNew }, { ref: "refs/omnichat/checkpoints/cp-1", cwd: "C:\\proj", removeNew: true });
  bridge.send({ type: "rewound", requestId: rew.requestId, ok: true });
  assert.deepEqual((await rw).json, { ok: true });

  bridge.got.length = 0;
  const rw2 = call("POST", "/code/checkpoints/cp-1/rewind", {});
  await until(() => bridge.got.some((x) => x.type === "rewind"));
  const rew2 = bridge.got.find((x) => x.type === "rewind");
  assert.equal(rew2.removeNew, undefined);
  bridge.send({ type: "rewound", requestId: rew2.requestId, ok: false, error: "dirty tree" });
  const failed = await rw2;
  assert.equal(failed.status, 502);
  assert.match(failed.json.error, /dirty tree/);

  // unavailable checkpoint (non-git cwd) and unknown requestIds are harmless
  const aid2 = randomUUID();
  cl.send({ type: "send", conversationId: cv, content: "second", userMessageId: randomUUID(), assistantMessageId: aid2 });
  await until(() => bridge.got.some((x) => x.type === "run"));
  const run2 = bridge.got.find((x) => x.type === "run").runId;
  bridge.send({ type: "checkpoint", requestId: "nope", checkpointId: "cp-x", ref: "r" });
  bridge.send({ type: "changes", requestId: "nope", changes: [] });
  bridge.send({ type: "checkpoint", requestId: run2, checkpointId: "cp-2", unavailable: "not a git repository" });
  await cl.waitFrame((f) => f.type === "checkpoint_unavailable" && f.reason === "not a git repository");
  const cps2 = (await call("GET", `/code/checkpoints?conversationId=${cv}`)).json.checkpoints as any[];
  assert.deepEqual(cps2.map((x) => x.id).sort(), ["cp-1", "cp-2"]);
  assert.equal(cps2.find((x) => x.id === "cp-2").unavailable, "not a git repository");
  assert.equal((await call("POST", "/code/checkpoints/cp-2/rewind", {})).status, 400);
  // the run is in flight: rewind refused
  assert.equal((await call("POST", "/code/checkpoints/cp-1/rewind", {})).status, 409);
  assert.equal((await call("POST", "/code/checkpoints/cp-1/rewind", {}, tok2)).status, 404);
  bridge.send({ type: "done", runId: run2, ok: true, sessionId: "sess-4" });
  await cl.waitMsg(aid2);
  bridge.ws.close();
});
