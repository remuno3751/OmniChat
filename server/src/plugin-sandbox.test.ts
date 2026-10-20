import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

/* Stage 2 plugin isolation (docs/design/PLUGIN-INSTALL.md section 5). The registry is driven in this process with
 * PLUGIN_ISOLATION=process-all, so every plugin runs in a child Node process with --permission. Env is set before the
 * dynamic imports because config.ts and db.ts read it at import time. */

const tmp = mkdtempSync(join(tmpdir(), "omni-sandbox-"));
const CANARY_NAME = "OMNI_SANDBOX_CANARY";
const CANARY_VALUE = `canary-${randomUUID()}`;
Object.assign(process.env, {
  DATA_DIR: tmp, DB_PATH: join(tmp, "t.db"), PLUGINS_DIR: join(tmp, "plugins"),
  PLUGIN_ISOLATION: "process-all", AUTO_TITLE_DEFAULT: "0", [CANARY_NAME]: CANARY_VALUE,
});
delete process.env.PLUGIN_FETCH_ALLOW_PRIVATE;

const PLUGIN = "sandbox-probe";
const pluginDir = join(tmp, "plugins", PLUGIN);
const outsideFile = join(tmp, "secret.txt");
const insideFile = join(pluginDir, "data.txt");

const manifest = {
  id: PLUGIN, name: "Sandbox probe", version: "1.0.0", description: "isolation test plugin", main: "index.mjs",
  tools: [
    { name: "echo", description: "echo", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "readf", description: "read", parameters: { type: "object", properties: {} }, permissions: ["filesystem-read"] },
    { name: "writef", description: "write", parameters: { type: "object", properties: {} }, permissions: ["filesystem-write"] },
    { name: "spawnp", description: "spawn", parameters: { type: "object", properties: {} }, permissions: ["shell"] },
    { name: "envv", description: "env", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "nonet", description: "no network declared", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "fetchu", description: "fetch", parameters: { type: "object", properties: {} }, permissions: ["network"] },
    { name: "directnet", description: "direct net", parameters: { type: "object", properties: {} }, permissions: ["network"] },
    { name: "slow", description: "never answers", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "crash", description: "exits the process", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "big", description: "huge result", parameters: { type: "object", properties: {} }, permissions: [] },
    { name: "boom", description: "throws", parameters: { type: "object", properties: {} }, permissions: [] },
  ],
};

const moduleSrc = `
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import net from "node:net";
const code = (e) => "ERR:" + (e && e.code ? e.code : e && e.message);
export const tools = {
  async echo(args) { return "echo:" + (args && args.text); },
  async readf(args) { try { return "read:" + readFileSync(args.path, "utf8").trim(); } catch (e) { return code(e); } },
  async writef(args) { try { writeFileSync(args.path, "x"); return "wrote"; } catch (e) { return code(e); } },
  async spawnp() { try { return "spawned:" + spawnSync(process.execPath, ["-e", "1"]).status; } catch (e) { return code(e); } },
  async envv(args) { return "env:" + (process.env[args.name] ?? "unset"); },
  async nonet(args, ctx) { return "fetch:" + typeof ctx.fetch; },
  async fetchu(args, ctx) {
    try { const r = await ctx.fetch(args.url); return "status:" + r.status + ":" + (await r.text()); } catch (e) { return "fetch-error:" + e.message; }
  },
  async directnet(args) {
    return await new Promise((res) => {
      const s = net.connect(Number(args.port), "127.0.0.1", () => { s.destroy(); res("direct-connected"); });
      s.on("error", (e) => res("direct-error:" + e.code));
    });
  },
  async slow() { await new Promise(() => {}); },
  async crash() { process.exit(7); },
  async big() { return "x".repeat(20000); },
  async boom() { throw new Error("kaboom"); },
};
`;

let registry: typeof import("./tools/registry.js");
let sandbox: typeof import("./plugin-sandbox.js");
let local: Server;
let localPort = 0;

const run = (name: string, args: unknown = {}, timeoutMs?: number) =>
  registry.runTool(name, args, { userId: "u1", signal: new AbortController().signal, turn: { sources: [] }, ...(timeoutMs ? { timeoutMs } : {}) });

before(async () => {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(pluginDir, "index.mjs"), moduleSrc);
  writeFileSync(insideFile, "inside-data");
  writeFileSync(outsideFile, "outside-secret");
  local = createServer((req, res) => {
    if (req.url === "/redir") { res.writeHead(302, { location: `http://127.0.0.1:${localPort}/target` }); res.end(); return; }
    if (req.url === "/to-metadata") { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); return; }
    res.end("local-ok");
  });
  await new Promise<void>((r) => local.listen(0, "127.0.0.1", () => r()));
  localPort = (local.address() as { port: number }).port;
  registry = await import("./tools/registry.js");
  sandbox = await import("./plugin-sandbox.js");
  await registry.reloadPlugins();
});

after(async () => {
  sandbox?.stopPluginHosts("test end");
  local?.close();
  // a killed child can keep its folder open for a moment on Windows
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* best effort on Windows */ }
});

test("the plugin is listed as process-isolated and available", () => {
  const t = registry.listTools().find((x) => x.name === "echo");
  assert.ok(t, "echo tool registered");
  assert.equal(t.isolation, "process");
  assert.equal(t.available, true, t.error);
});

test("normal tool call returns its result through the child process", async () => {
  assert.equal(await run("echo", { text: "hi" }), "echo:hi");
});

test("a read outside the plugin folder is denied; a read inside it works", async () => {
  assert.equal(await run("readf", { path: outsideFile }), "ERR:ERR_ACCESS_DENIED");
  assert.equal(await run("readf", { path: insideFile }), "read:inside-data");
});

test("writes are denied, both outside and inside the plugin folder", async () => {
  assert.equal(await run("writef", { path: join(tmp, "written-outside.txt") }), "ERR:ERR_ACCESS_DENIED");
  assert.equal(await run("writef", { path: join(pluginDir, "written-inside.txt") }), "ERR:ERR_ACCESS_DENIED");
  assert.equal(existsSync(join(tmp, "written-outside.txt")), false);
});

test("child processes cannot be spawned", async () => {
  assert.equal(await run("spawnp"), "ERR:ERR_ACCESS_DENIED");
});

test("server environment variables are not visible to the plugin", async () => {
  assert.equal(await run("envv", { name: CANARY_NAME }), "env:unset");
});

test("ctx.fetch is only provided to tools that declare network", async () => {
  assert.equal(await run("nonet"), "fetch:undefined");
});

test("ctx.fetch to loopback is refused by the proxy", async () => {
  const out = await run("fetchu", { url: `http://127.0.0.1:${localPort}/` });
  assert.match(out, /^fetch-error:ctx\.fetch: address 127\.0\.0\.1 is not allowed/);
});

test("ctx.fetch to a metadata address is refused, also after a redirect", async () => {
  process.env.PLUGIN_FETCH_ALLOW_PRIVATE = "1";
  try {
    // the local server redirects to the metadata address: the hop is re-checked and refused
    const out = await run("fetchu", { url: `http://127.0.0.1:${localPort}/to-metadata` });
    assert.match(out, /fetch-error:ctx\.fetch: address 169\.254\.169\.254 is not allowed/);
  } finally { delete process.env.PLUGIN_FETCH_ALLOW_PRIVATE; }
});

test("test-only PLUGIN_FETCH_ALLOW_PRIVATE=1 lets ctx.fetch reach a local target and follow a local redirect", async () => {
  process.env.PLUGIN_FETCH_ALLOW_PRIVATE = "1";
  try {
    assert.equal(await run("fetchu", { url: `http://127.0.0.1:${localPort}/` }), "status:200:local-ok");
    assert.equal(await run("fetchu", { url: `http://127.0.0.1:${localPort}/redir` }), "status:200:local-ok");
  } finally { delete process.env.PLUGIN_FETCH_ALLOW_PRIVATE; }
});

test("ctx.fetch refuses non-http schemes", async () => {
  const out = await run("fetchu", { url: "file:///etc/hosts" });
  assert.match(out, /fetch-error:ctx\.fetch: only http and https/);
});

test("KNOWN LIMITATION: direct net connections are NOT blocked by --permission on this Node version", async () => {
  // documented in docs/design/PLUGIN-INSTALL.md section 5 (measured). If this starts failing, Node enforces network
  // now: update the docs and the UI warning.
  const http = createServer((_q, r) => r.end("x"));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (http.address() as { port: number }).port;
    assert.equal(await run("directnet", { port }), "direct-connected");
  } finally { http.close(); }
});

test("a call that never answers is cut off by the timeout and its child is killed", async () => {
  const before0 = sandbox.pluginHostStats(PLUGIN).spawns;
  const t0 = Date.now();
  await assert.rejects(run("slow", {}, 800), /timed out after 800 ms/);
  assert.ok(Date.now() - t0 < 4000, "returned promptly");
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(sandbox.pluginHostStats(PLUGIN).running, false, "child killed after the grace period");
  assert.equal(await run("echo", { text: "after-timeout" }), "echo:after-timeout");
  assert.equal(sandbox.pluginHostStats(PLUGIN).spawns, before0 + 1, "a new child started for the next call");
});

test("a crashing plugin fails its call and the next call restarts the child", async () => {
  const before0 = sandbox.pluginHostStats(PLUGIN).spawns;
  await assert.rejects(run("crash"), /plugin process exited/);
  assert.equal(await run("echo", { text: "after-crash" }), "echo:after-crash");
  assert.equal(sandbox.pluginHostStats(PLUGIN).spawns, before0 + 1);
});

test("a thrown error comes back as a tool error with its message", async () => {
  await assert.rejects(run("boom"), /kaboom/);
});

test("results are capped at the tool result limit", async () => {
  const out = await run("big");
  assert.ok(Buffer.byteLength(out, "utf8") <= 8 * 1024, `length ${Buffer.byteLength(out, "utf8")}`);
  assert.match(out, /\[truncated\]$/);
});

test("aborting a call stops it and frees the plugin for later calls", async () => {
  const ac = new AbortController();
  const p = registry.runTool("slow", {}, { userId: "u1", signal: ac.signal, turn: { sources: [] } });
  setTimeout(() => ac.abort(new Error("user stop")), 100);
  await assert.rejects(p);
  // the call ignores its abort, so its child is killed after the grace period (calls in flight on it fail too)
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(await run("echo", { text: "after-abort" }), "echo:after-abort");
});

test("reload stops every plugin child", async () => {
  await run("echo", { text: "warm" });
  assert.equal(sandbox.pluginHostStats(PLUGIN).running, true);
  await registry.reloadPlugins();
  assert.equal(sandbox.pluginHostStats(PLUGIN).running, false);
});

test("isolation mode is chosen by PLUGIN_ISOLATION and the install state", () => {
  const prev = process.env.PLUGIN_ISOLATION;
  try {
    process.env.PLUGIN_ISOLATION = "inproc";
    assert.equal(sandbox.isolationFor(true), "inproc");
    process.env.PLUGIN_ISOLATION = "process";
    assert.equal(sandbox.isolationFor(true), "process");
    assert.equal(sandbox.isolationFor(false), "inproc");
    process.env.PLUGIN_ISOLATION = "process-all";
    assert.equal(sandbox.isolationFor(false), "process");
  } finally {
    if (prev === undefined) delete process.env.PLUGIN_ISOLATION; else process.env.PLUGIN_ISOLATION = prev;
  }
});

test("address block list: private, loopback, link-local, metadata and IPv6 equivalents are refused", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:7f00:0001::", "[::1]", "fe80::1%eth0",
  ];
  for (const a of blocked) assert.equal(sandbox.isBlockedAddress(a), true, a);
  const allowed = ["93.184.216.34", "8.8.8.8", "2606:4700:10::6814:179a", "2001:4860:4860::8888", "::ffff:8.8.8.8"];
  for (const a of allowed) assert.equal(sandbox.isBlockedAddress(a), false, a);
});
