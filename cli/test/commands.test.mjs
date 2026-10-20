// history, show, search, export, bench run, config export/import (child process against the fake server).
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startFakeServer } from "./helpers/fake-server.mjs";
import { makeHome, runCli, writeConfig, runInProcess, startInProcess, readConfig } from "./helpers/cli.mjs";

const waitFor = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("history / show / search / export", () => {
  let srv;
  let h;
  let base;
  let convId;
  before(async () => {
    srv = await startFakeServer();
    h = makeHome();
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    base = { configPath: h.configPath, home: h.home };
    const r = await runCli(["chat", "tell me about zebras", "--json"], base);
    assert.equal(r.code, 0, r.stderr);
    convId = JSON.parse(r.stdout).conversationId;
    const r2 = await runCli(["chat", "and about giraffes", "--conv", convId], base);
    assert.equal(r2.code, 0, r2.stderr);
  });
  after(async () => { await srv.close(); });

  test("history lists conversations with id, date and title", async () => {
    const r = await runCli(["history"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(convId), r.stdout);
    assert.match(r.stdout, /New chat/);
  });

  test("history --json and --project filter", async () => {
    const j = await runCli(["history", "--json", "--limit", "5"], base);
    assert.ok(JSON.parse(j.stdout).conversations.some((c) => c.id === convId));
    const bad = await runCli(["history", "--project", "nope"], base);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /project "nope" not found/);
  });

  test("show prints the current branch with an id prefix", async () => {
    const r = await runCli(["show", convId.slice(0, 8)], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /You:\n\ntell me about zebras|You:\ntell me about zebras/);
    assert.match(r.stdout, /Assistant:\n[\s\S]*You said: tell me about zebras/);
    assert.match(r.stdout, /You said: and about giraffes/);
  });

  test("show with an unknown id is an error", async () => {
    const r = await runCli(["show", "ffffffff-0000"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/);
  });

  test("search highlights matches (plain markers without colour) and reports the count", async () => {
    const r = await runCli(["search", "zebras"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /«zebras»/);
    assert.ok(r.stdout.includes(convId));
  });

  test("search with no matches says so; an empty query is a usage error", async () => {
    const none = await runCli(["search", "qqqxxxyyy"], base);
    assert.equal(none.code, 0);
    assert.match(none.stderr, /no matches/);
    const empty = await runCli(["search", "  "], base);
    assert.equal(empty.code, 2);
  });

  test("search --json passes the server response through", async () => {
    const r = await runCli(["search", "giraffes", "--json", "--limit", "3"], base);
    const j = JSON.parse(r.stdout);
    assert.ok(j.results.length >= 1);
    assert.ok(j.results[0].snippet.includes("\u0001giraffes\u0002"));
  });

  test("export as markdown to stdout", async () => {
    const r = await runCli(["export", convId], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^# New chat/);
    assert.match(r.stdout, /\*\*You:\*\* tell me about zebras/);
  });

  test("export --format json -o FILE writes the file and says so on stderr", async () => {
    const out = path.join(h.home, "conv.json");
    const r = await runCli(["export", convId, "--format", "json", "-o", out], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /wrote .*conv\.json/);
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).version, 1);
  });

  test("export infers json from a .json output name", async () => {
    const out = path.join(h.home, "inferred.json");
    const r = await runCli(["export", convId, "-o", out], base);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(JSON.parse(fs.readFileSync(out, "utf8")).conversations);
  });

  test("export of an unknown conversation exits 1; a bad format exits 2", async () => {
    const r = await runCli(["export", "00000000-0000-4000-8000-000000000000"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not found/);
    const bad = await runCli(["export", convId, "--format", "pdf"], base);
    assert.equal(bad.code, 2);
  });
});

describe("bench run", () => {
  let srv;
  let h;
  let base;
  beforeEach(async () => {
    srv = await startFakeServer({ benchFinishAfter: 2 });
    h = makeHome();
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    base = { configPath: h.configPath, home: h.home, env: { OMNICHAT_BENCH_POLL_MS: "10" } };
  });
  afterEach(async () => { if (srv) await srv.close(); srv = null; });

  test("runs a set against two targets and prints the summary table", async () => {
    const r = await runCli(["bench", "run", "smoke", "--targets", "LM Studio/google/gemma-4-e4b,Ollama/llama3", "--repeats", "2"], base);
    assert.equal(r.code, 0, r.stderr);
    const post = srv.state.log.find((e) => e.method === "POST" && e.url === "/bench/runs");
    assert.equal(post.body.setId, "set-1");
    assert.deepEqual(post.body.targets, [{ providerId: "prov-lm", model: "google/gemma-4-e4b" }, { providerId: "prov-ol", model: "llama3" }]);
    assert.equal(post.body.repeats, 2);
    assert.equal(post.body.warmup, true);
    assert.match(r.stdout, /TARGET\s+N\s+TTFT ms/);
    assert.match(r.stdout, /LM Studio\/google\/gemma-4-e4b\s+4\s+120/);
    assert.match(r.stdout, /Ollama\/llama3\s+4\s+120/);
    assert.match(r.stdout, /status: done/);
  });

  test("--no-warmup and --max-tokens are sent", async () => {
    const r = await runCli(["bench", "run", "smoke", "--targets", "Ollama/llama3", "--no-warmup", "--max-tokens", "64"], base);
    assert.equal(r.code, 0, r.stderr);
    const post = srv.state.log.find((e) => e.method === "POST" && e.url === "/bench/runs");
    assert.equal(post.body.warmup, false);
    assert.equal(post.body.maxTokens, 64);
  });

  test("--json prints the run object", async () => {
    const r = await runCli(["bench", "run", "smoke", "--targets", "Ollama/llama3", "--json"], base);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "done");
    assert.equal(j.summary[0].model, "llama3");
  });

  test("a failed run exits 1 with the server error", async () => {
    await srv.close();
    srv = await startFakeServer({ benchFinishAfter: 1, benchFail: true });
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    const r = await runCli(["bench", "run", "smoke", "--targets", "Ollama/llama3"], { ...base });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /benchmark run failed: backend unreachable/);
  });

  test("unknown set lists the available sets; ambiguous target is an error", async () => {
    const r = await runCli(["bench", "run", "nope", "--targets", "Ollama/llama3"], base);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /prompt set "nope" not found[\s\S]*smoke \(set-1\)/);
    const amb = await runCli(["bench", "run", "smoke", "--targets", "google/gemma-4-e4b"], base);
    assert.equal(amb.code, 1);
    assert.match(amb.stderr, /ambiguous/);
  });

  test("usage errors: missing --targets, repeats out of range, bad subcommand", async () => {
    assert.equal((await runCli(["bench", "run", "smoke"], base)).code, 2);
    assert.equal((await runCli(["bench", "run", "smoke", "--targets", "Ollama/llama3", "--repeats", "9"], base)).code, 2);
    assert.equal((await runCli(["bench", "list"], base)).code, 2);
  });

  test("Ctrl+C cancels the run on the server and exits 130", async () => {
    await srv.close();
    srv = await startFakeServer({ benchFinishAfter: 1000 });
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    const handle = startInProcess(["bench", "run", "smoke", "--targets", "Ollama/llama3", "--repeats", "5"], {
      configPath: h.configPath, home: h.home, env: { OMNICHAT_BENCH_POLL_MS: "20" },
    });
    await waitFor(() => srv.state.benchRuns.size === 1);
    await waitFor(() => [...srv.state.benchRuns.values()][0].polls >= 2);
    handle.fireSigint();
    const r = await handle.done;
    assert.equal(r.code, 130, r.stderr);
    assert.ok(srv.state.log.some((e) => e.method === "POST" && /\/cancel$/.test(e.url)));
    assert.equal([...srv.state.benchRuns.values()][0].status, "cancelled");
  });
});

describe("config export / import", () => {
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

  test("export to stdout is JSON; to a file it is written with mode 0600", async () => {
    const r = await runCli(["config", "export"], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).version, 1);
    const file = path.join(h.home, "out", "backup.json");
    const f = await runCli(["config", "export", file], base);
    assert.equal(f.code, 0, f.stderr);
    assert.match(f.stderr, /wrote/);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).settings.systemPrompt, "Be brief.");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  test("export as yaml (by extension or --format)", async () => {
    const file = path.join(h.home, "cfg.yaml");
    const r = await runCli(["config", "export", file], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(fs.readFileSync(file, "utf8"), /^version: 1/);
    const s = await runCli(["config", "export", "--format", "yaml"], base);
    assert.match(s.stdout, /systemPrompt: Be brief\./);
  });

  test("import from a file (merge by default, replace on request) and show counts", async () => {
    const file = path.join(h.home, "in.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [], settings: {} }));
    const r = await runCli(["config", "import", file], base);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /imported .*\(merge\): created projects 1, presets 0, benchSets 1; updated settings 1/);
    assert.equal(srv.state.lastImport.mode, "merge");
    assert.equal(srv.state.lastImport.format, "json");
    const rep = await runCli(["config", "import", file, "--mode", "replace"], base);
    assert.equal(rep.code, 0, rep.stderr);
    assert.equal(srv.state.lastImport.mode, "replace");
  });

  test("import from stdin and reports skipped entries", async () => {
    const input = JSON.stringify({ version: 1, presets: [{ name: "bad-preset", text: "" }] });
    const r = await runCli(["config", "import", "-"], { ...base, input });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /skipped: preset bad-preset: text is required/);
    const piped = await runCli(["config", "import"], { ...base, input: "{}" });
    assert.equal(piped.code, 0, piped.stderr);
  });

  test("yaml import sends format yaml; invalid JSON is rejected by the server (exit 1)", async () => {
    const file = path.join(h.home, "in.yml");
    fs.writeFileSync(file, "version: 1\n");
    const r = await runCli(["config", "import", file], base);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.state.lastImport.format, "yaml");
    const bad = path.join(h.home, "bad.json");
    fs.writeFileSync(bad, "{not json");
    const e = await runCli(["config", "import", bad], base);
    assert.equal(e.code, 1);
    assert.match(e.stderr, /not valid JSON/);
  });

  test("missing file, bad mode and bad subcommand", async () => {
    assert.equal((await runCli(["config", "import", path.join(h.home, "nope.json")], base)).code, 1);
    assert.equal((await runCli(["config", "import", "x.json", "--mode", "zap"], base)).code, 2);
    assert.equal((await runCli(["config", "frob"], base)).code, 2);
  });

  test("the saved config file is not modified by config commands", async () => {
    const before = readConfig(h.configPath);
    await runCli(["config", "export"], base);
    assert.deepEqual(readConfig(h.configPath), before);
  });
});

test("in-process: help, version and unknown commands", async () => {
  const h = makeHome();
  const help = await runInProcess(["--help"], { configPath: h.configPath, home: h.home });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Exit codes: 0 ok, 1 error, 2 usage error, 130 interrupted/);
  const v = await runInProcess(["--version"], { configPath: h.configPath, home: h.home });
  assert.match(v.stdout, /omnichat-cli 0\.1\.0/);
  const u = await runInProcess(["frobnicate"], { configPath: h.configPath, home: h.home });
  assert.equal(u.code, 2);
  assert.match(u.stderr, /unknown command: frobnicate/);
});
