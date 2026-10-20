import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, connect, newConv, say, randomUUID, type Ctx, type Client } from "./test-chat-util.js";

const mapDir = mkdtempSync(join(tmpdir(), "omni-effort-"));
const mapFile = join(mapDir, "effort-map.json");
process.env.EFFORT_MAP = mapFile; // unit part of this file (in-process)
const { effortSupport, mapEffort, loadEffortMap, DEFAULT_EFFORT_MAP } = await import("./effort.js");

let c: Ctx;
let cl: Client;
before(async () => { c = await setup({ EFFORT_MAP: join(mapDir, "server-map.json") }); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); rmSync(mapDir, { recursive: true, force: true }); });

const lastBody = () => c.be.bodies[c.be.bodies.length - 1];

test("effort map: file is created with defaults, support classification, mapping", () => {
  const m = loadEffortMap();
  assert.deepEqual(m, JSON.parse(JSON.stringify(DEFAULT_EFFORT_MAP)));
  assert.equal(effortSupport("openai/gpt-oss-20b"), "supported");
  assert.equal(effortSupport("Qwen3-32B"), "supported");
  assert.equal(effortSupport("deepseek-r1-distill"), "supported");
  assert.equal(effortSupport("text-embedding-nomic"), "unsupported");
  assert.equal(effortSupport("gemma-3-1b-it"), "unsupported");
  assert.equal(effortSupport("llama-3.1-8b"), "unknown");
  assert.deepEqual(mapEffort("openai-compatible", "max"), { reasoning_effort: "high" });
  assert.deepEqual(mapEffort("openai-compatible", "low"), { reasoning_effort: "low" });
  assert.equal(mapEffort("dsh-bridge", "max"), "max");
  assert.equal(mapEffort("unknown-kind", "low"), null);
});

test("effort map reloads when the file mtime changes", () => {
  writeFileSync(mapFile, JSON.stringify({ "openai-compatible": { low: { x: 1 } }, reasoning: ["zzz"], noReasoning: [] }));
  const t = new Date(Date.now() + 5000);
  utimesSync(mapFile, t, t);
  assert.deepEqual(mapEffort("openai-compatible", "low"), { x: 1 });
  assert.equal(mapEffort("openai-compatible", "high"), null);
  assert.equal(effortSupport("zzz-model"), "supported");
  assert.equal(effortSupport("gpt-oss"), "unknown");
});

test("resolution: one-shot > conversation > project > global; mapped into reasoning_effort", async () => {
  const pid = randomUUID();
  await c.call("PUT", "/settings", { effort: "low" });
  await c.call("PUT", `/projects/${pid}`, { effort: "medium" });
  const conv = await newConv(c, { projectId: pid, effort: "high" });
  await say(c, cl, conv, "a");
  assert.equal(lastBody().reasoning_effort, "high");
  await say(c, cl, conv, "b", { effort: "max" });
  assert.equal(lastBody().reasoning_effort, "high", "max maps to high by default");
  await say(c, cl, conv, "c", { effort: "low" });
  assert.equal(lastBody().reasoning_effort, "low");
  await c.call("PUT", `/conversations/${conv}`, { effort: null });
  await say(c, cl, conv, "d");
  assert.equal(lastBody().reasoning_effort, "medium", "falls to project");
  await c.call("PUT", `/projects/${pid}`, { effort: null });
  await say(c, cl, conv, "e");
  assert.equal(lastBody().reasoning_effort, "low", "falls to global");
  await c.call("PUT", "/settings", { effort: null });
  await say(c, cl, conv, "f");
  assert.equal(lastBody().reasoning_effort, undefined);
});

test("known-unsupported models never get an effort; unknown/supported do", async () => {
  const conv = await newConv(c, { effort: "high", model: "gemma-3-1b-it" });
  await say(c, cl, conv, "x");
  assert.equal(lastBody().reasoning_effort, undefined);
  assert.equal(lastBody().model, "gemma-3-1b-it");
  await c.call("PUT", `/conversations/${conv}`, { model: "text-embedding-3" });
  await say(c, cl, conv, "y");
  assert.equal(lastBody().reasoning_effort, undefined);
  await c.call("PUT", `/conversations/${conv}`, { model: "mystery-model" });
  await say(c, cl, conv, "z");
  assert.equal(lastBody().reasoning_effort, "high", "unknown => still sent");
  await c.call("PUT", `/conversations/${conv}`, { model: "gpt-oss-20b" });
  await say(c, cl, conv, "w");
  assert.equal(lastBody().reasoning_effort, "high");
});

test("custom server effort map is honoured without restart", async () => {
  const f = join(mapDir, "server-map.json");
  writeFileSync(f, JSON.stringify({
    "openai-compatible": { low: { reasoning: { effort: "minimal" } }, medium: { reasoning_effort: "medium" }, high: { reasoning_effort: "high" }, max: { reasoning_effort: "xhigh" } },
    noReasoning: [], reasoning: [],
  }));
  const t = new Date(Date.now() + 5000);
  utimesSync(f, t, t);
  const conv = await newConv(c, { effort: "max", model: "gemma-3-1b-it" });
  await say(c, cl, conv, "q");
  assert.equal(lastBody().reasoning_effort, "xhigh", "noReasoning emptied => gemma now gets effort");
  await say(c, cl, conv, "r", { effort: "low" });
  assert.deepEqual(lastBody().reasoning, { effort: "minimal" });
  assert.equal(lastBody().reasoning_effort, undefined);
});

test("thinking off: maps to reasoning_effort none, also when an older map file has no 'off' entry", () => {
  assert.deepEqual(mapEffort("openai-compatible", "off"), { reasoning_effort: "none" });
  assert.equal(mapEffort("dsh-bridge", "off"), "off" in (DEFAULT_EFFORT_MAP["dsh-bridge"] as object) ? "off" : null);
  const before = loadEffortMap();
  writeFileSync(mapFile, JSON.stringify({ "openai-compatible": { low: { reasoning_effort: "low" } } }));
  utimesSync(mapFile, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(mapEffort("openai-compatible", "off"), { reasoning_effort: "none" }, "falls back to the built-in entry");
  assert.deepEqual(mapEffort("openai-compatible", "low"), { reasoning_effort: "low" }, "the file wins where it has an entry");
  writeFileSync(mapFile, JSON.stringify(before));
  utimesSync(mapFile, new Date(), new Date(Date.now() + 10000));
});
