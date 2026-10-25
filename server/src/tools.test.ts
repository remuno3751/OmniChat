import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, connect, newConv, say, sleep, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { api } from "./test-server.js";
import { startLlm, startSearx, writePlugin, answerApprovals, toolStatuses, type Llm, type Searx } from "./test-tools-util.js";
import { sanitizeTitle } from "./title.js";
import { createProvider } from "./providers/index.js";
import { truncateResult } from "./tools/registry.js";

let c: Ctx;
let cl: Client;
let llm: Llm;
let sx: Searx;
let provId: string;
let userTok2: string;

const PLUGIN_ID = "echo-plugin";
const manifest = (version: string) => JSON.stringify({
  id: PLUGIN_ID, name: "Echo", version, description: "test plugin", main: "index.mjs",
  tools: [
    { name: "echo", description: "echo text", parameters: { type: "object", properties: { text: { type: "string" } } }, permissions: [] },
    { name: "nonet", description: "reports fetch", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "netinfo", description: "reports fetch (network)", parameters: { type: "object", properties: {} }, permissions: ["network"] },
    { name: "fsread", description: "needs filesystem-read", parameters: { type: "object", properties: {} }, permissions: ["filesystem-read"] },
    { name: "slow", description: "never answers", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "big", description: "huge result", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "boom", description: "throws", parameters: { type: "object", properties: {} }, permissions: [] },
  ],
});
const moduleSrc = (v: string) => `
export const tools = {
  async echo(args) { return "echo:" + args.text + ":${v}"; },
  async nonet(args, ctx) { return "fetch:" + typeof ctx.fetch + ",signal:" + (ctx.signal instanceof AbortSignal) + ",user:" + (typeof ctx.userId); },
  async netinfo(args, ctx) { return "fetch:" + typeof ctx.fetch; },
  async fsread() { return "fs-ok"; },
  async slow() { await new Promise(() => {}); },
  async big() { return "x".repeat(20000); },
  async boom() { throw new Error("kaboom"); },
};`;

const call = (method: string, path: string, body?: unknown, tok?: string) => c.call(method, path, body, tok);
const convWith = (body: Record<string, unknown> = {}) => newConv(c, { providerId: provId, model: "llm-1", ...body });
const calls = (m: any) => (m.toolCalls ?? []) as any[];
const roleOf = (b: any, role: string) => (b.messages as any[]).filter((m) => m.role === role);

before(async () => {
  sx = await startSearx();
  c = await setup({
    ALLOW_REGISTRATION: "1", SEARXNG_URL: sx.url, TOOL_APPROVAL_TIMEOUT_MS: "2000", TOOL_TIMEOUT_MS: "1500", AUTO_TITLE_DEFAULT: "0", OMNICHAT_SEARCH_STATUS_TTL_MS: "0",
  });
  llm = await startLlm();
  provId = randomUUID();
  await call("PUT", `/providers/${provId}`, { name: "LLM", kind: "openai-compatible", baseUrl: llm.base, model: "llm-1" });
  userTok2 = (await api(c.s.base, "POST", "/auth/register", { username: "second", password: "password123" })).json.token;

  writePlugin(c.s.tmp, PLUGIN_ID, { "plugin.json": manifest("1.0.0"), "index.mjs": moduleSrc("v1") });
  writePlugin(c.s.tmp, "bad-json", { "plugin.json": "{not json", "index.mjs": "export const tools = {};" });
  writePlugin(c.s.tmp, "bad-manifest", {
    "plugin.json": JSON.stringify({ id: "bad-manifest", name: "x", version: "1", description: "x", main: "index.mjs", tools: [{ name: "Bad-Name", description: "x", parameters: {}, permissions: [] }] }),
    "index.mjs": "export const tools = {};",
  });
  writePlugin(c.s.tmp, "bad-perm", {
    "plugin.json": JSON.stringify({ id: "bad-perm", name: "x", version: "1", description: "x", main: "index.mjs", tools: [{ name: "ok_name", description: "x", parameters: { type: "object" }, permissions: ["root"] }] }),
    "index.mjs": "export const tools = {};",
  });
  writePlugin(c.s.tmp, "bad-module", {
    "plugin.json": JSON.stringify({ id: "bad-module", name: "x", version: "1", description: "x", main: "index.mjs", tools: [{ name: "broken", description: "x", parameters: { type: "object" }, permissions: [] }] }),
    "index.mjs": "throw new Error('module exploded');",
  });
  writePlugin(c.s.tmp, "missing-fn", {
    "plugin.json": JSON.stringify({ id: "missing-fn", name: "x", version: "1", description: "x", main: "index.mjs", tools: [{ name: "ghost", description: "x", parameters: { type: "object" }, permissions: [] }] }),
    "index.mjs": "export const tools = {};",
  });
  await sleep(300);
  assert.equal((await call("POST", "/tools/reload")).status, 200);
  await call("PUT", "/settings", {
    autoTitle: false, searchMode: "off", tools: ["echo", "nonet", "netinfo", "fsread", "slow", "big", "boom"],
    search: { readPages: false }, // the fake result URLs are not reachable; page reading has its own tests
  });
  cl = await connect(c);
});
after(() => { cl?.ws.close(); c?.stop(); llm?.close(); sx?.close(); });

test("sanitizeTitle: quotes, punctuation, think blocks, length", () => {
  assert.equal(sanitizeTitle('"Cats and Dogs."'), "Cats and Dogs");
  assert.equal(sanitizeTitle("Title: **Rust ownership basics**\nextra line"), "Rust ownership basics");
  assert.equal(sanitizeTitle("<think>hmm</think>\n「猫の飼い方」。"), "猫の飼い方");
  assert.equal(sanitizeTitle("   "), null);
  assert.equal(sanitizeTitle(42), null);
  assert.equal(sanitizeTitle("a".repeat(100))!.length, 60);
});

test("truncateResult caps at 8 KB (bytes)", () => {
  const t = truncateResult("あ".repeat(10000));
  assert.ok(Buffer.byteLength(t) <= 8192);
  assert.ok(t.endsWith("[truncated]"));
  assert.equal(truncateResult("short"), "short");
});

test("provider streams delta.tool_calls fragments into one tool_calls item", async () => {
  llm.script = () => ({ calls: [{ id: "c1", name: "echo", args: { text: "hi there" } }, { id: "c2", name: "nonet", args: {} }] });
  const items: any[] = [];
  const p = createProvider({ kind: "openai-compatible", baseUrl: llm.base, apiKey: "", model: "m" });
  const tools = [{ type: "function" as const, function: { name: "echo", description: "d", parameters: { type: "object" } } }];
  for await (const it of p.stream({ messages: [{ role: "user", content: "x" }], model: "m", signal: new AbortController().signal, tools })) items.push(it);
  const last = llm.bodies[llm.bodies.length - 1];
  assert.deepEqual(last.tools, tools);
  assert.deepEqual(items, [{ kind: "tool_calls", calls: [{ id: "c1", name: "echo", arguments: '{"text":"hi there"}' }, { id: "c2", name: "nonet", arguments: "{}" }] }]);
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("GET /tools: builtin, plugin tools, invalid manifests isolated per plugin", async () => {
  assert.equal((await call("GET", "/tools", undefined, "")).status, 401);
  const tools = (await call("GET", "/tools")).json.tools as any[];
  const by = (n: string) => tools.find((t) => t.name === n);
  assert.equal(by("web_search").source, "builtin");
  assert.equal(by("web_search").available, true);
  assert.equal(by("web_search").needsApproval, true);
  assert.deepEqual(by("web_search").permissions, ["network"]);
  assert.equal(by("echo").source, "plugin");
  assert.equal(by("echo").pluginId, PLUGIN_ID);
  assert.equal(by("echo").available, true);
  assert.equal(by("echo").needsApproval, false);
  assert.equal(by("netinfo").needsApproval, true);
  // invalid manifests: skipped with an error each, the good plugin is unaffected
  const err = (id: string) => tools.find((t) => t.pluginId === id && !t.available);
  assert.match(err("bad-json").error, /not valid JSON/);
  assert.match(err("bad-manifest").error, /Bad-Name/);
  assert.match(err("bad-perm").error, /permissions/);
  assert.match(err("bad-module").error, /module exploded/);
  assert.match(err("missing-fn").error, /ghost/);
  assert.equal(by("broken").available, false);
  assert.equal(by("ghost").available, false);
});

test("POST /tools/reload is admin only and re-imports changed modules (cache busting)", async () => {
  assert.equal((await call("POST", "/tools/reload", {}, userTok2)).status, 403);
  assert.equal((await call("POST", "/tools/reload", {}, "")).status, 401);
  const cv = await convWith({ tools: ["echo"] });
  llm.script = (_b, n) => (n === llm.bodies.length - 1 && !llm.bodies.at(-1).messages.some((m: any) => m.role === "tool")
    ? { calls: [{ name: "echo", args: { text: "a" } }] } : { text: ["done"] });
  const t1 = await say(c, cl, cv, "go");
  assert.equal(calls(t1.asst)[0].result, "echo:a:v1");

  writePlugin(c.s.tmp, PLUGIN_ID, { "plugin.json": manifest("1.0.1"), "index.mjs": moduleSrc("v2") });
  writePlugin(c.s.tmp, "late-plugin", {
    "plugin.json": JSON.stringify({ id: "late-plugin", name: "x", version: "1", description: "x", main: "index.mjs", tools: [{ name: "late_tool", description: "x", parameters: { type: "object" }, permissions: [] }] }),
    "index.mjs": "export const tools = { late_tool: async () => 'late' };",
  });
  const r = await call("POST", "/tools/reload", {});
  assert.equal(r.status, 200);
  assert.ok((r.json.tools as any[]).some((t) => t.name === "late_tool" && t.available));
  const t2 = await say(c, cl, cv, "go again");
  assert.equal(calls(t2.asst)[0].result, "echo:a:v2");
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("tool loop: multi-round, parallel calls, unknown tool, only final text is content, trace persisted and carried by sync", async () => {
  const cv = await convWith({ tools: ["echo", "nonet"] });
  const startBodies = llm.bodies.length;
  llm.script = (b, n) => {
    const k = n - startBodies;
    if (k === 0) return { text: ["thinking aloud. "], calls: [{ id: "A", name: "echo", args: { text: "one" } }, { id: "B", name: "nonexistent_tool", args: {} }] };
    if (k === 1) return { calls: [{ id: "C", name: "nonet", args: {} }] };
    if (k === 2) return { text: ["Final ", "answer."] };
    return { text: ["R:" + b.messages.at(-1).content] };
  };
  const t = await say(c, cl, cv, "do it");
  assert.equal(t.asst.status, "done");
  assert.equal(t.asst.content, "Final answer.");
  const tc = calls(t.asst);
  assert.deepEqual(tc.map((x) => [x.id, x.name, x.status]), [["A", "echo", "done"], ["B", "nonexistent_tool", "error"], ["C", "nonet", "done"]]);
  assert.equal(tc[0].result, "echo:one:v2");
  assert.deepEqual(tc[0].arguments, { text: "one" });
  assert.match(tc[1].error, /unknown tool/);
  assert.match(tc[2].result, /^fetch:undefined,signal:true/); // no network permission => no ctx.fetch
  assert.equal(typeof tc[0].durationMs, "number");
  assert.equal(typeof tc[0].startedAt, "number");
  // requests: 3 rounds, tools offered, tool messages appended
  const bs = llm.bodies.slice(startBodies);
  assert.equal(bs.length, 3);
  assert.deepEqual(bs[0].tools.map((x: any) => x.function.name).sort(), ["echo", "nonet"]);
  assert.equal(bs[0].tools[0].type, "function");
  const asstWithCalls = roleOf(bs[1], "assistant")[0];
  assert.equal(asstWithCalls.tool_calls.length, 2);
  assert.equal(asstWithCalls.tool_calls[0].function.arguments, '{"text":"one"}');
  const toolMsgs = roleOf(bs[1], "tool");
  assert.deepEqual(toolMsgs.map((m: any) => m.tool_call_id), ["A", "B"]);
  assert.equal(toolMsgs[0].content, "echo:one:v2");
  assert.match(toolMsgs[1].content, /^Error: unknown tool/);
  assert.equal(roleOf(bs[2], "tool").length, 3);
  // WS tool events for each call
  const st = toolStatuses(cl, t.assistantMessageId);
  assert.deepEqual(st.A, ["running", "done"]);
  assert.equal(st.B.at(-1), "error");
  // debug record
  const dbg = (await call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.equal(dbg.final.tools.rounds, 2);
  assert.deepEqual(dbg.final.tools.offered.sort(), ["echo", "nonet"]);
  assert.equal(dbg.final.tools.calls.length, 3);
  // sync carries the trace
  const sync = (await call("GET", "/sync?since=0")).json;
  const sm = sync.messages.find((m: any) => m.id === t.assistantMessageId);
  assert.deepEqual(sm.toolCalls.map((x: any) => x.id), ["A", "B", "C"]);
  assert.equal(sm.sources, null);
  // history re-send: final texts only, no traces replayed
  llm.script = (b) => ({ text: ["R2"] });
  const before2 = llm.bodies.length;
  await say(c, cl, cv, "next");
  const b2 = llm.bodies[before2];
  assert.deepEqual(b2.messages.map((m: any) => [m.role, m.content]), [
    ["user", "do it"], ["assistant", "Final answer."], ["user", "next"],
  ]);
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("MAX_TOOL_ROUNDS: after 6 tool rounds the model must answer without tools", async () => {
  const cv = await convWith({ tools: ["echo"] });
  const start = llm.bodies.length;
  llm.script = (b) => (b.tools ? { calls: [{ name: "echo", args: { text: "loop" } }] } : { text: ["gave up looping"] });
  const t = await say(c, cl, cv, "loop forever");
  const bs = llm.bodies.slice(start);
  assert.equal(bs.length, 7);
  assert.equal(bs[6].tools, undefined);
  assert.equal(t.asst.content, "gave up looping");
  assert.equal(calls(t.asst).length, 6);
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("tool errors, timeout, truncation, fetch only with network permission", async () => {
  const cv = await convWith({ tools: ["boom", "slow", "big"] });
  const start = llm.bodies.length;
  llm.script = (b, n) => {
    const k = n - start;
    if (k === 0) return { calls: [{ id: "1", name: "boom", args: {} }, { id: "2", name: "big", args: {} }, { id: "3", name: "slow", args: {} }] };
    return { text: ["ok anyway"] };
  };
  const t = await say(c, cl, cv, "hard", {});
  assert.equal(t.asst.status, "done");
  assert.equal(t.asst.content, "ok anyway");
  const tc = calls(t.asst);
  assert.equal(tc[0].status, "error");
  assert.match(tc[0].error, /kaboom/);
  assert.equal(tc[1].status, "done");
  assert.ok(Buffer.byteLength(tc[1].result) <= 8192, "result capped");
  assert.match(tc[1].result, /truncated/);
  assert.equal(tc[2].status, "error");
  assert.match(tc[2].error, /timed out/);
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("approvals: once asks every time, always stores a grant, deny, GET/DELETE /tool-grants", async () => {
  await call("DELETE", "/tool-grants/netinfo");
  const seen = answerApprovals(cl, (f) => (f.tool === "netinfo" ? decisions.shift() ?? "deny" : null));
  const decisions: ("once" | "always" | "deny")[] = ["once", "once", "always"];
  const cv = await convWith({ tools: ["netinfo", "echo"] });
  const start = llm.bodies.length;
  llm.script = (b, n) => {
    const k = n - start;
    if (k === 0) return { calls: [{ id: "n1", name: "netinfo", args: {} }, { id: "e1", name: "echo", args: { text: "x" } }] };
    if (k === 1) return { calls: [{ id: "n2", name: "netinfo", args: {} }] };
    if (k === 2) return { calls: [{ id: "n3", name: "netinfo", args: {} }, { id: "n4", name: "netinfo", args: {} }] };
    return { text: ["finished"] };
  };
  const t = await say(c, cl, cv, "approve me");
  const tc = calls(t.asst);
  assert.deepEqual(tc.map((x) => x.status), ["done", "done", "done", "done", "done"]);
  assert.equal(tc[0].result, "fetch:function"); // ctx.fetch present because "network" is declared
  // n1 once, n2 once, n3 always -> n4 no longer asks
  assert.deepEqual(seen.map((f) => f.tool), ["netinfo", "netinfo", "netinfo"]);
  assert.deepEqual(seen[0].permissions, ["network"]);
  assert.equal(seen[0].messageId, t.assistantMessageId);
  assert.equal(seen[0].conversationId, cv);
  assert.deepEqual(seen[0].arguments, {});
  const st = toolStatuses(cl, t.assistantMessageId);
  assert.deepEqual(st.n1, ["pending", "running", "done"]);
  assert.deepEqual(st.n4, ["running", "done"]);
  assert.deepEqual(st.e1, ["running", "done"]); // no permissions: never asks
  const g = (await call("GET", "/tool-grants")).json.grants as any[];
  assert.deepEqual(g.map((x) => x.tool), ["netinfo"]);
  assert.equal(typeof g[0].grantedAt, "number");
  assert.equal((await call("GET", "/tool-grants", undefined, userTok2)).json.grants.length, 0, "grants are per user");
  assert.equal((await call("DELETE", "/tool-grants/netinfo")).status, 200);
  assert.equal((await call("GET", "/tool-grants")).json.grants.length, 0);
  assert.equal((await call("GET", "/tool-grants", undefined, "")).status, 401);
  // deny: the model receives "denied by user", the call is "denied"
  decisions.push("deny");
  seen.length = 0;
  const start2 = llm.bodies.length;
  llm.script = (b, n) => (n === start2 ? { calls: [{ id: "d1", name: "netinfo", args: {} }] } : { text: ["understood"] });
  const t2 = await say(c, cl, cv, "again");
  const d = calls(t2.asst)[0];
  assert.equal(d.status, "denied");
  assert.equal(d.error, "denied by user");
  assert.equal(roleOf(llm.bodies[start2 + 1], "tool")[0].content, "Error: denied by user");
  assert.equal(t2.asst.content, "understood");
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("approval timeout denies; stop while pending denies and stops; disconnect denies", async () => {
  await call("DELETE", "/tool-grants/fsread");
  answerApprovals(cl, () => null);
  const cv = await convWith({ tools: ["fsread"] });
  llm.script = (_b, n) => (llm.bodies[n].messages.some((m: any) => m.role === "tool") ? { text: ["after"] } : { calls: [{ id: "f1", name: "fsread", args: {} }] });
  // timeout (no client answers): 2000 ms in this server
  const t0 = Date.now();
  const t = await say(c, cl, cv, "timeout");
  assert.ok(Date.now() - t0 >= 1800, "waited for the approval timeout");
  assert.equal(calls(t.asst)[0].status, "denied");
  assert.equal(t.asst.content, "after");

  // stop while pending
  const uid = randomUUID(), aid = randomUUID();
  cl.send({ type: "send", conversationId: cv, content: "stop me", userMessageId: uid, assistantMessageId: aid });
  await cl.waitFrame((f) => f.type === "tool_approval" && f.messageId === aid);
  cl.send({ type: "stop", messageId: aid });
  const stopped = await cl.waitMsg(aid, (m) => m.status === "stopped", 3000);
  assert.equal(stopped.status, "stopped");
  assert.equal(calls(stopped)[0].status, "denied");

  // disconnect of the only connection denies the pending approval
  const uid2 = randomUUID(), aid2 = randomUUID();
  cl.send({ type: "send", conversationId: cv, content: "drop", userMessageId: uid2, assistantMessageId: aid2 });
  await cl.waitFrame((f) => f.type === "tool_approval" && f.messageId === aid2);
  cl.ws.close();
  await sleep(500);
  const m = (await call("GET", "/sync?since=0")).json.messages.find((x: any) => x.id === aid2);
  assert.equal(m.status, "done", "generation finished without anybody connected");
  assert.equal(m.toolCalls[0].status, "denied");
  cl = await connect(c);
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("stop while a tool is running ends the message as stopped", async () => {
  const cv = await convWith({ tools: ["slow"] });
  llm.script = () => ({ calls: [{ id: "s1", name: "slow", args: {} }] });
  const uid = randomUUID(), aid = randomUUID();
  cl.send({ type: "send", conversationId: cv, content: "slow", userMessageId: uid, assistantMessageId: aid });
  await cl.waitFrame((f) => f.type === "tool" && f.messageId === aid && f.call.status === "running");
  cl.send({ type: "stop", messageId: aid });
  const m = await cl.waitMsg(aid, (x) => x.status === "stopped", 3000);
  assert.equal(m.status, "stopped");
  const tcs = (await call("GET", "/sync?since=0")).json.messages.find((x: any) => x.id === aid).toolCalls;
  assert.equal(tcs[0].status, "error");
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("builtin web_search via tool calling: results, numbering, sources, maxSites default 10 with a per-search share", async () => {
  await call("PUT", "/settings", { searchMode: "smart" });
  await call("DELETE", "/tool-grants/web_search");
  const cv = await convWith({});
  const before = sx.queries.length;
  const savedResults = sx.results;
  sx.results = Array.from({ length: 10 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://example.com/r${i + 1}`, content: `Snippet number ${i + 1}` }));
  const start = llm.bodies.length;
  const seen = answerApprovals(cl, (f) => (f.tool === "web_search" ? "always" : null));
  llm.script = (b, n) => {
    const k = n - start;
    if (k === 0) return { calls: [{ id: "w1", name: "web_search", args: { query: "cute cats" } }] };
    if (k === 1) return { calls: [{ id: "w2", name: "web_search", args: { query: "more cats" } }] };
    return { text: ["Cats are cute [1][2]."] };
  };
  const t = await say(c, cl, cv, "tell me about cats");
  assert.equal(t.asst.content, "Cats are cute [1][2].");
  assert.deepEqual(sx.queries.slice(before), ["cute cats", "more cats"], "the second search still has room and reaches the backend");
  const tc = calls(t.asst);
  assert.equal(tc[0].status, "done");
  // results arrive inside the untrusted envelope, numbered, with the per-answer usage tail
  assert.match(tc[0].result, /<<untrusted-[0-9a-f]+>>/);
  assert.match(tc[0].result, /\[1\] Result 1 — https:\/\/example\.com\/r1\nSnippet number 1 for cute cats/);
  assert.match(tc[0].result, /\[4\] Result 4 — /);
  assert.doesNotMatch(tc[0].result, /\[5\]/, "a first search of 10 results yields only its share: max(3, ceil(10/3)) = 4");
  assert.match(tc[0].result, /\(4\/10 sites used, 1\/3 searches used\)/);
  // the second search still has room and adds the next 4 new sites, numbering continues
  assert.match(tc[1].result, /\[5\] Result 5 — /);
  assert.match(tc[1].result, /\(8\/10 sites used, 2\/3 searches used\)/);
  assert.equal(t.asst.sources.length, 8);
  assert.deepEqual(t.asst.sources[0], { index: 1, title: "Result 1", url: "https://example.com/r1", snippet: "Snippet number 1 for cute cats" });
  assert.deepEqual(t.asst.sources.map((s: any) => s.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(seen.filter((f) => f.tool === "web_search").length, 1, "asked once, then granted forever");
  const offered = llm.bodies[start].tools.map((x: any) => x.function.name);
  assert.ok(offered.includes("web_search"));
  // sources + toolCalls are in sync and survive a re-read
  const sm = (await call("GET", "/sync?since=0")).json.messages.find((x: any) => x.id === t.assistantMessageId);
  assert.equal(sm.sources.length, 8);
  assert.equal(sm.toolCalls.length, 2);
  sx.results = savedResults;
  await call("DELETE", "/tool-grants/web_search");
  await call("PUT", "/settings", { searchMode: "off" });
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("searchMode off never offers web_search; resolution conversation > project > settings", async () => {
  const proj = randomUUID();
  await call("PUT", `/projects/${proj}`, { name: "P", tools: ["nonet"], searchMode: "smart" });
  await call("PUT", "/settings", { searchMode: "off", tools: ["echo"] });
  const names = async (body: Record<string, unknown>) => {
    const cv = await convWith(body);
    const start = llm.bodies.length;
    await say(c, cl, cv, "which tools?");
    const b = llm.bodies[start];
    return (b.tools ?? []).map((x: any) => x.function.name).sort();
  };
  assert.deepEqual(await names({}), ["echo"]); // settings
  assert.deepEqual(await names({ projectId: proj }), ["nonet", "web_search"]); // project overrides settings (tools + searchMode auto)
  assert.deepEqual(await names({ projectId: proj, tools: [] }), ["web_search"]); // [] = none, search stays auto
  assert.deepEqual(await names({ projectId: proj, tools: ["echo"], searchMode: "off" }), ["echo"]); // conversation wins
  assert.deepEqual(await names({ projectId: proj, tools: [], searchMode: "off" }), []);
  await call("PUT", "/settings", { tools: null });
});

test("always mode on a model without tool support: one search, results in the user message, sources, pending approval", async () => {
  llm.toolSupport = false;
  await call("DELETE", "/tool-grants/web_search");
  const cv = await convWith({ searchMode: "always", tools: [] });
  const start = llm.bodies.length;
  const q0 = sx.queries.length;
  const seen = answerApprovals(cl, (f) => (f.tool === "web_search" ? "once" : null));
  llm.script = () => ({ text: ["According to [2], yes."] });
  const long = "q".repeat(300) + " tail";
  const t = await say(c, cl, cv, long);
  assert.equal(t.asst.status, "done");
  assert.equal(t.asst.content, "According to [2], yes.");
  assert.equal(llm.bodies.length - start, 1, "a single model request");
  const b = llm.bodies[start];
  assert.equal(b.tools, undefined);
  assert.equal(sx.queries.length - q0, 1);
  assert.equal(sx.queries.at(-1), "q".repeat(200), "latest user message trimmed to 200 chars");
  assert.equal(roleOf(b, "system").length, 0, "web text never gets system authority");
  const ub = roleOf(b, "user").at(-1).content as string;
  assert.ok(ub.startsWith("q".repeat(300)), "the user's own words come first");
  assert.match(ub, /Web search results for the message above/);
  assert.match(ub, /<<untrusted-[0-9a-f]+>>[\s\S]*<<end-untrusted-[0-9a-f]+>>/);
  assert.match(ub, /\[1\] Result 1 — https:\/\/example\.com\/r1/);
  assert.match(ub, /Cite sources as \[n\]\. These results OVERRIDE your memory/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "web_search");
  assert.deepEqual(seen[0].arguments, { query: "q".repeat(200) });
  const tc = calls(t.asst);
  assert.equal(tc.length, 1);
  assert.equal(tc[0].name, "web_search");
  assert.equal(tc[0].status, "done");
  assert.equal(t.asst.sources.length, 4);
  const dbg = (await call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.equal(dbg.final.search.mode, "always");
  assert.equal(dbg.final.search.injected, true);
  assert.equal(dbg.final.search.sources, 4);
  assert.match(dbg.final.messages.at(-1).content, /Web search results for the message above/);

  // denied approval: reply continues without results
  answerApprovals(cl, (f) => (f.tool === "web_search" ? "deny" : null));
  const t2 = await say(c, cl, cv, "again please");
  assert.equal(t2.asst.status, "done");
  assert.equal(calls(t2.asst)[0].status, "denied");
  assert.equal(t2.asst.sources, null);
  // no results: the model is told not to invent citations
  const noRes = roleOf(llm.bodies.at(-1), "user").at(-1).content as string;
  assert.match(noRes, /do NOT cite sources/);
  assert.doesNotMatch(noRes, /Web search results for the message above/);
  llm.toolSupport = true;
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("smart falls back to always (once) when the backend rejects tools", async () => {
  llm.toolSupport = false;
  await call("DELETE", "/tool-grants/web_search");
  await call("PUT", "/settings", { searchMode: "smart", tools: ["echo"] });
  const cv = await convWith({});
  const start = llm.bodies.length;
  const q0 = sx.queries.length;
  answerApprovals(cl, (f) => (f.tool === "web_search" ? "once" : null));
  llm.script = () => ({ text: ["fallback answer"] });
  const t = await say(c, cl, cv, "need the web");
  assert.equal(t.asst.status, "done");
  assert.equal(t.asst.content, "fallback answer");
  assert.equal(llm.bodies.length - start, 2, "rejected request + one retry");
  assert.ok(llm.bodies[start].tools);
  assert.equal(llm.bodies[start + 1].tools, undefined);
  assert.match(roleOf(llm.bodies[start + 1], "user").at(-1).content, /\[1\] Result 1/);
  assert.equal(sx.queries.length - q0, 1);
  assert.equal(t.asst.sources.length, 4);
  const dbg = (await call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.equal(dbg.final.tools.fellBackToAlways, true);
  assert.equal(dbg.final.search.injected, true);

  // an unrelated backend failure (HTTP 401) is not retried
  llm.toolSupport = true;
  llm.script = () => ({ status: 401 });
  const start2 = llm.bodies.length;
  const t2 = await say(c, cl, cv, "fail");
  assert.equal(t2.asst.status, "error");
  assert.equal(llm.bodies.length - start2, 1);
  await call("PUT", "/settings", { searchMode: "off", tools: null });
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("SearXNG errors: HTML instead of JSON gives the clear message; search failure never fails the reply", async () => {
  sx.mode = "html";
  const r = await call("POST", "/search/test", { query: "x" });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /SearXNG returned HTML: enable `search\.formats: \[html, json\]`/);
  const st = (await call("GET", "/search/status")).json;
  assert.equal(st.configured, true);
  assert.equal(st.backend, "searxng");
  assert.equal(st.host, `127.0.0.1:${sx.port}`);
  assert.equal(st.reachable, true);
  assert.match(st.error, /search\.formats/);

  const cv = await convWith({ searchMode: "always", tools: [] });
  answerApprovals(cl, (f) => (f.tool === "web_search" ? "always" : null));
  llm.script = () => ({ text: ["no sources, but here I am"] });
  const t = await say(c, cl, cv, "search broken");
  assert.equal(t.asst.status, "done");
  assert.equal(t.asst.content, "no sources, but here I am");
  const tc = calls(t.asst)[0];
  assert.equal(tc.status, "error");
  assert.match(tc.error, /SearXNG returned HTML/);
  assert.equal(t.asst.sources, null);
  // the model is told that no results exist, so it must not invent citations
  assert.match(roleOf(llm.bodies.at(-1), "user").at(-1).content, /do NOT cite sources/);

  // smart mode: the tool error goes back to the model, the reply still completes
  await call("PUT", "/settings", { searchMode: "smart" });
  const cv2 = await convWith({});
  const start = llm.bodies.length;
  llm.script = (_b, n) => (n === start ? { calls: [{ id: "x", name: "web_search", args: { query: "q" } }] } : { text: ["answered without search"] });
  const t2 = await say(c, cl, cv2, "try");
  assert.equal(t2.asst.status, "done");
  assert.equal(t2.asst.content, "answered without search");
  assert.match(roleOf(llm.bodies[start + 1], "tool")[0].content, /^Error: SearXNG returned HTML/);

  sx.mode = "403";
  assert.match((await call("POST", "/search/test", { query: "x" })).json.error, /search\.formats/);
  sx.mode = "down";
  const down2 = (await call("GET", "/search/status")).json;
  assert.equal(down2.reachable, false);
  assert.ok(down2.error);
  assert.equal((await call("POST", "/search/test", { query: "x" })).status, 502);

  sx.mode = "json";
  assert.equal((await call("POST", "/search/test", { query: "x" }, userTok2)).status, 403, "admin only");
  assert.equal((await call("POST", "/search/test", {})).status, 400);
  assert.equal((await call("GET", "/search/status", undefined, "")).status, 401);
  await call("PUT", "/settings", { searchMode: "off" });
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("POST /search/test returns results (limit SEARCH_MAX_RESULTS=5, a diagnostics knob; the chat tool uses maxSites)", async () => {
  const r = await call("POST", "/search/test", { query: "hello world" });
  assert.equal(r.status, 200);
  assert.equal(r.json.results.length, 5);
  assert.deepEqual(r.json.results[0], { title: "Result 1", url: "https://example.com/r1", snippet: "Snippet number 1 for hello world" });
  assert.ok(sx.queries.includes("hello world"));
  const st = (await call("GET", "/search/status")).json;
  assert.equal(st.reachable, true);
  assert.equal(st.error, undefined);
});

test("auto title: after the first reply, sanitised, broadcast, titleModel, never overwrites a custom title", async () => {
  await call("PUT", "/settings", { autoTitle: true });
  llm.titleReply = '"Happy Cats Tutorial."\nignored';
  const cv = await convWith({});
  const tBefore = llm.titleBodies.length;
  const t = await say(c, cl, cv, "How do I make my cats happy?");
  await cl.waitFrame((f) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === cv && x.title === "Happy Cats Tutorial"), 4000);
  assert.equal(llm.titleBodies.length - tBefore, 1);
  const tb = llm.titleBodies.at(-1);
  assert.equal(tb.stream, false);
  assert.equal(tb.model, "llm-1");
  assert.equal(tb.messages[0].content, "Write a title of 3-6 words for this conversation. Reply with the title only.");
  assert.match(tb.messages[1].content, /How do I make my cats happy\?/);
  assert.match(tb.messages[1].content, /R:How do I make my cats happy\?/);
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.equal(sync.conversations.find((x: any) => x.id === cv).title, "Happy Cats Tutorial");
  assert.equal(t.asst.status, "done");

  // only the first reply
  await say(c, cl, cv, "second message");
  await sleep(200);
  assert.equal(llm.titleBodies.length - tBefore, 1);

  // custom title is kept
  const cv2 = await convWith({ title: "My own title" });
  await say(c, cl, cv2, "hello there");
  await sleep(200);
  assert.equal(llm.titleBodies.length - tBefore, 1);
  assert.equal((await call("GET", "/sync?since=0")).json.conversations.find((x: any) => x.id === cv2).title, "My own title");

  // titleModel: another model of the same provider; failures are ignored
  await call("PUT", "/settings", { titleModel: `${provId}::tiny-title-model` });
  llm.titleReply = null;
  const cv3 = await convWith({});
  const t3 = await say(c, cl, cv3, "please fail the title");
  await sleep(300);
  assert.equal(llm.titleBodies.at(-1).model, "tiny-title-model");
  await sleep(700); // a failed title request is retried once, 500 ms later
  assert.equal(llm.titleBodies.filter((b: any) => b.model === "tiny-title-model").length, 2);
  assert.equal(t3.asst.status, "done");
  assert.equal((await call("GET", "/sync?since=0")).json.conversations.find((x: any) => x.id === cv3).title, "please fail the title");

  // disabled
  await call("PUT", "/settings", { autoTitle: false, titleModel: null });
  const n = llm.titleBodies.length;
  await say(c, cl, await convWith({}), "no title wanted");
  await sleep(200);
  assert.equal(llm.titleBodies.length, n);
});

test("per-model params layer: one-shot > conversation > project > modelParams > global (and in debug final.params)", async () => {
  const proj = randomUUID();
  await call("PUT", `/projects/${proj}`, { name: "PP", params: { topK: 11, minP: 0.3 } });
  await call("PUT", "/settings", {
    params: { temperature: 0.9, topK: 3, seed: 5, minP: 0.2, repeatPenalty: 1.1, maxTokens: 500 },
    modelParams: { [`${provId}::llm-1`]: { temperature: 0.1, topK: 7, seed: 1, minP: 0.05, repeatPenalty: 1.5 }, "other::model": { temperature: 2 } },
  });
  const cv = await convWith({ projectId: proj, params: { temperature: 0.4 } });
  const start = llm.bodies.length;
  const t = await say(c, cl, cv, "params", { params: { seed: 99 } });
  const b = llm.bodies[start];
  assert.equal(b.seed, 99, "one-shot");
  assert.equal(b.temperature, 0.4, "conversation beats modelParams");
  assert.equal(b.top_k, 11, "project beats modelParams");
  assert.equal(b.min_p, 0.3, "project beats modelParams");
  assert.equal(b.repeat_penalty, 1.5, "modelParams beats global");
  assert.equal(b.max_tokens, 500, "global still fills the rest");
  const dbg = (await call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.deepEqual(dbg.final.params, { seed: 99, temperature: 0.4, topK: 11, minP: 0.3, repeatPenalty: 1.5, maxTokens: 500 });
  // a model without an entry only sees global
  const cv2 = await convWith({ model: "no-entry-model" });
  const s2 = llm.bodies.length;
  await say(c, cl, cv2, "plain");
  assert.equal(llm.bodies[s2].temperature, 0.9);
  assert.equal(llm.bodies[s2].top_k, 3);
  await call("PUT", "/settings", { params: null, modelParams: null });
});

test("fields: validation, defaults, PUT/GET, sync and upsert carry tools / searchMode / settings", async () => {
  const fresh = (await api(c.s.base, "GET", "/settings", undefined, userTok2)).json;
  assert.equal(fresh.autoTitle, false, "AUTO_TITLE_DEFAULT=0 in test servers (the production default is true)");
  assert.equal(fresh.searchMode, "smart");
  assert.equal(fresh.tools, null);
  assert.equal(fresh.titleModel, null);
  assert.equal(fresh.modelParams, null);

  assert.equal((await call("PUT", "/settings", { searchMode: "sometimes" })).status, 400);
  assert.equal((await call("PUT", "/settings", { searchMode: null })).status, 400);
  assert.equal((await call("PUT", "/settings", { tools: "echo" })).status, 400);
  assert.equal((await call("PUT", "/settings", { tools: ["Bad Name"] })).status, 400);
  assert.equal((await call("PUT", "/settings", { autoTitle: "yes" })).status, 400);
  assert.equal((await call("PUT", "/settings", { titleModel: 5 })).status, 400);
  assert.equal((await call("PUT", "/settings", { modelParams: [] })).status, 400);
  assert.equal((await call("PUT", "/settings", { modelParams: { "a::b": 5 } })).status, 400);
  const ok = await call("PUT", "/settings", {
    tools: ["echo", "echo", "web_search"], searchMode: "auto", autoTitle: true, titleModel: "p::m",
    modelParams: { "p::m": { temperature: 0.2, bogus: 1 }, "p::empty": { bogus: 1 } },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.tools, ["echo", "web_search"]);
  assert.equal(ok.json.searchMode, "smart", "stored auto (older clients) reads back as smart");
  assert.deepEqual(ok.json.modelParams, { "p::m": { temperature: 0.2 } });
  const part = (await call("PUT", "/settings", { devMode: true })).json;
  assert.equal(part.searchMode, "smart", "partial merge keeps the rest");

  const cv = randomUUID();
  assert.equal((await call("PUT", `/conversations/${cv}`, { tools: ["x y"] })).status, 400);
  assert.equal((await call("PUT", `/conversations/${cv}`, { searchMode: "maybe" })).status, 400);
  const created = (await call("PUT", `/conversations/${cv}`, { tools: ["echo"], searchMode: "always" })).json;
  assert.deepEqual(created.tools, ["echo"]);
  assert.equal(created.searchMode, "always");
  const upd = (await call("PUT", `/conversations/${cv}`, { title: "renamed" })).json;
  assert.deepEqual(upd.tools, ["echo"], "untouched fields are kept");
  const cleared = (await call("PUT", `/conversations/${cv}`, { tools: null, searchMode: null })).json;
  assert.equal(cleared.tools, null);
  assert.equal(cleared.searchMode, null);
  const plain = (await call("PUT", `/conversations/${randomUUID()}`, {})).json;
  assert.equal(plain.tools, null);
  assert.equal(plain.searchMode, null);

  const pid = randomUUID();
  assert.equal((await call("PUT", `/projects/${pid}`, { tools: 5 })).status, 400);
  const pr = (await call("PUT", `/projects/${pid}`, { name: "T", tools: [], searchMode: "auto" })).json;
  assert.deepEqual(pr.tools, []);
  assert.equal(pr.searchMode, "smart");
  const sync = (await call("GET", "/sync?since=0")).json;
  assert.deepEqual(sync.projects.find((p: any) => p.id === pid).tools, []);
  assert.equal(sync.settings.searchMode, "smart");
  assert.deepEqual(sync.conversations.find((x: any) => x.id === cv).tools, null);
  await call("PUT", "/settings", { tools: null, searchMode: "off", autoTitle: false, titleModel: null, modelParams: null });
});

test("snapshot, upsert and sync carry toolCalls + sources while a call is pending", async () => {
  await call("DELETE", "/tool-grants/fsread");
  await call("DELETE", "/tool-grants/web_search");
  answerApprovals(cl, () => null);
  const cv = await convWith({ tools: ["fsread"], searchMode: "always" });
  llm.script = (_b, n) => (llm.bodies[n].messages.some((m: any) => m.role === "tool") ? { text: ["end"] } : { calls: [{ id: "p1", name: "fsread", args: {} }] });
  const uid = randomUUID(), aid = randomUUID();
  // the always-search needs approval first: leave it pending and look at the snapshot from a second connection
  cl.send({ type: "send", conversationId: cv, content: "snap", userMessageId: uid, assistantMessageId: aid });
  const ap = await cl.waitFrame((f) => f.type === "tool_approval" && f.messageId === aid);
  assert.equal(ap.tool, "web_search");
  const cl2 = await connect(c);
  const snap = cl2.frames.find((f) => f.type === "snapshot");
  const sm = snap.messages.find((m: any) => m.id === aid);
  assert.equal(sm.toolCalls[0].status, "pending");
  assert.equal(sm.toolCalls[0].name, "web_search");
  assert.equal(sm.sources, null);
  const mid = (await call("GET", "/sync?since=0")).json.messages.find((x: any) => x.id === aid);
  assert.equal(mid.status, "streaming");
  assert.equal(mid.toolCalls[0].status, "pending");
  cl2.send({ type: "tool_approval_reply", approvalId: ap.approvalId, decision: "once" });
  const fs = await cl.waitFrame((f) => f.type === "tool_approval" && f.messageId === aid && f.tool === "fsread");
  cl2.send({ type: "tool_approval_reply", approvalId: fs.approvalId, decision: "once" });
  const done = await cl.waitMsg(aid, (m) => m.status === "done");
  assert.equal(done.content, "end");
  assert.equal(done.sources.length, 4, "sources are in the final upsert");
  assert.deepEqual(done.toolCalls.map((x: any) => [x.name, x.status]), [["web_search", "done"], ["fsread", "done"]]);
  assert.ok(cl2.frames.some((f) => f.type === "tool" && f.messageId === aid), "other devices see tool events");
  cl2.ws.close();
  llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
});

test("without SEARXNG_URL: web_search unavailable, /search/status not configured, always mode records the error", async () => {
  const c2 = await setup({ AUTO_TITLE_DEFAULT: "0", SEARCH_BACKEND: "searxng" });
  try {
    const cl3 = await connect(c2);
    const tools = (await c2.call("GET", "/tools")).json.tools as any[];
    const ws = tools.find((t) => t.name === "web_search");
    assert.equal(ws.available, false);
    assert.match(ws.error, /no search backend/);
    const st = (await c2.call("GET", "/search/status")).json;
    assert.equal(st.configured, false); assert.equal(st.backend, null); assert.equal(st.reachable, false);
    assert.equal((await c2.call("POST", "/search/test", { query: "x" })).status, 502);
    assert.equal((await api(c2.s.base, "GET", "/version")).json.searxng, false);
    await c2.call("PUT", "/settings", { searchMode: "always" });
    const cv = await newConv(c2, {});
    const t = await say(c2, cl3, cv, "hi");
    assert.equal(t.asst.status, "done");
    assert.match(t.asst.content, /^R:hi\n\n\[Web search was requested[\s\S]*-end$/,"the note rides on the user message (echoed by the fake model)");
    assert.equal(t.asst.toolCalls[0].status, "error");
    assert.match(t.asst.toolCalls[0].error, /no search backend/);
    cl3.ws.close();
  } finally { c2.stop(); }
});

test("settings.search: validation, defaults, domain normalisation, merge; stored 'auto' reads back as 'smart'", async () => {
  const bad = async (search: unknown) => assert.equal((await call("PUT", "/settings", { search })).status, 400, JSON.stringify(search));
  await bad({ maxSites: 0 });
  await bad({ maxSites: 31 });
  await bad({ maxSites: "5" });
  await bad({ maxSearches: 11 });
  await bad({ maxImages: 0 });
  await bad({ guard: "paranoid" });
  await bad({ visionModel: "x" });
  await bad({ readPages: "yes" });
  await bad({ searchModel: "no-separator" });
  await bad({ allowDomains: "example.com" });
  await bad([]);
  await bad(null);

  const fresh = (await api(c.s.base, "GET", "/settings", undefined, userTok2)).json;
  assert.equal(fresh.search.maxSites, 10, "default");
  assert.equal(fresh.search.maxSearches, 3, "default");
  assert.equal(fresh.search.readPages, true, "default");
  assert.equal(fresh.search.guard, "standard", "default");
  assert.equal(fresh.search.searchModel, null);

  const ok = await call("PUT", "/settings", { search: { maxSites: 7, allowDomains: ["https://WWW.Example.com/path?q=1", "*.foo.org", "not a domain", "example.com"], denyDomains: ["Bad.COM:8080"] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.search.maxSites, 7);
  assert.deepEqual(ok.json.search.allowDomains, ["example.com", "foo.org"], "normalised, invalid dropped, de-duplicated");
  assert.deepEqual(ok.json.search.denyDomains, ["bad.com"]);
  assert.equal(ok.json.search.maxSearches, 3);
  const merged = (await call("PUT", "/settings", { search: { maxSearches: 2 } })).json.search;
  assert.equal(merged.maxSites, 7, "a partial search object keeps the other fields");
  assert.equal(merged.maxSearches, 2);
  assert.equal(merged.readPages, false, "the suite's own setting is kept");
  assert.equal((await call("GET", "/settings")).json.search.maxSites, 7);
  assert.equal((await call("GET", "/sync?since=0")).json.settings.search.maxSites, 7, "sync carries it");
  await call("PUT", "/settings", { search: { maxSites: 10, maxSearches: 3, allowDomains: [], denyDomains: [] } });

  // older clients send "auto": stored and read back as "smart" everywhere
  assert.equal((await call("PUT", "/settings", { searchMode: "auto" })).json.searchMode, "smart");
  assert.equal((await call("GET", "/settings")).json.searchMode, "smart");
  const cvId = randomUUID();
  assert.equal((await call("PUT", `/conversations/${cvId}`, { searchMode: "auto" })).json.searchMode, "smart");
  const pid = randomUUID();
  assert.equal((await call("PUT", `/projects/${pid}`, { name: "A", searchMode: "auto" })).json.searchMode, "smart");
  await call("PUT", "/settings", { searchMode: "off" });
});

test("smart mode with a search model: the pre-answer plan call decides the query (and 'no search')", async () => {
  const llm2 = await startLlm();
  const prov2 = randomUUID();
  try {
    await call("PUT", `/providers/${prov2}`, { name: "Planner", kind: "openai-compatible", baseUrl: llm2.base, model: "planner" });
    await call("PUT", "/settings", { searchMode: "smart", tools: [], search: { searchModel: `${prov2}::planner` } });
    await call("DELETE", "/tool-grants/web_search");
    answerApprovals(cl, (f) => (f.tool === "web_search" ? "always" : null));
    const cv = await convWith({});
    llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });

    llm2.titleReply = '```json\n{"search": true, "query": "Qwen3.6 release date"}\n```';
    const start = llm.bodies.length, q0 = sx.queries.length, p0 = llm2.titleBodies.length;
    const t = await say(c, cl, cv, "hey, when did that new qwen thing come out? thanks!");
    assert.equal(t.asst.status, "done");
    assert.equal(llm.bodies.length - start, 1, "one answer request; the plan went to the search model");
    assert.equal(llm.bodies[start].tools, undefined, "no web_search tool is offered when a search model plans");
    assert.deepEqual(sx.queries.slice(q0), ["Qwen3.6 release date"], "the model's query, not the user's words");
    assert.ok(llm2.titleBodies.length - p0 >= 1);
    assert.equal(llm2.titleBodies[p0].model, "planner");
    assert.match(llm2.titleBodies[p0].messages[1].content, /when did that new qwen thing come out/);
    const ub = roleOf(llm.bodies[start], "user").at(-1).content as string;
    assert.match(ub, /Web search results for the message above/);
    assert.match(ub, /Snippet number 1 for Qwen3\.6 release date/);
    assert.equal(roleOf(llm.bodies[start], "system").length, 0);
    assert.equal(t.asst.sources.length, 4);
    const dbg = (await call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
    assert.equal(dbg.final.search.planned, "model");
    assert.equal(dbg.final.search.query, "Qwen3.6 release date");
    assert.equal(dbg.final.search.injected, true);

    // the model says no search: nothing is searched, nothing is injected
    llm2.titleReply = '{"search": false, "query": ""}';
    const q1 = sx.queries.length, s1 = llm.bodies.length;
    const t2 = await say(c, cl, cv, "thanks, that is all");
    assert.equal(t2.asst.status, "done");
    assert.equal(sx.queries.length, q1);
    assert.doesNotMatch(roleOf(llm.bodies[s1], "user").at(-1).content, /Web search/);
    assert.equal(t2.asst.sources, null);

    // an unusable plan reply (HTTP 500 here) falls back to the user's own words
    llm2.titleReply = null;
    const q2 = sx.queries.length;
    const t3 = await say(c, cl, await convWith({ searchMode: "always" }), "plain words query");
    assert.equal(t3.asst.status, "done");
    assert.deepEqual(sx.queries.slice(q2), ["plain words query"]);
    const dbg3 = (await call("GET", `/messages/${t3.assistantMessageId}/debug`)).json;
    assert.equal(dbg3.final.search.planned, "fallback");
  } finally {
    await call("PUT", "/settings", { searchMode: "off", tools: null, search: { searchModel: null } });
    await call("DELETE", "/tool-grants/web_search");
    llm2.close();
    llm.script = (b) => ({ text: [`R:${[...b.messages].reverse().find((m: any) => m.role === "user")?.content}`] });
  }
});
