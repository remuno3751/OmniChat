// Unit test of the Code diagnostic log (code-diag.ts): one JSON line per record, never throws, rotation above 1 MB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// config.ts reads DATA_DIR once at import, so the variable is set before the dynamic import
const dir = mkdtempSync(join(tmpdir(), "code-diag-test-"));
process.env.DATA_DIR = dir;
const { logCodeDiag } = await import("./code-diag.js");
const file = join(dir, "code-diag.log");
const rec = { conversationId: "c1", providerKind: "vscode-bridge", providerName: "VS", model: "p::m", tools: ["read_file", "list_dir"], cwd: "/work/app" };

test("appends one JSON line with an ISO timestamp and the record fields", () => {
  logCodeDiag(rec);
  logCodeDiag({ ...rec, conversationId: "c2", tools: [] });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.conversationId, "c1");
  assert.deepEqual(first.tools, ["read_file", "list_dir"]);
  assert.equal(first.cwd, "/work/app");
  assert.equal(new Date(first.ts).toISOString(), first.ts);
  assert.equal(JSON.parse(lines[1]).tools.length, 0);
});

test("a file over 1 MB keeps only its last half (cut at a line boundary) before the new line is added", () => {
  const pad = "y".repeat(200);
  const lines = Array.from({ length: 6000 }, (_, i) => JSON.stringify({ ts: "x", conversationId: `old${i}`, tools: [], pad }) + "\n");
  writeFileSync(file, lines.join(""), "utf8");
  assert.ok(Buffer.byteLength(lines.join("")) > 1024 * 1024);
  logCodeDiag({ ...rec, conversationId: "fresh" });
  const text = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(text) < 1024 * 1024, "smaller than 1 MB after rotation");
  const kept = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(kept.at(-1).conversationId, "fresh");
  const firstKept = Number(kept[0].conversationId.slice(3));
  assert.ok(firstKept > 2000, "the oldest records are dropped");
  assert.equal(kept[1].conversationId, `old${firstKept + 1}`, "kept records are whole, consecutive lines");
});

test("never throws when the log cannot be written", () => {
  rmSync(file, { force: true });
  mkdirSync(file); // a directory where the file should be: append fails
  try {
    assert.doesNotThrow(() => logCodeDiag(rec));
  } finally { rmSync(file, { recursive: true, force: true }); }
});
