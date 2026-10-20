import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeServer } from "./helpers/fake-server.mjs";
import { makeHome, runCli, writeConfig } from "./helpers/cli.mjs";

let srv;
let h;
let base;
before(async () => {
  srv = await startFakeServer();
  h = makeHome();
  writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
  base = { configPath: h.configPath, home: h.home };
});
after(async () => { await srv.close(); });

test("models lists every provider model as <providerName>/<modelId>", async () => {
  const r = await runCli(["models"], base);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^MODEL\s+INFO/);
  for (const line of ["LM Studio/google/gemma-4-e4b", "LM Studio/qwen/qwen3-8b", "Ollama/llama3", "Lab/google/gemma-4-e4b"]) {
    assert.ok(r.stdout.includes(line), `missing ${line}\n${r.stdout}`);
  }
});

test("models --provider filters by name (case-insensitive) and errors for unknown names", async () => {
  const r = await runCli(["models", "--provider", "ollama"], base);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("Ollama/llama3"));
  assert.ok(!r.stdout.includes("LM Studio"));
  const bad = await runCli(["models", "--provider", "nope"], base);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /no provider named "nope"/);
});

test("models --json prints the groups", async () => {
  const r = await runCli(["models", "--json"], base);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.groups.length, 3);
  assert.equal(j.groups[1].providerName, "Ollama");
});
