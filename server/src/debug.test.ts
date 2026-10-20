import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, connect, newConv, say, sleep, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { api, openWs } from "./test-server.js";

let c: Ctx;
let cl: Client;
before(async () => { c = await setup({ ALLOW_REGISTRATION: "1" }); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); });

test("debug endpoint: final request, effort resolution and raw response", async () => {
  await c.call("PUT", "/settings", { systemPrompt: "SYS", effort: "max", params: { temperature: 0.5, topK: 9 } });
  const conv = await newConv(c, { model: "qwen3-8b" });
  const t = await say(c, cl, conv, "hello");
  const r = await c.call("GET", `/messages/${t.assistantMessageId}/debug`);
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.model, "qwen3-8b");
  assert.equal(d.providerKind, "openai-compatible");
  assert.deepEqual(d.final.messages, [{ role: "system", content: "SYS" }, { role: "user", content: "hello" }]);
  assert.deepEqual(d.final.params, { temperature: 0.5, topK: 9 });
  assert.deepEqual(d.final.effort, { requested: "max", resolved: "max", sentAs: { reasoning_effort: "high" } });
  assert.equal(d.response.status, 200);
  assert.equal(d.response.finishReason, "stop");
  assert.deepEqual(d.response.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.deepEqual(d.response.timings, { predicted_ms: 1 });
  assert.ok(d.response.raw && typeof d.response.raw === "object", "raw last SSE object");
  assert.equal(typeof d.createdAt, "number");
  // what was recorded is what the backend actually received
  const body = c.be.bodies[c.be.bodies.length - 1];
  assert.deepEqual(body.messages, d.final.messages);
  assert.equal(body.reasoning_effort, "high");

  // user messages and unknown ids have none
  assert.equal((await c.call("GET", `/messages/${t.userMessageId}/debug`)).status, 404);
  assert.equal((await c.call("GET", `/messages/${randomUUID()}/debug`)).status, 404);
  assert.equal((await c.call("GET", `/messages/${t.assistantMessageId}/debug`, undefined, "")).status, 401);
  await c.call("PUT", "/settings", { systemPrompt: null, effort: null, params: null });
});

test("debug of a known-unsupported model records requested but not resolved effort", async () => {
  const conv = await newConv(c, { model: "text-embedding-x", effort: "low" });
  const t = await say(c, cl, conv, "e");
  const d = (await c.call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.deepEqual(d.final.effort, { requested: "low", resolved: null, sentAs: null });
});

test("debug is owner only", async () => {
  const conv = await newConv(c);
  const t = await say(c, cl, conv, "mine");
  const other = (await api(c.s.base, "POST", "/auth/register", { username: "other", password: "password123" })).json.token;
  assert.ok(other);
  assert.equal((await api(c.s.base, "GET", `/messages/${t.assistantMessageId}/debug`, undefined, other)).status, 404);
  assert.equal((await c.call("GET", `/messages/${t.assistantMessageId}/debug`)).status, 200);
});

test("debug is capped at 256 KB", async () => {
  const conv = await newConv(c);
  const big = "x".repeat(400_000);
  const t = await say(c, cl, conv, big);
  const r = await c.call("GET", `/messages/${t.assistantMessageId}/debug`);
  assert.equal(r.status, 200);
  assert.ok(Buffer.byteLength(r.text) <= 256 * 1024, `size ${r.text.length}`);
  assert.equal(r.json.final.messages[0].role, "user");
});

test("backend HTTP errors are recorded in debug", async () => {
  const bad = randomUUID();
  await c.call("PUT", `/providers/${bad}`, { name: "Bad", kind: "openai-compatible", baseUrl: `http://127.0.0.1:1/v1`, model: "m" });
  const conv = await newConv(c, { providerId: bad });
  const t = await say(c, cl, conv, "hi");
  assert.equal(t.asst.status, "error");
  const d = (await c.call("GET", `/messages/${t.assistantMessageId}/debug`)).json;
  assert.deepEqual(d.final.messages, [{ role: "user", content: "hi" }]);
});

test("snapshot of streaming messages on (re)connect, deltas continue", async () => {
  const conv = await newConv(c);
  c.be.slowMs = 400;
  try {
    const um = randomUUID(), am = randomUUID();
    cl.send({ type: "send", conversationId: conv, content: "stream", userMessageId: um, assistantMessageId: am });
    await cl.waitFrame((f) => f.type === "delta" && f.messageId === am);
    const second = await openWs(`ws://127.0.0.1:${c.s.port}/ws?token=${c.token}`);
    const frames: any[] = [];
    second.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    const t0 = Date.now();
    while (!frames.some((f) => f.type === "snapshot")) { if (Date.now() - t0 > 3000) throw new Error("no snapshot"); await sleep(10); }
    assert.equal(frames[0].type, "hello");
    assert.equal(frames[1].type, "snapshot");
    const snap = frames[1].messages.find((m: any) => m.id === am);
    assert.ok(snap, "streaming message in snapshot");
    assert.equal(snap.conversationId, conv);
    assert.equal(snap.status, "streaming");
    assert.equal(snap.content, "R:stream", "text so far (not the empty DB value)");
    const t1 = Date.now();
    while (!frames.some((f) => f.type === "delta" && f.messageId === am && f.text === "-end")) { if (Date.now() - t1 > 3000) throw new Error("no delta"); await sleep(10); }
    await cl.waitMsg(am);
    second.close();
    // after completion a new connection has an empty snapshot
    const third = await connect(c);
    const snap3 = third.frames.find((f) => f.type === "snapshot");
    assert.deepEqual(snap3.messages.filter((m: any) => m.id === am), []);
    third.ws.close();
  } finally { c.be.slowMs = 0; }
});

test("dsh-bridge receives run.effort; mirrored messages chain linearly with head at the last", async () => {
  const dshP = randomUUID();
  await c.call("PUT", `/providers/${dshP}`, { name: "PC", kind: "dsh-bridge", baseUrl: "mybridge", model: "x" });
  const ws = await openWs(`ws://127.0.0.1:${c.s.port}/bridge?token=${c.token}&name=mybridge`);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: "ready", name: "mybridge", cwd: "C:\\work" }));
  await sleep(150);
  try {
    const conv = await newConv(c, { providerId: dshP });
    await c.call("PUT", `/conversations/${conv}`, { effort: "high" });
    const um = randomUUID(), am = randomUUID();
    cl.send({ type: "send", conversationId: conv, content: "do it", userMessageId: um, assistantMessageId: am, effort: "max" });
    const t0 = Date.now();
    while (!got.some((f) => f.type === "run")) { if (Date.now() - t0 > 3000) throw new Error("no run"); await sleep(10); }
    const run = got.find((f) => f.type === "run");
    assert.equal(run.effort, "max");
    assert.equal(run.prompt, "do it");
    ws.send(JSON.stringify({ type: "event", runId: run.runId, event: { type: "text", text: "ok" } }));
    ws.send(JSON.stringify({ type: "done", runId: run.runId, ok: true, sessionId: "sess-1" }));
    await cl.waitMsg(am);

    // mirror: dsh adds a turn for the same session
    ws.send(JSON.stringify({ type: "sessions", sessions: [{
      sessionId: "sess-1", cwd: "C:\\work", title: null, updatedAt: Date.now(),
      messages: [
        { key: "u:5:0", role: "user", text: "from gui", createdAt: Date.now() + 10, status: "done" },
        { key: "a:5", role: "assistant", text: "gui reply", createdAt: Date.now() + 20, status: "done" },
      ],
    }] }));
    await sleep(300);
    const s = (await c.call("GET", "/sync?since=0")).json;
    const rows = s.messages.filter((m: any) => m.conversationId === conv);
    assert.equal(rows.length, 4);
    const gui = rows.find((m: any) => m.content === "from gui");
    const guiA = rows.find((m: any) => m.content === "gui reply");
    assert.equal(gui.parentId, am, "chained after the app's assistant message");
    assert.equal(guiA.parentId, gui.id);
    assert.equal(s.conversations.find((x: any) => x.id === conv).headId, guiA.id);
  } finally { ws.close(); }
});
