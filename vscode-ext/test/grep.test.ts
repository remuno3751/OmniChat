import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../src/protocol/frames";
import { createNodeHost } from "../src/host/node";
import type { Diagnostic, Host } from "../src/host/types";
import { createRegistry, type ToolContext } from "../src/tools/index";
import { getDiagnostics, grep, registerGrepTools } from "../src/tools/grep";
import { GREP_MAX_FILE_BYTES } from "../src/tools/limits";
import type { GetDiagnosticsArgs, GrepArgs } from "../src/tools/schemas";

let root: string;
let outside: string;

function ctxFor(dir: string, host: Host = createNodeHost([dir])): ToolContext {
  return {
    host,
    root: dir,
    roots: [dir],
    signal: new AbortController().signal,
    cwd: dir,
  };
}

const gargs = (over: Partial<GrepArgs> & { pattern: string }): GrepArgs => ({
  regex: true,
  caseSensitive: false,
  context: 0,
  limit: 100,
  ...over,
});

const dargs = (over: Partial<GetDiagnosticsArgs> = {}): GetDiagnosticsArgs => ({
  severity: "warning",
  limit: 200,
  ...over,
});

async function write(rel: string, data: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

const where = (r: { matches: { path: string; line: number }[] }) =>
  r.matches.map((m) => `${m.path}:${m.line}`);

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-grep-root-"));
  outside = await fsp.mkdtemp(path.join(os.tmpdir(), "omni-grep-outside-"));

  await write("a.ts", "const needle = 1;\nNeedle two\nnothing\n");
  await write("sub/b.md", "x needle\n");
  await write("sub/c.ts", "Needle\n");
  await write("node_modules/pkg/i.ts", "needle\n");
  await write(".git/config", "needle\n");
  await write("bin.dat", Buffer.from([0, ...Buffer.from("needle")]));
  await write(".env", "needle=1\n");
  await write("id_rsa", "needle\n");
  await write("big.txt", "x".repeat(GREP_MAX_FILE_BYTES) + "needle\n");
  // Line 1 has its only "needle" past the 10k scan window; line 2 matches and is clipped to 300 chars.
  await write("long/one.txt", "x".repeat(10_000) + "needle\n" + "needle" + "y".repeat(500) + "\n");
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

describe("grep", () => {
  it("searches the whole tree case-insensitively and skips secrets, binaries, big files and skipped dirs", async () => {
    const r = await grep(gargs({ pattern: "needle", regex: false }), ctxFor(root));
    expect(where(r)).toEqual(["a.ts:1", "a.ts:2", "long/one.txt:2", "sub/b.md:1", "sub/c.ts:1"]);
    expect(r.truncated).toBe(false);
  });

  it("honours caseSensitive", async () => {
    const r = await grep(gargs({ pattern: "Needle", regex: false, caseSensitive: true }), ctxFor(root));
    expect(where(r)).toEqual(["a.ts:2", "sub/c.ts:1"]);
  });

  it("treats the pattern as a regex by default and as a literal when regex is false", async () => {
    const literal = await grep(gargs({ pattern: "n.edle", regex: false }), ctxFor(root));
    expect(literal.matches).toHaveLength(0);
    const regex = await grep(gargs({ pattern: "^nothing$" }), ctxFor(root));
    expect(where(regex)).toEqual(["a.ts:3"]);
  });

  it("returns context lines only when context is above zero", async () => {
    const plain = await grep(gargs({ pattern: "Needle two" }), ctxFor(root));
    expect(plain.matches[0]).toEqual({ path: "a.ts", line: 2, text: "Needle two" });

    const ctx1 = await grep(gargs({ pattern: "Needle two", context: 1 }), ctxFor(root));
    expect(ctx1.matches[0]).toEqual({
      path: "a.ts",
      line: 2,
      text: "Needle two",
      before: ["const needle = 1;"],
      after: ["nothing"],
    });
  });

  it("applies the glob filter to the path relative to the search base", async () => {
    const ts = await grep(gargs({ pattern: "needle", regex: false, glob: "**/*.ts" }), ctxFor(root));
    expect(where(ts)).toEqual(["a.ts:1", "a.ts:2", "sub/c.ts:1"]);

    const flat = await grep(gargs({ pattern: "needle", regex: false, glob: "*.md" }), ctxFor(root));
    expect(flat.matches).toHaveLength(0);

    const md = await grep(gargs({ pattern: "needle", regex: false, glob: "**/*.md" }), ctxFor(root));
    expect(where(md)).toEqual(["sub/b.md:1"]);
  });

  it("limits matches and reports truncated only when more matches exist", async () => {
    const two = await grep(gargs({ pattern: "needle", regex: false, limit: 2 }), ctxFor(root));
    expect(where(two)).toEqual(["a.ts:1", "a.ts:2"]);
    expect(two.truncated).toBe(true);

    const all = await grep(gargs({ pattern: "needle", regex: false, limit: 5 }), ctxFor(root));
    expect(all.matches).toHaveLength(5);
    expect(all.truncated).toBe(false);
  });

  it("searches a single file or a subdirectory when path is given", async () => {
    const file = await grep(gargs({ pattern: "needle", regex: false, path: "a.ts" }), ctxFor(root));
    expect(where(file)).toEqual(["a.ts:1", "a.ts:2"]);

    const dir = await grep(gargs({ pattern: "needle", regex: false, path: "sub" }), ctxFor(root));
    expect(where(dir)).toEqual(["sub/b.md:1", "sub/c.ts:1"]);
  });

  it("clips matched lines and never matches past the per-line scan window", async () => {
    const r = await grep(gargs({ pattern: "needle", regex: false, path: "long/one.txt" }), ctxFor(root));
    expect(where(r)).toEqual(["long/one.txt:2"]);
    expect(r.matches[0]?.text).toHaveLength(300);
    expect(r.matches[0]?.text.startsWith("needle")).toBe(true);
  });

  it("rejects an invalid regex with invalid_args", async () => {
    await expectCode(grep(gargs({ pattern: "(" }), ctxFor(root)), "invalid_args");
  });

  it("refuses secret paths, outside paths and missing paths", async () => {
    await expectCode(grep(gargs({ pattern: "x", path: ".env" }), ctxFor(root)), "protected_path");
    await expectCode(grep(gargs({ pattern: "x", path: "id_rsa" }), ctxFor(root)), "protected_path");
    await expectCode(grep(gargs({ pattern: "x", path: outside }), ctxFor(root)), "outside_workspace");
    await expectCode(grep(gargs({ pattern: "x", path: "../" }), ctxFor(root)), "outside_workspace");
    await expectCode(grep(gargs({ pattern: "x", path: "missing" }), ctxFor(root)), "not_found");
  });
});

describe("get_diagnostics", () => {
  const diag = (over: Partial<Diagnostic> & { path: string; severity: Diagnostic["severity"] }): Diagnostic => ({
    line: 1,
    col: 1,
    endLine: 1,
    endCol: 2,
    message: "msg",
    ...over,
  });

  /** Fake host: only diagnostics() is used by the tool. Everything else refuses. */
  function fakeHost(roots: string[], diags: Diagnostic[]): Host {
    const nope = async (): Promise<never> => {
      throw Object.assign(new Error("unused"), { code: "ENOENT" });
    };
    return {
      roots,
      realpath: async (p: string) => p,
      readFile: nope,
      writeFile: nope,
      stat: nope,
      readdir: async () => [],
      openDocuments: new Map(),
      diagnostics: () => diags,
      applyEdit: nope,
    };
  }

  function setup(): ToolContext {
    const diags: Diagnostic[] = [
      diag({ path: path.join(root, "a.ts"), line: 1, severity: "error", source: "ts", code: "2304", message: "E1" }),
      diag({ path: path.join(root, "a.ts"), line: 5, severity: "warning", message: "W5" }),
      diag({ path: path.join(root, "sub/b.ts"), line: 2, severity: "info" }),
      diag({ path: path.join(root, "sub/c.ts"), line: 3, severity: "hint" }),
      diag({ path: path.join(root, ".env"), line: 1, severity: "error" }),
      diag({ path: path.join(outside, "x.ts"), line: 1, severity: "error" }),
      diag({ path: "sub/d.ts", line: 4, severity: "warning" }),
    ];
    return ctxFor(root, fakeHost([root], diags));
  }

  const keyOf = (r: { items: { path: string; line: number }[] }) =>
    r.items.map((i) => `${i.path}:${i.line}`);

  it("defaults to error and warning and drops secret and outside-workspace diagnostics", async () => {
    const r = await getDiagnostics(dargs(), setup());
    expect(keyOf(r)).toEqual(["a.ts:1", "a.ts:5", "sub/d.ts:4"]);
    expect(r.truncated).toBe(false);
  });

  it("filters by severity", async () => {
    expect(keyOf(await getDiagnostics(dargs({ severity: "error" }), setup()))).toEqual(["a.ts:1"]);
    expect(keyOf(await getDiagnostics(dargs({ severity: "all" }), setup()))).toEqual([
      "a.ts:1",
      "a.ts:5",
      "sub/b.ts:2",
      "sub/c.ts:3",
      "sub/d.ts:4",
    ]);
  });

  it("filters by path for a file and for a directory", async () => {
    expect(keyOf(await getDiagnostics(dargs({ path: "a.ts" }), setup()))).toEqual(["a.ts:1", "a.ts:5"]);
    expect(keyOf(await getDiagnostics(dargs({ path: "sub", severity: "all" }), setup()))).toEqual([
      "sub/b.ts:2",
      "sub/c.ts:3",
      "sub/d.ts:4",
    ]);
  });

  it("keeps source and code only when present", async () => {
    const r = await getDiagnostics(dargs({ severity: "error" }), setup());
    expect(r.items[0]).toEqual({
      path: "a.ts",
      line: 1,
      col: 1,
      endLine: 1,
      endCol: 2,
      severity: "error",
      source: "ts",
      code: "2304",
      message: "E1",
    });
    const warn = await getDiagnostics(dargs({ path: "a.ts" }), setup());
    expect(warn.items[1]).not.toHaveProperty("source");
    expect(warn.items[1]).not.toHaveProperty("code");
  });

  it("applies the limit and reports truncated", async () => {
    const r = await getDiagnostics(dargs({ limit: 1 }), setup());
    expect(keyOf(r)).toEqual(["a.ts:1"]);
    expect(r.truncated).toBe(true);
  });

  it("refuses a path outside the workspace and a secret path", async () => {
    await expectCode(getDiagnostics(dargs({ path: outside }), setup()), "outside_workspace");
    await expectCode(getDiagnostics(dargs({ path: ".env" }), setup()), "protected_path");
  });
});

describe("registerGrepTools", () => {
  const call = (tool: "grep" | "get_diagnostics", args: unknown): ToolCall =>
    ({ runId: "r", callId: "c", tool, args, timeoutMs: 5000 }) as unknown as ToolCall;

  it("registers both tools and validates their args", async () => {
    const registry = createRegistry();
    registerGrepTools(registry);
    const ctx = ctxFor(root);

    const ok = await registry.execute(call("grep", { pattern: "nothing" }), ctx);
    expect(ok).toMatchObject({ ok: true, result: { truncated: false } });

    const bad = await registry.execute(call("grep", { pattern: "(" }), ctx);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_args" } });

    const sev = await registry.execute(call("get_diagnostics", { severity: "loud" }), ctx);
    expect(sev).toMatchObject({ ok: false, error: { code: "invalid_args" } });

    const diags = await registry.execute(call("get_diagnostics", {}), ctx);
    expect(diags).toMatchObject({ ok: true, result: { items: [], truncated: false } });
  });
});
