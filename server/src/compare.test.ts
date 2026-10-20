import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api, sleep, type TestServer } from "./test-server.js";
import { startFake, type Fake } from "./test-fake.js";
import { connect, randomUUID, type Client, type Ctx } from "./test-chat-util.js";

let s: TestServer;
let fake: Fake;
let token: string;
let provId: string;
let cl: Client;
const ctx = (): Ctx => ({ s, token, provId, be: null as any, call: (m: string, p: string, b?: unknown) => api(s.base, m, p, b, token), stop() {} }) as any;

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  fake = await startFake({ echo: false, text: ["answer ", "text"], reasoning: ["think"], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  token = (await api(s.base, "POST", "/auth/register", { username: "compare", password: "password123" })).json.token;
  provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: fake.base, model: "m1" }, token);
  cl = await connect(ctx(), token);
});
after(() => { cl?.ws.close(); fake?.close(); s?.stop(); });

const run = async (body: Record<string, unknown>) => {
  const compareId = randomUUID();
  cl.send({ type: "compare", compareId, prompt: "compare me", ...body });
  await cl.waitFrame((f) => f.type === "compare_complete" && f.compareId === compareId, 10_000);
  return { compareId, frames: cl.frames.filter((f) => f.compareId === compareId) };
};

test("sequential compare streams both targets in order and stores the comparison", async () => {
  const { compareId, frames } = await run({
    targets: [
      { providerId: provId, model: "m1", effort: "high" },
      { providerId: provId, model: "m2", responseFormat: { type: "json_object" } },
    ],
  });
  const done0 = frames.findIndex((f) => f.type === "compare_done" && f.index === 0);
  const firstDelta1 = frames.findIndex((f) => f.type === "compare_delta" && f.index === 1);
  assert.ok(done0 >= 0, "target 0 done");
  assert.ok(firstDelta1 > done0, "target 1 starts only after target 0 finished (sequential)");
  const d0 = frames[done0];
  assert.equal(d0.status, "done");
  assert.equal(d0.content, "answer text");
  assert.equal(d0.reasoning, "think");
  assert.equal(d0.metrics.origin, "compare");
  assert.ok(frames.some((f) => f.type === "compare_delta" && f.kind === "reasoning" && f.index === 0));
  assert.equal(frames[frames.length - 1].type, "compare_complete");

  const bodies = fake.bodies.slice(-2);
  assert.equal(bodies[0].model, "m1");
  assert.equal(bodies[0].reasoning_effort, "high");
  assert.equal(bodies[0].response_format, undefined);
  assert.equal(bodies[1].model, "m2");
  assert.deepEqual(bodies[1].response_format, { type: "json_object" });
  assert.equal(bodies[0].messages.length, 1, "one-shot: no conversation context");

  const list = (await api(s.base, "GET", "/comparisons", undefined, token)).json.comparisons;
  const mine = list.find((c: any) => c.id === compareId);
  assert.ok(mine, "listed");
  assert.equal(mine.prompt, "compare me");
  assert.deepEqual(mine.statuses, ["done", "done"]);
  const one = (await api(s.base, "GET", `/comparisons/${compareId}`, undefined, token)).json;
  assert.equal(one.results.length, 2);
  assert.equal(one.results[0].content, "answer text");
  assert.equal(one.targets[1].model, "m2");

  // not in chat history, not in /stats
  const sync = (await api(s.base, "GET", "/sync?since=0", undefined, token)).json;
  assert.equal((sync.messages ?? []).filter((m: any) => m.content === "compare me").length, 0);
  const stats = (await api(s.base, "GET", "/stats", undefined, token)).json;
  assert.equal(stats.overall.count, 0, "compare runs are not counted in /stats");

  assert.equal((await api(s.base, "GET", `/comparisons/${randomUUID()}`, undefined, token)).status, 404);
  assert.equal((await api(s.base, "DELETE", `/comparisons/${compareId}`, undefined, token)).status, 200);
  assert.equal((await api(s.base, "GET", `/comparisons/${compareId}`, undefined, token)).status, 404);
  assert.equal((await api(s.base, "GET", "/comparisons")).status, 401);
});

test("concurrent compare (sequential:false) finishes every target", async () => {
  const { frames } = await run({
    sequential: false,
    targets: [{ providerId: provId, model: "a" }, { providerId: provId, model: "b" }, { providerId: provId, model: "c" }],
  });
  const dones = frames.filter((f) => f.type === "compare_done").map((f) => f.index).sort();
  assert.deepEqual(dones, [0, 1, 2]);
});

test("invalid compare requests get an error frame", async () => {
  const bad = async (body: Record<string, unknown>, re: RegExp) => {
    const compareId = randomUUID();
    cl.send({ type: "compare", compareId, ...body });
    const f = await cl.waitFrame((x) => x.type === "error" && x.compareId === compareId);
    assert.match(f.message, re);
  };
  const t = { providerId: provId, model: "m1" };
  await bad({ prompt: "x", targets: [t, t, t, t, t] }, /1 to 4/);
  await bad({ prompt: "x", targets: [] }, /1 to 4/);
  await bad({ prompt: "", targets: [t] }, /prompt/);
  await bad({ prompt: "x", targets: [{ providerId: randomUUID(), model: "m" }] }, /Unknown provider/);
  await bad({ prompt: "x", targets: [{ ...t, responseFormat: { type: "nope" } }] }, /responseFormat/);
  await bad({ prompt: "x", targets: [t], responseFormat: { type: "nope" } }, /responseFormat/);
});

test("dsh-bridge targets are rejected", async () => {
  const bridge = randomUUID();
  const r = await api(s.base, "PUT", `/providers/${bridge}`, { name: "Bridge", kind: "dsh-bridge", baseUrl: "", model: "x" }, token);
  assert.equal(r.status, 200, "a dsh-bridge provider can be stored (its bridge connects later)");
  const compareId = randomUUID();
  cl.send({ type: "compare", compareId, prompt: "x", targets: [{ providerId: bridge, model: "x" }] });
  const f = await cl.waitFrame((x) => x.type === "error" && x.compareId === compareId);
  assert.match(f.message, /cannot be compared/);
});

test("compare_stop stops the running target and marks the rest stopped", async () => {
  fake.cfg.delayMs = 40;
  fake.cfg.text = Array.from({ length: 50 }, (_, i) => `w${i} `);
  const compareId = randomUUID();
  cl.send({ type: "compare", compareId, prompt: "long", targets: [{ providerId: provId, model: "slow1" }, { providerId: provId, model: "slow2" }] });
  await cl.waitFrame((f) => f.type === "compare_delta" && f.compareId === compareId);
  cl.send({ type: "compare_stop", compareId });
  await cl.waitFrame((f) => f.type === "compare_complete" && f.compareId === compareId, 10_000);
  const dones = cl.frames.filter((f) => f.compareId === compareId && f.type === "compare_done");
  assert.equal(dones.length, 2);
  assert.equal(dones[0].status, "stopped");
  assert.equal(dones[1].status, "stopped");
  const stored = (await api(s.base, "GET", `/comparisons/${compareId}`, undefined, token)).json;
  assert.deepEqual(stored.results.map((r: any) => r.status), ["stopped", "stopped"]);
  fake.cfg.delayMs = 0;
  fake.cfg.text = ["answer ", "text"];
});
