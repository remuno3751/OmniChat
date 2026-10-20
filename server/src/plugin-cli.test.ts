// plugin:new / plugin:check (docs/PLUGINS.md "自作の手順"). Scaffolds into a temp folder, then checks good and bad plugins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlugin, scaffoldPlugin } from "../scripts/plugin-lib.mjs";

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omnichat-plugin-cli-"));
}

async function makePlugin(root: string, id: string, files: Record<string, string>): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body, "utf8");
  return dir;
}

const goodManifest = (id: string, tool = "hello_tool") => JSON.stringify({
  id, name: "Good", version: "1.0.0", description: "test", main: "index.mjs",
  tools: [{ name: tool, description: "d", parameters: { type: "object", properties: {} }, permissions: [] }],
});
const goodIndex = (tool = "hello_tool") => `export const tools = { async ${tool}(args, ctx) { ctx.log("ok"); return { ok: true }; } };\n`;

test("scaffold then check passes", async () => {
  const root = await tempRoot();
  try {
    const dir = await scaffoldPlugin("my-tool", root);
    for (const f of ["plugin.json", "index.mjs", "README.md"]) assert.ok(existsSync(join(dir, f)), `${f} missing`);
    const manifest = JSON.parse(await readFile(join(dir, "plugin.json"), "utf8"));
    assert.equal(manifest.id, "my-tool");
    assert.equal(manifest.tools[0].name, "my_tool_hello");

    const r = await checkPlugin(dir);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.tools, ["my_tool_hello"]);
    // the example tool runs with {} and should not fail
    assert.deepEqual(r.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scaffold keeps a long id within the tool name limit", async () => {
  const root = await tempRoot();
  try {
    const id = "a".repeat(39);
    const dir = await scaffoldPlugin(id, root);
    const r = await checkPlugin(dir);
    assert.deepEqual(r.errors, []);
    assert.equal(r.tools.length, 1);
    assert.ok(r.tools[0].length <= 40);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scaffold refuses an invalid id and an existing folder", async () => {
  const root = await tempRoot();
  try {
    await assert.rejects(scaffoldPlugin("Bad_ID", root), /must match/);
    await assert.rejects(scaffoldPlugin("-leading", root), /must match/);
    await scaffoldPlugin("twice", root);
    await assert.rejects(scaffoldPlugin("twice", root), /refusing to overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails on a manifest whose id differs from the folder name", async () => {
  const root = await tempRoot();
  try {
    const dir = await makePlugin(root, "folder-name", {
      "plugin.json": goodManifest("other-name"),
      "index.mjs": goodIndex(),
    });
    const r = await checkPlugin(dir);
    assert.ok(r.errors.some((e) => /must equal the directory name/.test(e)), JSON.stringify(r.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails on a manifest missing a required field", async () => {
  const root = await tempRoot();
  try {
    const bad = JSON.parse(goodManifest("no-version"));
    delete bad.version;
    const dir = await makePlugin(root, "no-version", {
      "plugin.json": JSON.stringify(bad),
      "index.mjs": goodIndex(),
    });
    const r = await checkPlugin(dir);
    assert.ok(r.errors.some((e) => /version must be a string/.test(e)), JSON.stringify(r.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails when a tool has no exported function", async () => {
  const root = await tempRoot();
  try {
    const dir = await makePlugin(root, "missing-fn", {
      "plugin.json": goodManifest("missing-fn", "wanted_tool"),
      "index.mjs": goodIndex("something_else"),
    });
    const r = await checkPlugin(dir);
    assert.ok(r.errors.some((e) => /does not export a function for tool "wanted_tool"/.test(e)), JSON.stringify(r.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails when package.json declares dependencies", async () => {
  const root = await tempRoot();
  try {
    const dir = await makePlugin(root, "has-deps", {
      "plugin.json": goodManifest("has-deps"),
      "index.mjs": goodIndex(),
      "package.json": JSON.stringify({ name: "x", dependencies: { lodash: "^4.0.0" } }),
    });
    const r = await checkPlugin(dir);
    assert.ok(r.errors.some((e) => /plugins with dependencies are refused/.test(e)), JSON.stringify(r.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check fails on too many files", async () => {
  const root = await tempRoot();
  try {
    const files: Record<string, string> = { "plugin.json": goodManifest("many-files"), "index.mjs": goodIndex() };
    const dir = await makePlugin(root, "many-files", files);
    for (let i = 0; i < 200; i++) await writeFile(join(dir, `extra-${i}.txt`), "x", "utf8");
    const r = await checkPlugin(dir);
    assert.ok(r.errors.some((e) => /too many files/.test(e)), JSON.stringify(r.errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a tool that throws on {} is a warning, not a failure", async () => {
  const root = await tempRoot();
  try {
    const dir = await makePlugin(root, "throws", {
      "plugin.json": goodManifest("throws"),
      "index.mjs": `export const tools = { async hello_tool(args) { if (!args.url) throw new Error("url required"); return 1; } };\n`,
    });
    const r = await checkPlugin(dir);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => /url required/.test(w)), JSON.stringify(r.warnings));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
