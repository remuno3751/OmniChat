import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Review 2026-10 (docs/SECURITY-AUDIT-2026-10.md, findings P-*): regression tests for plugin-sandbox.ts. Same in-process
 * setup as plugin-sandbox.test.ts (PLUGIN_ISOLATION=process-all, env set before the dynamic imports). */

const tmp = mkdtempSync(join(tmpdir(), "omni-sandbox-rev-"));
Object.assign(process.env, {
  DATA_DIR: tmp, DB_PATH: join(tmp, "t.db"), PLUGINS_DIR: join(tmp, "plugins"),
  PLUGIN_ISOLATION: "process-all", AUTO_TITLE_DEFAULT: "0",
});
delete process.env.PLUGIN_FETCH_ALLOW_PRIVATE;

const PLUGIN = "review-probe";
const pluginDir = join(tmp, "plugins", PLUGIN);
const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} }, permissions: [] });
const manifest = { id: PLUGIN, name: "Review probe", version: "1.0.0", description: "d", main: "index.mjs", tools: [tool("echo"), tool("slow")] };
const moduleSrc = `export const tools = {
  async echo(args) { return "echo:" + (args && args.text); },
  async slow() { await new Promise(() => {}); },
};\n`;

let registry: typeof import("./tools/registry.js");
let sandbox: typeof import("./plugin-sandbox.js");

const run = (name: string, args: unknown = {}, timeoutMs?: number) =>
  registry.runTool(name, args, { userId: "u1", signal: new AbortController().signal, turn: { sources: [] }, ...(timeoutMs ? { timeoutMs } : {}) });

before(async () => {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(pluginDir, "index.mjs"), moduleSrc);
  registry = await import("./tools/registry.js");
  sandbox = await import("./plugin-sandbox.js");
  await registry.reloadPlugins();
});

after(async () => {
  sandbox?.stopPluginHosts("test end");
  await new Promise((r) => setTimeout(r, 1500));
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* best effort */ }
});

test("P-1: a call right after a timed-out call killed the child is not failed by the old child's exit event", async () => {
  assert.equal(await run("echo", { text: "warm" }), "echo:warm");
  // a call that ignores its abort signal: runTool times out, the host kills the child after the grace period
  await assert.rejects(run("slow", {}, 200), /timed out/);
  const t0 = Date.now();
  while (sandbox.pluginHostStats(PLUGIN).running) {
    assert.ok(Date.now() - t0 < 5000, "the child should be killed after the grace period");
    await new Promise((r) => setTimeout(r, 1));
  }
  // the old child is dead (its exit event may still be on its way); the next call starts a new child and must succeed
  assert.equal(await run("echo", { text: "after-kill" }), "echo:after-kill");
});
