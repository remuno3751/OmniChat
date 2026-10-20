// Static scanner for plugin source (docs/PROTOCOL-v7-plugins.md): pure functions, no server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPlugin, summarizeFindings, isScannedFile } from "./plugin-scan.js";

const scan = (text: string, tools: { name: string; permissions: string[] }[] = [{ name: "t", permissions: [] }], path = "index.mjs") =>
  scanPlugin({ files: [{ path, text }], tools });
const rules = (r: ReturnType<typeof scanPlugin>) => r.findings.map((f) => f.rule);

test("child_process is high and the shell permission is reported as a mismatch", () => {
  const r = scan(`import { exec } from "node:child_process";\nexec("ls");`);
  const f = r.findings.find((x) => x.rule === "child_process");
  assert.ok(f);
  assert.equal(f.severity, "high");
  assert.equal(f.file, "index.mjs");
  assert.equal(f.line, 1);
  assert.deepEqual(r.permissionMismatch, [{ tool: "t", used: ["shell"], declared: [] }]);
});

test("no mismatch when a tool declares the permission the code uses", () => {
  const r = scan(`import { exec } from "child_process";\nexec("ls");`, [{ name: "t", permissions: ["shell"] }]);
  assert.equal(r.findings.some((x) => x.rule === "child_process"), true);
  assert.deepEqual(r.permissionMismatch, []);
});

test("write calls are fs_write (high); a read-only fs import is fs_read (info)", () => {
  const w = scan(`import { writeFileSync } from "node:fs";\nwriteFileSync("a", "b");`);
  assert.ok(w.findings.some((x) => x.rule === "fs_write" && x.severity === "high"));
  const r = scan(`import { readFileSync } from "node:fs";\nreadFileSync("a");`);
  const f = r.findings.find((x) => x.rule === "fs_read");
  assert.ok(f);
  assert.equal(f.severity, "info");
  assert.ok(r.permissionMismatch.some((m) => m.used.includes("filesystem-read"))); // read used, no tool declares it
});

test("process.env is env_access (high)", () => {
  const r = scan(`const k = process.env.SECRET;`);
  assert.ok(r.findings.some((x) => x.rule === "env_access" && x.severity === "high"));
});

test("eval and new Function are high", () => {
  assert.ok(rules(scan(`eval("1+1");`)).includes("eval"));
  assert.ok(rules(scan(`const f = new Function("return 1");`)).includes("eval"));
});

test("dynamic import with a non-literal is medium; a string literal is not flagged", () => {
  const bad = scan(`const m = await import(name);`);
  assert.ok(bad.findings.some((x) => x.rule === "dynamic_import" && x.severity === "medium"));
  const literal = scan(`const m = await import("./lib/x.mjs");`);
  assert.equal(rules(literal).includes("dynamic_import"), false);
  const tmpl = scan("const m = await import(`./lib/x.mjs`);");
  assert.equal(rules(tmpl).includes("dynamic_import"), false);
});

test("raw network modules are medium, and the network permission is then expected", () => {
  const r = scan(`import http from "node:http";\nhttp.get("x");`);
  assert.ok(r.findings.some((x) => x.rule === "raw_network" && x.severity === "medium"));
  assert.ok(r.permissionMismatch.some((m) => m.used.includes("network")));
});

test("fetch without a tool declaring network is undeclared_network (high) on each call line", () => {
  const r = scan(`export const tools = { t: async () => (await fetch("https://x")).text() };`);
  const f = r.findings.find((x) => x.rule === "undeclared_network");
  assert.ok(f);
  assert.equal(f.severity, "high");
  assert.ok(r.permissionMismatch.some((m) => m.used.includes("network")));
});

test("fetch with a tool declaring network: no undeclared_network and no mismatch", () => {
  const r = scan(`const x = await fetch("https://x");`, [{ name: "t", permissions: ["network"] }]);
  assert.equal(rules(r).includes("undeclared_network"), false);
  assert.deepEqual(r.permissionMismatch, []);
});

test("obfuscation: a line over 2000 characters, a run of \\x escapes, and atob with eval", () => {
  const long = scan("x".repeat(2001));
  assert.ok(long.findings.some((x) => x.rule === "obfuscation" && x.severity === "medium"));
  const hex = scan("const s = \"" + "\\x41".repeat(20) + "\";");
  assert.ok(hex.findings.some((x) => x.rule === "obfuscation"));
  const decode = scan(`eval(atob("YQ=="));`);
  assert.ok(decode.findings.some((x) => x.rule === "obfuscation"));
});

test("only JavaScript-like files are scanned; other files are ignored", () => {
  const r = scanPlugin({ files: [{ path: "README.md", text: "process.env and eval(" }, { path: "data.json", text: "child_process" }], tools: [] });
  assert.deepEqual(r.findings, []);
  assert.equal(isScannedFile("lib/a.mjs"), true);
  assert.equal(isScannedFile("a.json"), false);
});

test("snippets are trimmed and clipped to 200 characters", () => {
  const r = scan("   eval(" + "a".repeat(400) + ");");
  const f = r.findings.find((x) => x.rule === "eval");
  assert.ok(f);
  assert.ok(f.snippet.length <= 201);
  assert.ok(!f.snippet.startsWith(" "));
});

test("summarizeFindings counts per severity", () => {
  const s = summarizeFindings([{ severity: "high" }, { severity: "high" }, { severity: "medium" }, { severity: "info" }]);
  assert.deepEqual(s, { high: 2, medium: 1, info: 1 });
});
