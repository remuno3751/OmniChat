import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../src/args.mjs";
import { configPath, loadConfig, saveConfig } from "../src/config.mjs";
import { resolveModel } from "../src/commands/models.mjs";
import { branchPath } from "../src/commands/sync.mjs";
import { renderSummary } from "../src/commands/bench.mjs";
import { makeRedactor, redactObject, UsageError, CliError, oneOf } from "../src/util.mjs";
import { normalizeServer } from "../src/client.mjs";
import { makeHome } from "./helpers/cli.mjs";

test("parseArgs: flags, aliases, positionals, '-' and '--'", () => {
  const { flags, positionals } = parseArgs(["chat", "-m", "lab/x", "--conv=abc", "--thinking", "-", "--", "--literal"], undefined);
  assert.equal(flags.model, "lab/x");
  assert.equal(flags.conv, "abc");
  assert.equal(flags.thinking, true);
  assert.deepEqual(positionals, ["chat", "-", "--literal"]);
});

test("parseArgs: integers and missing values are usage errors", () => {
  assert.equal(parseArgs(["--limit", "5"]).flags.limit, 5);
  assert.throws(() => parseArgs(["--limit", "0"]), UsageError);
  assert.throws(() => parseArgs(["--limit", "abc"]), UsageError);
  assert.throws(() => parseArgs(["--model"]), UsageError);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--json=1"]), /does not take a value/);
});

test("parseArgs: negative-looking values and option values starting with dash", () => {
  const { flags } = parseArgs(["--system", "-5 is fine"]);
  assert.equal(flags.system, "-5 is fine");
});

test("oneOf validates enum-like flags with a usage error", () => {
  assert.equal(oneOf("md", ["md", "json"], "format"), "md");
  assert.equal(oneOf(undefined, ["md"], "format"), undefined);
  assert.throws(() => oneOf("pdf", ["md", "json"], "format"), /must be one of: md, json/);
});

test("redactor removes secrets, bearer headers, token query params and key-looking strings", () => {
  const secrets = new Set(["supersecretpassword"]);
  const redact = makeRedactor(secrets);
  const out = redact(
    "pw supersecretpassword; Bearer abc.def; ws://h/ws?token=tok_123abc&x=1; key ocsk-AbC_123; " +
      "hash " + "a".repeat(64),
  );
  assert.ok(!out.includes("supersecretpassword"));
  assert.ok(!out.includes("abc.def"));
  assert.ok(!out.includes("tok_123abc"));
  assert.ok(!out.includes("AbC_123"));
  assert.ok(!out.includes("a".repeat(64)));
  assert.match(out, /token=\*\*\*/);
});

test("redactor ignores very short secrets (avoids mangling output)", () => {
  const redact = makeRedactor(new Set(["ab"]));
  assert.equal(redact("abc"), "abc");
});

test("redactObject masks password/token/apiKey fields recursively", () => {
  const r = redactObject({ username: "u", password: "p", nested: [{ token: "t", apiKey: "k", ok: 1 }] });
  assert.deepEqual(r, { username: "u", password: "***", nested: [{ token: "***", apiKey: "***", ok: 1 }] });
});

test("configPath: Windows uses APPDATA, POSIX uses XDG_CONFIG_HOME or ~/.config", () => {
  assert.equal(configPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32"), path.join("C:\\Users\\x\\AppData\\Roaming", "omnichat", "config.json"));
  assert.equal(configPath({ XDG_CONFIG_HOME: "/xdg" }, "linux"), path.join("/xdg", "omnichat", "config.json"));
  assert.equal(configPath({ HOME: "/home/u" }, "linux"), path.join("/home/u", ".config", "omnichat", "config.json"));
  assert.equal(configPath({ OMNICHAT_CONFIG: "/tmp/c.json" }, "linux"), "/tmp/c.json");
});

test("config round trip; file is 0600 where permissions are supported", () => {
  const { home } = makeHome();
  const file = path.join(home, "nested", "config.json");
  saveConfig(file, { server: "http://h:1", token: "tok_1", deviceId: "d" });
  assert.deepEqual(loadConfig(file), { server: "http://h:1", token: "tok_1", deviceId: "d" });
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], "no temp files left behind");
});

test("loadConfig: missing file is empty; invalid JSON is a readable error", () => {
  const { home } = makeHome();
  assert.deepEqual(loadConfig(path.join(home, "none.json")), {});
  const bad = path.join(home, "bad.json");
  fs.writeFileSync(bad, "{nope");
  assert.throws(() => loadConfig(bad), (e) => e instanceof CliError && /not valid JSON/.test(e.message));
});

test("normalizeServer adds http:// and strips trailing slashes", () => {
  assert.equal(normalizeServer("localhost:8787/"), "http://localhost:8787");
  assert.equal(normalizeServer("https://x.example.com///"), "https://x.example.com");
  assert.equal(normalizeServer(""), "");
});

const GROUPS = [
  { providerId: "p1", providerName: "LM Studio", models: [{ id: "google/gemma-4-e4b" }, { id: "qwen/qwen3-8b" }] },
  { providerId: "p2", providerName: "Lab", models: [{ id: "google/gemma-4-e4b" }] },
  { providerId: "p3", providerName: "Ollama", models: [{ id: "llama3" }] },
];

test("resolveModel: full <providerName>/<modelId> wins, even when the model id has slashes", () => {
  const m = resolveModel("LM Studio/google/gemma-4-e4b", GROUPS);
  assert.equal(m.providerId, "p1");
  assert.equal(m.providerName, "LM Studio");
  assert.equal(m.model, "google/gemma-4-e4b");
});

test("resolveModel: provider slug and case-insensitive names", () => {
  assert.equal(resolveModel("lm-studio/qwen/qwen3-8b", GROUPS).providerId, "p1");
  assert.equal(resolveModel("ollama/llama3", GROUPS).providerId, "p3");
});

test("resolveModel: a bare model id shared by two providers is ambiguous and lists candidates", () => {
  assert.throws(() => resolveModel("google/gemma-4-e4b", GROUPS), (e) => {
    assert.match(e.message, /ambiguous/);
    assert.match(e.message, /LM Studio\/google\/gemma-4-e4b/);
    assert.match(e.message, /Lab\/google\/gemma-4-e4b/);
    return true;
  });
});

test("resolveModel: unknown model lists available models; no models at all is explained", () => {
  assert.throws(() => resolveModel("nope", GROUPS), /not found[\s\S]*Ollama\/llama3/);
  assert.throws(() => resolveModel("x", []), /no models available/);
});

test("branchPath follows headId back to the root", () => {
  const msgs = [
    { id: "a", conversationId: "c", parentId: null, createdAt: 1 },
    { id: "b", conversationId: "c", parentId: "a", createdAt: 2 },
    { id: "b2", conversationId: "c", parentId: "a", createdAt: 3 },
    { id: "c1", conversationId: "c", parentId: "b2", createdAt: 4 },
    { id: "x", conversationId: "other", parentId: null, createdAt: 5 },
  ];
  const sync = { messages: msgs };
  assert.deepEqual(branchPath(sync, { id: "c", headId: "c1" }).map((m) => m.id), ["a", "b2", "c1"]);
  assert.deepEqual(branchPath(sync, { id: "c", headId: null }).map((m) => m.id), ["a", "b", "b2", "c1"]);
});

test("renderSummary prints a table with one row per target", () => {
  const run = {
    id: "r1", setName: "smoke", status: "done",
    summary: [
      { targetIndex: 0, providerName: "LM Studio", model: "m", n: 2, avgTtftMs: 120.4, avgPrefillTps: 300, avgDecodeTps: 40.25, p50DecodeTps: 40, minDecodeTps: 38, maxDecodeTps: 42, errors: 0, estimatedShare: 0.5 },
    ],
  };
  const out = renderSummary(run, [{ label: "LM Studio/m" }]);
  assert.match(out, /status: done/);
  assert.match(out, /TARGET\s+N\s+TTFT ms/);
  assert.match(out, /LM Studio\/m\s+2\s+120\s+300\.0\s+40\.3/);
  assert.match(out, /50%/);
});
