import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolCall, ToolName } from "../src/protocol/frames";
import type { Host } from "../src/host/types";
import { createRegistry, type ToolContext } from "../src/tools/index";
import { registerGitTools } from "../src/tools/git";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
}

function makeCtx(dir: string): ToolContext {
  return {
    host: {} as Host,
    root: dir,
    roots: [dir],
    signal: new AbortController().signal,
    cwd: dir,
  };
}

const registry = createRegistry();
registerGitTools(registry);

function call(tool: ToolName, args: object, ctx: ToolContext) {
  const c = { runId: "run", callId: "call", tool, args, timeoutMs: 10_000 };
  return registry.execute(c as unknown as ToolCall, ctx);
}

let repo: string;
let ctx: ToolContext;
let plain: string;
let plainCtx: ToolContext;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "omni-git-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  ctx = makeCtx(repo);

  plain = mkdtempSync(join(tmpdir(), "omni-plain-"));
  plainCtx = makeCtx(plain);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(plain, { recursive: true, force: true });
});

function expectError(res: unknown, code: string): void {
  const r = res as { ok: boolean; error?: { code: string } };
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe(code);
}

describe("git_status", () => {
  it("parses branch and file states from porcelain v2", async () => {
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    git(repo, "add", "b.txt");
    writeFileSync(join(repo, "c d.txt"), "untracked\n");

    const res = await call("git_status", {}, ctx);
    expect(res.ok).toBe(true);
    const r = (res as { result: { branch: string; ahead: number; behind: number; files: unknown[] } }).result;
    expect(r.branch).toBe("main");
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.files).toEqual(
      expect.arrayContaining([
        { path: "a.txt", index: ".", worktree: "M" },
        { path: "b.txt", index: "A", worktree: "." },
        { path: "c d.txt", index: "?", worktree: "?" },
      ]),
    );
    expect(r).not.toHaveProperty("upstream");
  });

  it("returns not_git outside a repository", async () => {
    expectError(await call("git_status", {}, plainCtx), "not_git");
  });
});

describe("git_diff", () => {
  beforeAll(() => {
    // Reset the worktree so the diff tests start from a known state.
    git(repo, "reset", "-q");
    git(repo, "checkout", "-q", "--", "a.txt");
    rmSync(join(repo, "b.txt"), { force: true });
    rmSync(join(repo, "c d.txt"), { force: true });
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  });

  it("returns the unstaged patch", async () => {
    const res = await call("git_diff", { context: 3 }, ctx);
    expect(res.ok).toBe(true);
    const r = (res as { result: { patch: string; truncated: boolean } }).result;
    expect(r.patch).toContain("+two");
    expect(r.truncated).toBe(false);
  });

  it("returns the staged patch and a single path", async () => {
    git(repo, "add", "a.txt");
    const staged = await call("git_diff", { staged: true, path: "a.txt" }, ctx);
    expect((staged as { result: { patch: string } }).result.patch).toContain("+two");
    const unstaged = await call("git_diff", { path: "a.txt" }, ctx);
    expect((unstaged as { result: { patch: string } }).result.patch).toBe("");
  });

  it("accepts a base ref", async () => {
    const res = await call("git_diff", { base: "HEAD", staged: true }, ctx);
    expect((res as { result: { patch: string } }).result.patch).toContain("+two");
  });

  it("caps the patch at 200 KB and sets truncated", async () => {
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} padding text`).join("\n");
    writeFileSync(join(repo, "big.txt"), "x\n");
    git(repo, "add", "big.txt");
    git(repo, "commit", "-q", "-m", "big");
    writeFileSync(join(repo, "big.txt"), big + "\n");
    const res = await call("git_diff", {}, ctx);
    const r = (res as { result: { patch: string; truncated: boolean } }).result;
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.patch, "utf8")).toBeLessThanOrEqual(200 * 1024);
  });

  it("refuses secret and .git paths", async () => {
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    expectError(await call("git_diff", { path: ".env" }, ctx), "protected_path");
    expectError(await call("git_diff", { path: ".git/config" }, ctx), "protected_path");
  });

  it("rejects option-like refs and paths", async () => {
    expectError(await call("git_diff", { base: "--upload-pack=touch /tmp/pwned" }, ctx), "invalid_args");
    expectError(await call("git_diff", { base: "HEAD:a.txt" }, ctx), "invalid_args");
    expectError(await call("git_diff", { path: "--output=/tmp/x" }, ctx), "invalid_args");
  });

  it("returns not_git outside a repository", async () => {
    expectError(await call("git_diff", {}, plainCtx), "not_git");
  });
});

describe("git_log", () => {
  it("returns the newest commits first, limited", async () => {
    const res = await call("git_log", { limit: 2 }, ctx);
    expect(res.ok).toBe(true);
    const commits = (res as { result: { commits: { hash: string; subject: string; author: string }[] } })
      .result.commits;
    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe("big");
    expect(commits[0]?.author).toBe("Test");
    expect(commits[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("filters by path and ref", async () => {
    const byPath = await call("git_log", { path: "big.txt" }, ctx);
    const subjects = (byPath as { result: { commits: { subject: string }[] } }).result.commits.map((c) => c.subject);
    expect(subjects).toEqual(["big"]);

    const byRef = await call("git_log", { ref: "HEAD~1", limit: 1 }, ctx);
    expect((byRef as { result: { commits: { subject: string }[] } }).result.commits[0]?.subject).toBe("init");
  });

  it("rejects option-like refs and paths", async () => {
    expectError(await call("git_log", { ref: "--upload-pack=touch /tmp/pwned" }, ctx), "invalid_args");
    expectError(await call("git_log", { path: "--output=/tmp/x" }, ctx), "invalid_args");
  });

  it("returns an empty list for a repository with no commits", async () => {
    const empty = mkdtempSync(join(tmpdir(), "omni-empty-"));
    try {
      git(empty, "init", "-q", "-b", "main");
      const res = await call("git_log", {}, makeCtx(empty));
      expect(res).toEqual({ ok: true, result: { commits: [] }, truncated: false, durationMs: expect.any(Number) });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("git_commit", () => {
  it("refuses when nothing is staged", async () => {
    git(repo, "reset", "-q");
    rmSync(join(repo, ".env"), { force: true });
    rmSync(join(repo, "big.txt"), { force: true });
    git(repo, "checkout", "-q", "--", ".");
    expectError(await call("git_commit", { message: "nothing" }, ctx), "git_failed");
  });

  it("commits staged paths and returns the hash", async () => {
    writeFileSync(join(repo, "b.txt"), "b\n");
    const res = await call("git_commit", { message: "add b", paths: ["b.txt"] }, ctx);
    expect(res.ok).toBe(true);
    const hash = (res as { result: { hash: string } }).result.hash;
    expect(hash).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("add b");
  });

  it("commits all tracked changes with all:true", async () => {
    writeFileSync(join(repo, "a.txt"), "one\nthree\n");
    const res = await call("git_commit", { message: "all change", all: true }, ctx);
    expect(res.ok).toBe(true);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("refuses paths that escape the root, secrets, .git and option-like names", async () => {
    expectError(await call("git_commit", { message: "x", paths: ["../outside"] }, ctx), "outside_workspace");
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    expectError(await call("git_commit", { message: "x", paths: [".env"] }, ctx), "protected_path");
    expectError(await call("git_commit", { message: "x", paths: [".git/config"] }, ctx), "protected_path");
    expectError(await call("git_commit", { message: "x", paths: ["--output=/tmp/x"] }, ctx), "invalid_args");
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("unstages a directory that contains a secret file", async () => {
    mkdirSync(join(repo, "keys"));
    writeFileSync(join(repo, "keys", "id_rsa"), "secret\n");
    writeFileSync(join(repo, "keys", "ok.txt"), "ok\n");
    expectError(await call("git_commit", { message: "x", paths: ["keys"] }, ctx), "protected_path");
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("rejects amend, push-like and conflicting arguments", async () => {
    expectError(await call("git_commit", { message: "x", amend: true }, ctx), "invalid_args");
    expectError(await call("git_commit", { message: "x", paths: ["a.txt"], all: true }, ctx), "invalid_args");
    expectError(await call("git_commit", { message: "   " }, ctx), "invalid_args");
  });

  it("returns not_git outside a repository", async () => {
    expectError(await call("git_commit", { message: "x", all: true }, plainCtx), "not_git");
  });
});
