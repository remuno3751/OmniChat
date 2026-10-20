import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";
import { startServer, api, type TestServer } from "./test-server.js";
import { randomUUID } from "node:crypto";

let s: TestServer;
let tokA: string;
let tokB: string;
let provA: string;
const SECRET = "sk-SECRET-VALUE-42";

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  tokA = (await api(s.base, "POST", "/auth/register", { username: "cfg-a", password: "password123" })).json.token;
  tokB = (await api(s.base, "POST", "/auth/register", { username: "cfg-b", password: "password123" })).json.token;
  provA = randomUUID();
  await api(s.base, "PUT", `/providers/${provA}`, { name: "Local LM", kind: "openai-compatible", baseUrl: "http://127.0.0.1:9/v1", model: "gemma", apiKey: SECRET }, tokA);
  const proj = randomUUID();
  await api(s.base, "PUT", `/projects/${proj}`, { name: "Research", systemPrompt: "Be precise", effort: "high", defaultProviderId: provA, defaultModel: "gemma" }, tokA);
  await api(s.base, "PUT", "/presets/" + randomUUID(), { name: "Summarize", text: "Summarize:" }, tokA);
  await api(s.base, "PUT", `/bench/sets/${randomUUID()}`, { name: "Smoke", prompts: ["hi", "bye"], systemPrompt: null }, tokA);
  await api(s.base, "PUT", "/settings", { systemPrompt: "global", effort: "low", titleModel: `${provA}::gemma`, modelParams: { [`${provA}::gemma`]: { temperature: 0.4 } } }, tokA);
});
after(() => s?.stop());

test("export json: providers by name, no secrets, no conversations", async () => {
  const r = await api(s.base, "GET", "/config/export?format=json", undefined, tokA);
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get("content-type")), /application\/json/);
  const cfg = JSON.parse(r.text);
  assert.equal(cfg.version, 1);
  assert.ok(cfg.exportedAt);
  assert.equal(cfg.projects[0].name, "Research");
  assert.equal(cfg.projects[0].defaultModel, "Local LM::gemma");
  assert.equal(cfg.settings.titleModel, "Local LM::gemma");
  assert.deepEqual(cfg.settings.modelParams, { "Local LM::gemma": { temperature: 0.4 } });
  assert.equal(cfg.presets[0].name, "Summarize");
  assert.equal(cfg.benchSets[0].prompts.length, 2);
  assert.ok(!r.text.includes(SECRET), "no api keys");
  assert.ok(!r.text.includes(provA), "no provider ids");
  assert.ok(!("conversations" in cfg));
});

test("export yaml parses to the same document", async () => {
  const j = JSON.parse((await api(s.base, "GET", "/config/export?format=json", undefined, tokA)).text);
  const r = await api(s.base, "GET", "/config/export?format=yaml", undefined, tokA);
  assert.match(String(r.headers.get("content-type")), /yaml/);
  const y = YAML.parse(r.text);
  assert.equal(y.projects[0].defaultModel, j.projects[0].defaultModel);
  assert.deepEqual(y.benchSets, j.benchSets);
  assert.ok(!r.text.includes(SECRET));
  assert.equal((await api(s.base, "GET", "/config/export?format=xml", undefined, tokA)).status, 400);
  assert.equal((await api(s.base, "GET", "/config/export")).status, 401);
});

test("import merges by name, reports counts and skipped entries", async () => {
  const doc = {
    version: 1,
    settings: { systemPrompt: "imported", effort: "medium" },
    projects: [
      { name: "Research", systemPrompt: "Updated prompt", effort: "max", defaultModel: "Local LM::gemma" },
      { name: "Fresh", defaultModel: "Nobody::x", tools: ["web_search"], searchMode: "auto" },
      { name: "Bad effort", effort: "turbo" },
    ],
    presets: [{ name: "Summarize", text: "New text" }, { name: "Translate", text: "Translate:" }],
    benchSets: [{ name: "Smoke", prompts: ["one"] }, { name: "Empty", prompts: [] }],
  };
  const r = await api(s.base, "POST", "/config/import", { format: "json", content: JSON.stringify(doc) }, tokA);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.updated, { projects: 1, presets: 1, benchSets: 1, settings: 2 });
  assert.deepEqual(r.json.created, { projects: 1, presets: 1, benchSets: 0 });
  assert.ok(r.json.skipped.some((x: string) => /Nobody::x/.test(x)), "unknown provider reported");
  assert.ok(r.json.skipped.some((x: string) => /Bad effort/.test(x)), "validation problem reported");
  assert.ok(r.json.skipped.some((x: string) => /benchSet "Empty"/.test(x)), "empty prompt set reported");

  const list = (await api(s.base, "GET", "/config/export?format=json", undefined, tokA)).json;
  const research = list.projects.find((p: any) => p.name === "Research");
  assert.equal(research.systemPrompt, "Updated prompt");
  assert.equal(research.effort, "max");
  assert.equal(research.defaultModel, "Local LM::gemma", "kept");
  assert.equal(list.projects.find((p: any) => p.name === "Fresh").searchMode, "auto");
  assert.equal(list.settings.systemPrompt, "imported");
  assert.equal(list.presets.length, 2);
  assert.equal(list.benchSets.length, 1);
  assert.equal(list.benchSets[0].prompts.length, 1);

  // a round trip of the export is a no-op with respect to creation
  const again = await api(s.base, "POST", "/config/import", { format: "json", content: JSON.stringify(list) }, tokA);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.created, { projects: 0, presets: 0, benchSets: 0 });
});

test("import yaml into another user resolves providers by name", async () => {
  const y = (await api(s.base, "GET", "/config/export?format=yaml", undefined, tokA)).text;
  const r = await api(s.base, "POST", "/config/import", { format: "yaml", content: y }, tokB);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.created.projects, 2, "Research and Fresh");
  const mine = (await api(s.base, "GET", "/config/export?format=json", undefined, tokB)).json;
  assert.equal(mine.projects[0].defaultModel, null, "user B has no provider called Local LM");
  assert.ok(r.json.skipped.some((x: string) => /Local LM::gemma|not found/.test(x)));
});

test("import refuses bad input", async () => {
  const post = (body: unknown) => api(s.base, "POST", "/config/import", body, tokA);
  assert.equal((await post({ format: "toml", content: "x" })).status, 400);
  assert.equal((await post({ format: "json", content: 5 })).status, 400);
  assert.equal((await post({ format: "json", content: "{nope" })).status, 400);
  assert.equal((await post({ format: "yaml", content: "a: [unclosed" })).status, 400);
  assert.equal((await post({ format: "json", content: "[1,2]" })).status, 400);
  assert.equal((await post({ format: "json", content: JSON.stringify({ version: 2 }) })).status, 400);
  assert.equal((await post({ format: "json", content: "{}", mode: "bogus" })).status, 400);
  assert.equal((await post({ format: "json", content: JSON.stringify({ projects: {} }) })).status, 400);
  assert.equal((await api(s.base, "POST", "/config/import", { format: "json", content: "{}" })).status, 401);
});

test("import is limited to 1 MB", async () => {
  const big = JSON.stringify({ presets: [{ name: "big", text: "x".repeat(1_100_000) }] });
  const r = await api(s.base, "POST", "/config/import", { format: "json", content: big }, tokA);
  assert.equal(r.status, 413);
});

test("replace mode removes what the file does not mention", async () => {
  const doc = { version: 1, projects: [{ name: "Only me" }] };
  const r = await api(s.base, "POST", "/config/import", { format: "json", content: JSON.stringify(doc), mode: "replace" }, tokA);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.created.projects, 1);
  assert.ok(r.json.removed.projects >= 2);
  const names = (await api(s.base, "GET", "/config/export?format=json", undefined, tokA)).json.projects.map((p: any) => p.name);
  assert.deepEqual(names, ["Only me"]);
});
