import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { startServer, api, sleep, type TestServer } from "./test-server.js";
import { startFake, type Fake } from "./test-fake.js";
import { connect, randomUUID, type Client, type Ctx } from "./test-chat-util.js";
import { validateSetBody, MAX_SET_PROMPTS, MAX_PROMPT_CHARS } from "./bench.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

test("validateSetBody limits", () => {
  assert.equal(typeof validateSetBody({ name: "", prompts: ["a"] }), "string");
  assert.equal(typeof validateSetBody({ name: "n", prompts: [] }), "string");
  assert.equal(typeof validateSetBody({ name: "n", prompts: Array(MAX_SET_PROMPTS + 1).fill("a") }), "string");
  assert.equal(typeof validateSetBody({ name: "n", prompts: ["x".repeat(MAX_PROMPT_CHARS + 1)] }), "string");
  assert.equal(typeof validateSetBody({ name: "n", prompts: [" "] }), "string");
  const ok = validateSetBody({ name: " n ", prompts: ["a"], systemPrompt: "  " });
  assert.deepEqual(ok, { name: "n", prompts: ["a"], systemPrompt: null });
});

let s: TestServer;
let fake: Fake;
let token: string;
let provId: string;
let cl: Client;
const ctx = (): Ctx => ({ s, token, provId, be: null as any, call: (m: string, p: string, b?: unknown) => api(s.base, m, p, b, token), stop() {} }) as any;
const extra: TestServer[] = [];

const waitRun = async (id: string, ms = 15_000) => {
  const t = Date.now();
  for (;;) {
    const r = (await api(s.base, "GET", `/bench/runs/${id}`, undefined, token)).json;
    if (r && r.status !== "running") return r;
    if (Date.now() - t > ms) throw new Error("run did not finish: " + JSON.stringify(r?.status));
    await sleep(25);
  }
};

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  fake = await startFake({ echo: false, text: ["bench ", "answer"], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  token = (await api(s.base, "POST", "/auth/register", { username: "bench", password: "password123" })).json.token;
  provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: fake.base, model: "m" }, token);
  cl = await connect(ctx(), token);
});
after(() => { cl?.ws.close(); fake?.close(); s?.stop(); for (const e of extra) { e.child.kill(); try { rmSync(e.tmp, { recursive: true, force: true }); } catch { /* ignore */ } } });

test("prompt sets: CRUD and validation", async () => {
  const id = randomUUID();
  const put = await api(s.base, "PUT", `/bench/sets/${id}`, { name: "Set A", prompts: ["one", "two"], systemPrompt: "be brief" }, token);
  assert.equal(put.status, 200);
  assert.equal(put.json.name, "Set A");
  assert.deepEqual(put.json.prompts, ["one", "two"]);
  assert.equal((await api(s.base, "PUT", `/bench/sets/${id}`, { name: "Set A2", prompts: ["x"] }, token)).json.name, "Set A2");
  assert.equal((await api(s.base, "PUT", `/bench/sets/${randomUUID()}`, { name: "Too many", prompts: Array(51).fill("p") }, token)).status, 400);
  assert.equal((await api(s.base, "PUT", `/bench/sets/${randomUUID()}`, { name: "Long", prompts: ["x".repeat(8001)] }, token)).status, 400);
  const list = (await api(s.base, "GET", "/bench/sets", undefined, token)).json.sets;
  assert.ok(list.some((x: any) => x.id === id));
  assert.equal((await api(s.base, "DELETE", `/bench/sets/${id}`, undefined, token)).status, 200);
  assert.equal((await api(s.base, "DELETE", `/bench/sets/${id}`, undefined, token)).status, 404);
  assert.equal((await api(s.base, "GET", "/bench/sets")).status, 401);
});

test("a run executes warm-up, repeats and stores summary + CSV; progress frames are sent", async () => {
  const setId = randomUUID();
  await api(s.base, "PUT", `/bench/sets/${setId}`, { name: "Bench", prompts: ["p1", "p2"] }, token);
  const before = fake.bodies.length;
  const r = await api(s.base, "POST", "/bench/runs", {
    setId, targets: [{ providerId: provId, model: "b1" }, { providerId: provId, model: "b2", effort: "low" }], repeats: 2, maxTokens: 64,
  }, token);
  assert.equal(r.status, 200, r.text);
  const runId = r.json.runId;
  const run = await waitRun(runId);
  assert.equal(run.status, "done");
  assert.equal(run.total, 8);
  assert.equal(run.done, 8);
  assert.equal(run.results.length, 8);
  assert.ok(run.results.every((x: any) => x.status === "done" && x.answer.includes("bench answer")));
  assert.equal(run.summary.length, 2);
  assert.equal(run.summary[0].n, 4);
  assert.equal(run.summary[1].model, "b2");
  assert.equal(typeof run.summary[0].estimatedShare, "number");
  assert.ok(run.summary[0].minDecodeTps === null || run.summary[0].minDecodeTps <= run.summary[0].maxDecodeTps);
  // 2 warm-ups (tiny) + 8 measured requests
  const added = fake.bodies.slice(before);
  assert.equal(added.length, 10);
  assert.equal(added.filter((b) => b.max_tokens === 8).length, 2);
  assert.ok(added.filter((b) => b.max_tokens === 64).length === 8);
  assert.ok(added.filter((b) => b.model === "b2").every((b) => b.reasoning_effort === "low"), "effort low is sent to b2");

  const csv = await api(s.base, "GET", `/bench/runs/${runId}/export`, undefined, token);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^target,provider,model,prompt,repeat,status,/);
  assert.equal(csv.text.trim().split("\n").length, 9);

  const frames = cl.frames.filter((f) => f.runId === runId);
  assert.ok(frames.some((f) => f.type === "bench_progress"));
  assert.ok(frames.some((f) => f.type === "bench_done" && f.status === "done"));

  assert.equal((await api(s.base, "GET", "/bench/runs", undefined, token)).json.runs.length >= 1, true);
  assert.equal((await api(s.base, "DELETE", `/bench/runs/${runId}`, undefined, token)).status, 200);
  assert.equal((await api(s.base, "GET", `/bench/runs/${runId}`, undefined, token)).status, 404);
});

test("validation of run requests", async () => {
  const setId = randomUUID();
  await api(s.base, "PUT", `/bench/sets/${setId}`, { name: "V", prompts: ["p"] }, token);
  const t = { providerId: provId, model: "m" };
  assert.equal((await api(s.base, "POST", "/bench/runs", { setId, targets: Array(7).fill(t) }, token)).status, 400);
  assert.equal((await api(s.base, "POST", "/bench/runs", { setId, targets: [t], repeats: 6 }, token)).status, 400);
  assert.equal((await api(s.base, "POST", "/bench/runs", { setId, targets: [t], maxTokens: 0 }, token)).status, 400);
  assert.equal((await api(s.base, "POST", "/bench/runs", { setId: randomUUID(), targets: [t] }, token)).status, 404);
  assert.equal((await api(s.base, "POST", "/bench/runs", { setId, targets: [{ providerId: randomUUID(), model: "m" }] }, token)).status, 400);
});

test("one run at a time per user (409) and cancel", async () => {
  fake.cfg.delayMs = 40;
  fake.cfg.text = Array.from({ length: 30 }, (_, i) => `t${i} `);
  const setId = randomUUID();
  await api(s.base, "PUT", `/bench/sets/${setId}`, { name: "Slow", prompts: ["a", "b", "c"] }, token);
  const first = await api(s.base, "POST", "/bench/runs", { setId, targets: [{ providerId: provId, model: "slow" }], repeats: 1, warmup: false }, token);
  assert.equal(first.status, 200);
  const second = await api(s.base, "POST", "/bench/runs", { setId, targets: [{ providerId: provId, model: "slow" }] }, token);
  assert.equal(second.status, 409);
  assert.equal((await api(s.base, "POST", `/bench/runs/${first.json.runId}/cancel`, undefined, token)).status, 200);
  const run = await waitRun(first.json.runId);
  assert.equal(run.status, "cancelled");
  assert.ok(run.done < run.total);
  assert.equal((await api(s.base, "POST", `/bench/runs/${first.json.runId}/cancel`, undefined, token)).status, 409);
  assert.equal((await api(s.base, "POST", `/bench/runs/${randomUUID()}/cancel`, undefined, token)).status, 404);
  fake.cfg.delayMs = 0;
  fake.cfg.text = ["bench ", "answer"];
});

test("a server restart marks running benchmark runs as error", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omni-bench-"));
  const first = await startServer({ ALLOW_REGISTRATION: "1" }, tmp);
  const tok = (await api(first.base, "POST", "/auth/register", { username: "restart", password: "password123" })).json.token;
  extra.push(first);
  first.child.kill();
  await sleep(200);
  const db = new DatabaseSync(join(tmp, "t.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const user = (db.prepare("SELECT id FROM users LIMIT 1").get() as any).id;
  db.prepare(
    "INSERT INTO bench_runs (id, user_id, set_id, set_name, status, started_at, targets, repeats, warmup, max_tokens, prompt_count, total, done) VALUES ('stale-run', ?, NULL, 'Old', 'running', 1, '[]', 1, 0, 256, 1, 1, 0)",
  ).run(user);
  db.close();
  const second = await startServer({ ALLOW_REGISTRATION: "1" }, tmp);
  extra.push(second);
  const r = (await api(second.base, "GET", "/bench/runs/stale-run", undefined, tok)).json;
  assert.equal(r.status, "error");
  assert.match(r.error, /restarted/);
});

test("runs are owned by their user", async () => {
  const other = (await api(s.base, "POST", "/auth/register", { username: "intruder", password: "password123" })).json;
  // the first user is the admin; a second register is refused unless ALLOW_REGISTRATION is set (it is), so the id is distinct
  assert.ok(other.token);
  const runs = (await api(s.base, "GET", "/bench/runs", undefined, other.token)).json.runs;
  assert.equal(runs.length, 0);
});
