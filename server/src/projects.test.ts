import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, connect, newConv, randomUUID, syncAll, type Ctx, type Client } from "./test-chat-util.js";

let c: Ctx;
let cl: Client;
before(async () => { c = await setup(); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); });

test("project CRUD, defaults, broadcast and sync", async () => {
  const id = randomUUID();
  let r = await c.call("PUT", `/projects/${id}`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.name, "New project");
  assert.equal(r.json.systemMode, "append");
  assert.equal(r.json.systemPrompt, null);
  assert.equal(r.json.effort, null);
  assert.equal(r.json.params, null);
  assert.equal(r.json.deleted, false);
  assert.equal(typeof r.json.seq, "number");

  r = await c.call("PUT", `/projects/${id}`, {
    name: "Alpha", systemPrompt: "P", systemMode: "replace", defaultProviderId: c.provId, defaultModel: "m1",
    effort: "high", params: { temperature: 0.4, topK: 20, bogus: 1 },
  });
  assert.equal(r.json.name, "Alpha");
  assert.equal(r.json.systemMode, "replace");
  assert.equal(r.json.effort, "high");
  assert.deepEqual(r.json.params, { temperature: 0.4, topK: 20 });
  // partial update keeps the rest
  r = await c.call("PUT", `/projects/${id}`, { name: "Beta" });
  assert.equal(r.json.name, "Beta");
  assert.equal(r.json.defaultModel, "m1");
  assert.equal(r.json.systemPrompt, "P");
  // validation
  assert.equal((await c.call("PUT", `/projects/${id}`, { effort: "ultra" })).status, 400);
  assert.equal((await c.call("PUT", `/projects/${id}`, { systemMode: "x" })).status, 400);
  assert.equal((await c.call("PUT", `/projects/${id}`, {}, "")).status, 401);

  await cl.waitFrame((f) => f.type === "upsert" && f.projects?.some((p: any) => p.id === id && p.name === "Beta"));
  const s = await syncAll(c);
  assert.ok(s.projects.some((p: any) => p.id === id && p.name === "Beta"));
  assert.ok(Array.isArray(s.presets));
});

test("new conversation in a project inherits provider/model; explicit values win", async () => {
  const pid = randomUUID();
  await c.call("PUT", `/projects/${pid}`, { name: "Inh", defaultProviderId: c.provId, defaultModel: "proj-model" });
  const a = randomUUID(), b = randomUUID();
  let r = await c.call("PUT", `/conversations/${a}`, { projectId: pid });
  assert.equal(r.json.providerId, c.provId);
  assert.equal(r.json.model, "proj-model");
  assert.equal(r.json.projectId, pid);
  r = await c.call("PUT", `/conversations/${b}`, { projectId: pid, providerId: "other", model: "mine" });
  assert.equal(r.json.providerId, "other");
  assert.equal(r.json.model, "mine");
  // unknown project rejected
  assert.equal((await c.call("PUT", `/conversations/${randomUUID()}`, { projectId: "nope" })).status, 400);
});

test("deleting a project moves its conversations to Unclassified with upserts", async () => {
  const pid = randomUUID();
  await c.call("PUT", `/projects/${pid}`, { name: "Doomed" });
  const c1 = await newConv(c, { projectId: pid });
  const c2 = await newConv(c, { projectId: pid });
  const c3 = await newConv(c);
  const before = cl.frames.length;
  const r = await c.call("DELETE", `/projects/${pid}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
  const f = await cl.waitFrame((x) => cl.frames.indexOf(x) >= before && x.type === "upsert" && x.projects?.some((p: any) => p.id === pid && p.deleted));
  const moved = (f.conversations ?? []).map((x: any) => x.id).sort();
  assert.deepEqual(moved, [c1, c2].sort());
  for (const x of f.conversations) assert.equal(x.projectId, null);
  const s = await syncAll(c);
  const byId = Object.fromEntries(s.conversations.map((x: any) => [x.id, x]));
  assert.equal(byId[c1].projectId, null);
  assert.equal(byId[c2].projectId, null);
  assert.equal(byId[c3].projectId, null);
  assert.equal(s.projects.find((p: any) => p.id === pid).deleted, true);
  assert.equal((await c.call("DELETE", `/projects/${randomUUID()}`)).status, 404);
});

test("presets CRUD + broadcast", async () => {
  const id = randomUUID();
  let r = await c.call("PUT", `/presets/${id}`, { name: "Pirate", text: "Talk like a pirate" });
  assert.equal(r.json.name, "Pirate");
  assert.equal(r.json.text, "Talk like a pirate");
  r = await c.call("PUT", `/presets/${id}`, { text: "Arr" });
  assert.equal(r.json.name, "Pirate");
  assert.equal(r.json.text, "Arr");
  await cl.waitFrame((f) => f.type === "upsert" && f.presets?.some((p: any) => p.id === id && p.text === "Arr"));
  r = await c.call("DELETE", `/presets/${id}`);
  assert.equal(r.json.deleted, true);
  const s = await syncAll(c);
  assert.equal(s.presets.find((p: any) => p.id === id).deleted, true);
});

test("settings: partial merge, broadcast, sync only when changed", async () => {
  const s0 = (await c.call("GET", "/settings")).json;
  assert.equal(s0.systemPrompt, null);
  assert.equal(s0.devMode, false);
  let r = await c.call("PUT", "/settings", { systemPrompt: "Global", effort: "low", params: { temperature: 0.1 } });
  assert.equal(r.json.systemPrompt, "Global");
  assert.equal(r.json.effort, "low");
  r = await c.call("PUT", "/settings", { devMode: true });
  assert.equal(r.json.devMode, true);
  assert.equal(r.json.systemPrompt, "Global");
  assert.deepEqual(r.json.params, { temperature: 0.1 });
  const seq = r.json.seq;
  await cl.waitFrame((f) => f.type === "upsert" && f.settings?.devMode === true);
  assert.equal((await c.call("PUT", "/settings", { effort: "nope" })).status, 400);

  const full = await syncAll(c);
  assert.equal(full.settings.seq, seq);
  const unchanged = await syncAll(c, seq);
  assert.equal(unchanged.settings, undefined);
  await c.call("PUT", "/settings", { effort: null });
  const changed = await syncAll(c, seq);
  assert.equal(changed.settings.effort, null);
  assert.equal(changed.settings.systemPrompt, "Global");
  // reset for later tests in this file
  await c.call("PUT", "/settings", { systemPrompt: null, params: null });
});

test("conversation v3 fields round-trip with nullable defaults", async () => {
  const id = randomUUID();
  let r = await c.call("PUT", `/conversations/${id}`, {});
  for (const [k, v] of Object.entries({ projectId: null, systemPrompt: null, systemMode: "append", effort: null, params: null, headId: null })) {
    assert.deepEqual(r.json[k], v, k);
  }
  r = await c.call("PUT", `/conversations/${id}`, { systemPrompt: "S", systemMode: "replace", effort: "medium", params: { seed: 3, stop: ["x"] } });
  assert.equal(r.json.systemPrompt, "S");
  assert.equal(r.json.systemMode, "replace");
  assert.equal(r.json.effort, "medium");
  assert.deepEqual(r.json.params, { seed: 3, stop: ["x"] });
  assert.equal((await c.call("PUT", `/conversations/${id}`, { effort: "bad" })).status, 400);
  r = await c.call("PUT", `/conversations/${id}`, { title: "T" });
  assert.equal(r.json.systemPrompt, "S", "untouched fields kept");
});
