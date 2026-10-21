import { describe, expect, it } from "vitest";
import type { ToolCall, ToolName } from "../src/protocol/frames";
import type { Host } from "../src/host/types";
import { validateArgs } from "../src/tools/schemas";
import {
  createRegistry,
  toolError,
  ToolError,
  type ToolContext,
} from "../src/tools/index";
import { TOOL_RESULT_MAX_BYTES } from "../src/tools/limits";

const host = {} as Host;
const ctx: ToolContext = {
  host,
  root: "/ws",
  roots: ["/ws"],
  signal: new AbortController().signal,
  cwd: "/ws",
};

function call(tool: ToolName, args: Record<string, unknown>): ToolCall {
  return { runId: "r1", callId: "c1", tool, args, timeoutMs: 1000 };
}

describe("validateArgs: invalid_args per tool", () => {
  // [tool, args, substring expected in error]
  const cases: Array<[ToolName, Record<string, unknown>, string]> = [
    // read_file
    ["read_file", {}, "path"],
    ["read_file", { path: 1 }, "path"],
    ["read_file", { path: "a", limit: 5001 }, "limit"],
    ["read_file", { path: "a", limit: 0 }, "limit"],
    ["read_file", { path: "a", offset: 0 }, "offset"],
    // list_dir
    ["list_dir", { depth: 4 }, "depth"],
    ["list_dir", { depth: 0 }, "depth"],
    ["list_dir", { includeHidden: "yes" }, "includeHidden"],
    // glob
    ["glob", {}, "pattern"],
    ["glob", { pattern: "*", limit: 1001 }, "limit"],
    ["glob", { pattern: "*", limit: 1.5 }, "limit"],
    // grep
    ["grep", {}, "pattern"],
    ["grep", { pattern: "x", context: 6 }, "context"],
    ["grep", { pattern: "x", limit: 501 }, "limit"],
    ["grep", { pattern: "x", caseSensitive: 1 }, "caseSensitive"],
    // write_file
    ["write_file", { path: "a" }, "content"],
    ["write_file", { path: "a", content: 3 }, "content"],
    ["write_file", { content: "x" }, "path"],
    ["write_file", { path: "a", content: "x".repeat(1024 * 1024 + 1) }, "content"],
    // edit_file
    ["edit_file", { path: "a", newString: "b" }, "oldString"],
    ["edit_file", { path: "a", oldString: "", newString: "b" }, "oldString"],
    ["edit_file", { path: "a", oldString: "a" }, "newString"],
    ["edit_file", { path: "a", oldString: "a", newString: "b", replaceAll: "y" }, "replaceAll"],
    // run_command
    ["run_command", {}, "command"],
    ["run_command", { command: "x".repeat(8001) }, "command"],
    ["run_command", { command: "ls", timeoutMs: 600001 }, "timeoutMs"],
    ["run_command", { command: "ls", timeoutMs: 0 }, "timeoutMs"],
    // get_diagnostics
    ["get_diagnostics", { severity: "info" }, "severity"],
    ["get_diagnostics", { limit: 0 }, "limit"],
    // git_status takes no args
    ["git_status", { extra: true }, "extra"],
    // git_diff
    ["git_diff", { context: 21 }, "context"],
    ["git_diff", { staged: "no" }, "staged"],
    ["git_diff", { base: 7 }, "base"],
    // git_log
    ["git_log", { limit: 101 }, "limit"],
    ["git_log", { ref: "" }, "ref"],
    // git_commit
    ["git_commit", {}, "message"],
    ["git_commit", { message: "   " }, "message"],
    ["git_commit", { message: "x".repeat(4001) }, "message"],
    ["git_commit", { message: "ok", paths: "a.ts" }, "paths"],
    ["git_commit", { message: "ok", paths: [1] }, "paths"],
  ];

  it.each(cases)("%s rejects %j", (tool, args, mention) => {
    const r = validateArgs(tool, args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(mention);
  });

  it("rejects non-object args and unknown keys for every tool", () => {
    const names: ToolName[] = [
      "read_file", "list_dir", "glob", "grep", "write_file", "edit_file",
      "run_command", "get_diagnostics", "git_status", "git_diff", "git_log", "git_commit",
    ];
    for (const name of names) {
      expect(validateArgs(name, null).ok).toBe(false);
      expect(validateArgs(name, [] as unknown).ok).toBe(false);
      const r = validateArgs(name, { bogusKey: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("bogusKey");
    }
  });
});

describe("validateArgs: defaults applied", () => {
  it("read_file", () => {
    const r = validateArgs("read_file", { path: "a.ts" });
    expect(r).toEqual({ ok: true, args: { path: "a.ts", offset: 1, limit: 2000 } });
  });

  it("list_dir defaults to '.', depth 1, hidden off", () => {
    expect(validateArgs("list_dir", {})).toEqual({
      ok: true,
      args: { path: ".", depth: 1, includeHidden: false },
    });
  });

  it("glob limit 200 and no path key when omitted", () => {
    const r = validateArgs("glob", { pattern: "**/*.ts" });
    expect(r).toEqual({ ok: true, args: { pattern: "**/*.ts", limit: 200 } });
    if (r.ok) expect("path" in r.args).toBe(false);
  });

  it("grep defaults", () => {
    expect(validateArgs("grep", { pattern: "foo" })).toEqual({
      ok: true,
      args: { pattern: "foo", regex: true, caseSensitive: false, context: 0, limit: 100 },
    });
  });

  it("write_file createDirs true, edit_file replaceAll false", () => {
    expect(validateArgs("write_file", { path: "a", content: "" })).toEqual({
      ok: true,
      args: { path: "a", content: "", createDirs: true },
    });
    expect(validateArgs("edit_file", { path: "a", oldString: "x", newString: "" })).toEqual({
      ok: true,
      args: { path: "a", oldString: "x", newString: "", replaceAll: false },
    });
  });

  it("run_command timeout 120000", () => {
    expect(validateArgs("run_command", { command: "ls" })).toEqual({
      ok: true,
      args: { command: "ls", timeoutMs: 120000 },
    });
  });

  it("get_diagnostics severity warning, limit 200", () => {
    expect(validateArgs("get_diagnostics", {})).toEqual({
      ok: true,
      args: { severity: "warning", limit: 200 },
    });
  });

  it("git_status yields empty args", () => {
    expect(validateArgs("git_status", {})).toEqual({ ok: true, args: {} });
  });

  it("git_diff context 3, staged false; git_log limit 20; git_commit all false", () => {
    expect(validateArgs("git_diff", {})).toEqual({
      ok: true,
      args: { staged: false, context: 3 },
    });
    expect(validateArgs("git_log", {})).toEqual({ ok: true, args: { limit: 20 } });
    expect(validateArgs("git_commit", { message: "feat: x" })).toEqual({
      ok: true,
      args: { message: "feat: x", all: false },
    });
  });

  it("accepts boundary values", () => {
    expect(validateArgs("read_file", { path: "a", limit: 5000 }).ok).toBe(true);
    expect(validateArgs("grep", { pattern: "a", context: 5, limit: 500 }).ok).toBe(true);
    expect(validateArgs("git_diff", { context: 0 }).ok).toBe(true);
    expect(validateArgs("run_command", { command: "x", timeoutMs: 600000 }).ok).toBe(true);
  });
});

describe("validateArgs: unknown tool", () => {
  it("returns an error result", () => {
    const r = validateArgs("nope" as ToolName, {});
    expect(r.ok).toBe(false);
  });
});

describe("registry.execute", () => {
  it("happy path runs the handler with validated args and defaults", async () => {
    const registry = createRegistry();
    let seen: unknown;
    registry.register("read_file", async (args) => {
      seen = args;
      return { path: args.path, content: "hi", startLine: 1, endLine: 1, totalLines: 1, truncated: false };
    });

    const res = await registry.execute(call("read_file", { path: "a.ts" }), ctx);
    expect(seen).toEqual({ path: "a.ts", offset: 1, limit: 2000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(false);
      expect(typeof res.durationMs).toBe("number");
      expect(res.result).toMatchObject({ path: "a.ts", content: "hi" });
    }
  });

  it("invalid args never reach the handler", async () => {
    const registry = createRegistry();
    let called = false;
    registry.register("read_file", async () => {
      called = true;
      return null;
    });
    const res = await registry.execute(call("read_file", {}), ctx);
    expect(called).toBe(false);
    expect(res).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("unknown tool yields an error", async () => {
    const registry = createRegistry();
    const res = await registry.execute(call("bogus" as ToolName, {}), ctx);
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("a registered-but-missing handler yields unsupported", async () => {
    const registry = createRegistry();
    const res = await registry.execute(call("glob", { pattern: "*" }), ctx);
    expect(res).toMatchObject({ ok: false, error: { code: "unsupported" } });
  });

  it("a thrown ToolError keeps its code, message and details", async () => {
    const registry = createRegistry();
    registry.register("edit_file", async () => {
      throw toolError("not_unique", "matches more than once", { count: 3 });
    });
    const res = await registry.execute(
      call("edit_file", { path: "a", oldString: "x", newString: "y" }),
      ctx,
    );
    expect(res).toEqual({
      ok: false,
      error: { code: "not_unique", message: "matches more than once", details: { count: 3 } },
    });
  });

  it("toolError returns a ToolError instance with the shape fields", () => {
    const e = toolError("not_found", "missing");
    expect(e).toBeInstanceOf(ToolError);
    expect(e.code).toBe("not_found");
    expect(e.details).toBeUndefined();
  });

  it("an unknown exception becomes io_error without leaking stack or path", async () => {
    const registry = createRegistry();
    registry.register("glob", async () => {
      throw new Error("boom at /home/secret/project/x.ts");
    });
    const res = await registry.execute(call("glob", { pattern: "*" }), ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("io_error");
      expect(res.error.message).not.toContain("/home/secret");
      expect(JSON.stringify(res.error)).not.toContain("at ");
    }
  });

  it("an ENOENT-coded error maps to not_found", async () => {
    const registry = createRegistry();
    registry.register("glob", async () => {
      throw Object.assign(new Error("ENOENT: /x"), { code: "ENOENT" });
    });
    const res = await registry.execute(call("glob", { pattern: "*" }), ctx);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("an oversize result is shrunk and marked truncated", async () => {
    const registry = createRegistry();
    registry.register("read_file", async () => ({
      path: "big.txt",
      content: "x".repeat(400 * 1024),
      truncated: false,
    }));
    const res = await registry.execute(call("read_file", { path: "big.txt" }), ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(true);
      expect((res.result as { truncated: boolean }).truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(res.result))).toBeLessThanOrEqual(
        TOOL_RESULT_MAX_BYTES,
      );
      expect((res.result as { content: string }).content).toContain("truncated");
    }
  });

  it("an oversize array result is shrunk by halving", async () => {
    const registry = createRegistry();
    const entries = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}`, text: "y".repeat(100) }));
    registry.register("grep", async () => ({ matches: entries, truncated: false }));
    const res = await registry.execute(call("grep", { pattern: "y" }), ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(res.result))).toBeLessThanOrEqual(
        TOOL_RESULT_MAX_BYTES,
      );
    }
  });

  it("a result that cannot be shrunk yields too_large", async () => {
    const registry = createRegistry();
    registry.register("glob", async () => ({
      nested: { deep: "z".repeat(300 * 1024) },
    }));
    const res = await registry.execute(call("glob", { pattern: "*" }), ctx);
    expect(res).toMatchObject({ ok: false, error: { code: "too_large" } });
  });

  it("returns cancelled when the signal is already aborted", async () => {
    const registry = createRegistry();
    registry.register("glob", async () => "never");
    const ac = new AbortController();
    ac.abort();
    const res = await registry.execute(call("glob", { pattern: "*" }), { ...ctx, signal: ac.signal });
    expect(res).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
