import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ModelCatalog, parseDefaultModel, parseModels, splitModelRef, writeModelOverlay } from "./models.js";
import { buildCommand } from "./dsh.js";
import { CORDIS, tmpDir } from "./testutil.js";

test("parseModels extracts only provider/id/name", () => {
  const models = parseModels(CORDIS);
  assert.deepEqual(models, [
    { provider: "opencodex", id: "lm-studio/lfm2.5-24b-a2b", name: "lfm (lm-studio)" },
    { provider: "opencodex", id: "gpt-5.5", name: "gpt-5.5 (native)" },
    { provider: "other", id: "m1", name: "m1" },
  ]);
  assert.ok(!JSON.stringify(models).includes("SECRET"));
  assert.deepEqual(parseModels("not: [valid"), []);
});

test("default model and modelRef helpers", () => {
  assert.equal(parseDefaultModel(fs.readFileSync(new URL("../dsh-overlay.yml", import.meta.url), "utf8")), "opencodex::lm-studio/lfm2.5-24b-a2b");
  assert.deepEqual(splitModelRef("a::b/c"), { provider: "a", id: "b/c" });
  assert.deepEqual(splitModelRef("plain"), { provider: null, id: "plain" });
});

test("per-run overlay content, cleanup, and --patch ordering", () => {
  const o = writeModelOverlay("opencodex::gpt-5.5");
  try {
    const doc = YAML.parse(fs.readFileSync(o.file, "utf8"));
    assert.deepEqual(doc, [{ id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: "opencodex", model: "gpt-5.5" } }]);
    const c = buildCommand({ appDir: "A", profile: "headless", patch: "user.yml", modelPatch: o.file, cwd: ".", prompt: "" });
    const idx = c.args.flatMap((a, i) => (a === "--patch" ? [c.args[i + 1]] : []));
    assert.deepEqual(idx, ["user.yml", o.file]);
  } finally {
    o.cleanup();
  }
  assert.equal(fs.existsSync(o.file), false);
  const bare = writeModelOverlay("only-id", "opencodex");
  assert.equal(YAML.parse(fs.readFileSync(bare.file, "utf8"))[0].config.provider, "opencodex");
  bare.cleanup();
});

test("ModelCatalog: detects mtime change, falls back to overlay default", () => {
  const dir = tmpDir();
  const file = path.join(dir, "cordis.patch.yml");
  const overlay = path.join(dir, "overlay.yml");
  fs.writeFileSync(overlay, "- id: agent-default-model\n  config:\n    provider: p\n    model: dflt\n");
  const cat = new ModelCatalog(file, overlay);
  assert.deepEqual(cat.models, [{ provider: "p", id: "dflt", name: "dflt" }]); // fallback
  assert.equal(cat.defaultModel, "p::dflt");
  cat.check();
  assert.equal(cat.check(), false);
  fs.writeFileSync(file, CORDIS);
  assert.equal(cat.check(), true);
  assert.equal(cat.models.length, 3);
  assert.equal(cat.providerFor("gpt-5.5"), "opencodex");
  assert.equal(cat.providerFor("unknown"), "p");
  fs.writeFileSync(file, CORDIS.replace("gpt-5.5\n", "gpt-5.6\n"));
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  assert.equal(cat.check(), true);
  assert.ok(cat.models.some((m) => m.id === "gpt-5.6"));
});
