import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWLIST, decide, isAllowlisted, matchProtected, toolClass, type ApprovalMode } from "./vscode-policy.js";

interface Case {
  id: string; tool: string; args: Record<string, unknown>; roots: string[];
  fakeRealpath?: Record<string, string>; expected: { protected: boolean; rule?: string };
}
const cases = JSON.parse(
  readFileSync(new URL("../../vscode-ext/test/fixtures/protected-cases.json", import.meta.url), "utf8"),
) as Case[];

test("canonical protected cases (146)", () => {
  assert.equal(cases.length, 146);
  let skipped = 0;
  for (const c of cases) {
    // symlink escapes need realpath, which the server (lexical only) does not do; the extension enforces them
    if (c.fakeRealpath && c.expected.protected) { skipped++; continue; }
    const r = matchProtected(c.tool, c.args, c.roots);
    assert.equal(r.protected, c.expected.protected, c.id);
    assert.deepEqual(r.ids, c.expected.protected ? [c.expected.rule] : [], c.id);
  }
  assert.ok(skipped <= 8);
});

const R = ["/ws/proj"];
const none = { deny: [], allow: [] };
const SAMPLE: Record<string, Record<string, unknown>> = {
  read: { path: "src/a.ts" },
  edit: { path: "src/a.ts" },
  exec: { command: "make all" },
  gitwrite: { message: "x" },
};
const TOOL = { read: "read_file", edit: "write_file", exec: "run_command", gitwrite: "git_commit" } as const;

test("toolClass", () => {
  assert.equal(toolClass("grep"), "read");
  assert.equal(toolClass("edit_file"), "edit");
  assert.equal(toolClass("run_command"), "exec");
  assert.equal(toolClass("git_commit"), "gitwrite");
});

test("mode matrix", () => {
  const expected: Record<string, Record<ApprovalMode, string>> = {
    read: { manual: "allow", auto: "allow", full: "allow" },
    edit: { manual: "ask", auto: "allow", full: "allow" },
    exec: { manual: "ask", auto: "ask", full: "allow" },
    gitwrite: { manual: "ask", auto: "ask", full: "allow" },
  };
  for (const cls of Object.keys(expected)) {
    for (const mode of ["manual", "auto", "full"] as const) {
      const d = decide({ tool: TOOL[cls as keyof typeof TOOL], args: SAMPLE[cls], roots: R, mode, rules: none });
      assert.equal(d.action, expected[cls][mode], `${cls}/${mode}`);
      assert.equal(d.by, d.action === "allow" ? `mode:${mode}` : "default");
      assert.equal(d.protected, false);
    }
  }
  const d = decide({ tool: "run_command", args: { command: "npm test -- foo" }, roots: R, mode: "auto", rules: none });
  assert.equal(d.action, "allow");
});

test("protected is always ask, even in full mode, without always-allow", () => {
  for (const mode of ["manual", "auto", "full"] as const) {
    const d = decide({ tool: "run_command", args: { command: "git push" }, roots: R, mode, rules: none });
    assert.deepEqual([d.action, d.by, d.protected, d.alwaysAllowed], ["ask", "protected", true, false]);
    assert.ok(d.reasons.length > 0);
  }
  assert.equal(decide({ tool: "read_file", args: { path: ".env" }, roots: R, mode: "full", rules: none }).action, "ask");
});

test("evaluation order", () => {
  const rule = (id: string, kind: string, pattern: string) => ({ id, kind, pattern });
  const push = { command: "git push" };
  // deny beats protected
  let d = decide({ tool: "run_command", args: push, roots: R, mode: "full", rules: { deny: [rule("d1", "command", "git *")], allow: [] } });
  assert.deepEqual([d.action, d.by, d.protected], ["deny", "rule:d1", true]);
  // allow rule does not lower protected
  d = decide({ tool: "run_command", args: push, roots: R, mode: "full", rules: { deny: [], allow: [rule("a1", "tool", "run_command")] } });
  assert.deepEqual([d.action, d.by], ["ask", "protected"]);
  // allow rule beats mode
  d = decide({ tool: "run_command", args: { command: "make all" }, roots: R, mode: "manual", rules: { deny: [], allow: [rule("a2", "command", "make *")] } });
  assert.deepEqual([d.action, d.by], ["allow", "rule:a2"]);
  // deny beats allow
  d = decide({ tool: "write_file", args: { path: "src/a.ts" }, roots: R, mode: "full", rules: { deny: [rule("d2", "path", "src/*")], allow: [rule("a3", "tool", "write_file")] } });
  assert.deepEqual([d.action, d.by], ["deny", "rule:d2"]);
  // command allow rule never matches a command with shell metacharacters
  d = decide({ tool: "run_command", args: { command: "make a; make b" }, roots: R, mode: "manual", rules: { deny: [], allow: [rule("a4", "command", "make *")] } });
  assert.equal(d.action, "ask");
});

test("allowlist", () => {
  for (const a of ALLOWLIST) {
    assert.ok(isAllowlisted(a), a);
    assert.ok(isAllowlisted(`${a} --foo bar`), a);
    assert.ok(!isAllowlisted(`${a}x`), a);
  }
  assert.ok(isAllowlisted("npm test -- foo"));
  assert.ok(!isAllowlisted("npm testing"));
  assert.ok(!isAllowlisted("rm -rf x"));
  for (const meta of [";", "&", "|", "<", ">", "`x`", "$(x)", "${X}", "\n", "&&", "||"]) {
    assert.ok(!isAllowlisted(`npm test ${meta} echo`), JSON.stringify(meta));
  }
});
