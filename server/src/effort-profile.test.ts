import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, connect, newConv, say, randomUUID, type Ctx, type Client } from "./test-chat-util.js";

const mapDir = mkdtempSync(join(tmpdir(), "omni-effprof-"));
const mapFile = join(mapDir, "effort-map.json");
process.env.EFFORT_MAP = mapFile; // unit part of this file (in-process)
const { mapEffort, parseEffortProfile, DEFAULT_EFFORT_MAP } = await import("./effort.js");

let c: Ctx;
let cl: Client;
before(async () => { c = await setup({ EFFORT_MAP: join(mapDir, "server-map.json") }); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); rmSync(mapDir, { recursive: true, force: true }); });

const lastBody = () => c.be.bodies[c.be.bodies.length - 1];
const levels = ["off", "low", "medium", "high", "max"] as const;

/** Write the map file and make sure the next load sees it (mtime bump). */
function writeMap(obj: unknown) {
  writeFileSync(mapFile, JSON.stringify(obj));
  utimesSync(mapFile, new Date(), new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)));
}

test("profiles: each profile x five levels maps as specified", () => {
  writeMap(JSON.parse(JSON.stringify(DEFAULT_EFFORT_MAP)));
  assert.deepEqual(levels.map((l) => mapEffort("openai-compatible", l, "xhigh")), [
    { chat_template_kwargs: { enable_thinking: false } },
    { reasoning_effort: "low" },
    { reasoning_effort: "medium" },
    { reasoning_effort: "xhigh" },
    { reasoning_effort: "xhigh" },
  ]);
  assert.deepEqual(levels.map((l) => mapEffort("openai-compatible", l, "think-toggle")), [
    { chat_template_kwargs: { enable_thinking: false } },
    { chat_template_kwargs: { enable_thinking: true } },
    { chat_template_kwargs: { enable_thinking: true } },
    { chat_template_kwargs: { enable_thinking: true } },
    { chat_template_kwargs: { enable_thinking: true } },
  ]);
  for (const l of levels) assert.equal(mapEffort("openai-compatible", l, "none"), null, `none/${l}`);
  // the profile does not depend on the kind
  assert.deepEqual(mapEffort("some-other-kind", "high", "xhigh"), { reasoning_effort: "xhigh" });
});

test("standard, null and unknown profile names use the per-kind map", () => {
  for (const l of levels) {
    const base = mapEffort("openai-compatible", l);
    assert.deepEqual(mapEffort("openai-compatible", l, "standard"), base, `standard/${l}`);
    assert.deepEqual(mapEffort("openai-compatible", l, null), base, `null/${l}`);
    assert.deepEqual(mapEffort("openai-compatible", l, "bogus-profile"), base, `unknown/${l}`);
  }
  assert.deepEqual(mapEffort("openai-compatible", "high", "standard"), { reasoning_effort: "high" });
  assert.equal(mapEffort("dsh-bridge", "max", "standard"), "max");
});

test("effort map written before profiles existed: built-in profiles are used", () => {
  writeMap({ "openai-compatible": { low: { reasoning_effort: "low" } }, reasoning: [], noReasoning: [] });
  assert.deepEqual(mapEffort("openai-compatible", "high", "xhigh"), { reasoning_effort: "xhigh" });
  assert.deepEqual(mapEffort("openai-compatible", "off", "xhigh"), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(mapEffort("openai-compatible", "low", "think-toggle"), { chat_template_kwargs: { enable_thinking: true } });
  assert.equal(mapEffort("openai-compatible", "high", "none"), null);
  // the kind map of that old file still wins for standard
  assert.deepEqual(mapEffort("openai-compatible", "low"), { reasoning_effort: "low" });
  assert.equal(mapEffort("openai-compatible", "high"), null);
  writeMap(JSON.parse(JSON.stringify(DEFAULT_EFFORT_MAP)));
});

test("parseEffortProfile: accepted values and normalisation", () => {
  assert.deepEqual(parseEffortProfile(null), { ok: true, value: null });
  assert.deepEqual(parseEffortProfile(undefined), { ok: true, value: null });
  assert.deepEqual(parseEffortProfile("standard"), { ok: true, value: null });
  assert.deepEqual(parseEffortProfile("xhigh"), { ok: true, value: "xhigh" });
  assert.deepEqual(parseEffortProfile("think-toggle"), { ok: true, value: "think-toggle" });
  assert.deepEqual(parseEffortProfile("none"), { ok: true, value: "none" });
  for (const bad of ["Xhigh", "", 1, true, {}, ["xhigh"]]) assert.deepEqual(parseEffortProfile(bad), { ok: false }, String(bad));
});

test("provider API: effortProfile round-trips through PUT and sync; invalid values are 400", async () => {
  const pid = randomUUID();
  const base = { name: "Profiled", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model" };
  let r = await c.call("PUT", `/providers/${pid}`, { ...base, effortProfile: "think-toggle" });
  assert.equal(r.status, 200);
  assert.equal(r.json.effortProfile, "think-toggle");
  let s = await c.call("GET", "/sync");
  assert.equal(s.json.providers.find((p: any) => p.id === pid).effortProfile, "think-toggle");

  // absent field keeps the stored value; "standard" is stored as null
  r = await c.call("PUT", `/providers/${pid}`, { ...base, name: "Renamed" });
  assert.equal(r.json.effortProfile, "think-toggle", "absent = keep");
  r = await c.call("PUT", `/providers/${pid}`, { ...base, effortProfile: "standard" });
  assert.equal(r.json.effortProfile, null);
  r = await c.call("PUT", `/providers/${pid}`, { ...base, effortProfile: "none" });
  assert.equal(r.json.effortProfile, "none");
  r = await c.call("PUT", `/providers/${pid}`, { ...base, effortProfile: null });
  assert.equal(r.json.effortProfile, null);

  // a new provider without the field has no profile
  const pid2 = randomUUID();
  r = await c.call("PUT", `/providers/${pid2}`, base);
  assert.equal(r.json.effortProfile, null);

  for (const bad of ["bogus", "Xhigh", 3, false]) {
    r = await c.call("PUT", `/providers/${pid2}`, { ...base, effortProfile: bad });
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  // rejected writes changed nothing
  s = await c.call("GET", "/sync");
  assert.equal(s.json.providers.find((p: any) => p.id === pid2).effortProfile, null);
});

test("request body: an xhigh provider sends reasoning_effort xhigh (high) and enable_thinking false (off)", async () => {
  const pid = randomUUID();
  await c.call("PUT", `/providers/${pid}`, { name: "Bonsai", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model", effortProfile: "xhigh" });
  const conv = await newConv(c, { providerId: pid, effort: "high" });
  await say(c, cl, conv, "a");
  assert.equal(lastBody().reasoning_effort, "xhigh");
  assert.equal(lastBody().chat_template_kwargs, undefined);
  await say(c, cl, conv, "b", { effort: "off" });
  assert.deepEqual(lastBody().chat_template_kwargs, { enable_thinking: false });
  assert.equal(lastBody().reasoning_effort, undefined);
  await say(c, cl, conv, "c", { effort: "low" });
  assert.equal(lastBody().reasoning_effort, "low");
});

test("request body: think-toggle provider sends enable_thinking only; none sends no effort fields", async () => {
  const tt = randomUUID();
  await c.call("PUT", `/providers/${tt}`, { name: "Toggle", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model", effortProfile: "think-toggle" });
  const conv = await newConv(c, { providerId: tt, effort: "medium" });
  await say(c, cl, conv, "a");
  assert.deepEqual(lastBody().chat_template_kwargs, { enable_thinking: true });
  assert.equal(lastBody().reasoning_effort, undefined);

  const nn = randomUUID();
  await c.call("PUT", `/providers/${nn}`, { name: "Nothing", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model", effortProfile: "none" });
  await c.call("PUT", `/conversations/${conv}`, { providerId: nn });
  await say(c, cl, conv, "b", { effort: "high" });
  assert.equal(lastBody().reasoning_effort, undefined);
  assert.equal(lastBody().chat_template_kwargs, undefined);
});

test("request body: a provider without a profile is unchanged (standard map)", async () => {
  const pid = randomUUID();
  await c.call("PUT", `/providers/${pid}`, { name: "Plain", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${c.be.port}/v1`, model: "fake-model" });
  const conv = await newConv(c, { providerId: pid, effort: "high" });
  await say(c, cl, conv, "a");
  assert.equal(lastBody().reasoning_effort, "high");
  await say(c, cl, conv, "b", { effort: "off" });
  assert.equal(lastBody().reasoning_effort, "none");
  assert.equal(lastBody().chat_template_kwargs, undefined);
});
