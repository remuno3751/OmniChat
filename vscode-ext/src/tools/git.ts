/**
 * Git tools for the VS Code bridge (spec: docs/design/VSCODE-BRIDGE.md §3 rows
 * git_status / git_diff / git_log / git_commit, and §4.3 P2/P3).
 *
 * Every git call goes through `execFile("git", argv)`: no shell, args as an
 * array. Refs are checked against a strict pattern and paths are resolved
 * inside the root. Paths always follow `--`, and the child runs with
 * GIT_LITERAL_PATHSPECS=1 so glob characters in names are taken literally.
 * Commit never amends, never skips hooks, and never pushes.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { isGitInternal, isSecretPath, resolveInWorkspace } from "../guard/paths";
import { toolError, type ToolContext, type ToolRegistry } from "./index";
import type { GitCommitArgs, GitDiffArgs, GitLogArgs, GitStatusArgs } from "./schemas";
import { GIT_DIFF_MAX_BYTES, GIT_STATUS_MAX_FILES } from "./limits";

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const REF_MAX_CHARS = 255;
const REF_PATTERN = /^[A-Za-z0-9._\/~^@{}-]+$/;
const NOT_REPO = /not a git repository/i;
const EMPTY_REPO = /does not have any commits yet/i;
const NOTHING_TO_COMMIT = /nothing (added )?to commit|no changes added to commit/i;
const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e";

/** index/worktree are porcelain v2 XY letters ("." unmodified, "?" untracked). */
export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  origPath?: string;
}
export interface GitStatusResult {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  truncated: boolean;
}
export interface GitDiffResult {
  patch: string;
  truncated: boolean;
}
export interface GitLogEntry {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

/** overflow: stdout hit the buffer cap, so the output is partial. */
interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
  overflow: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_LITERAL_PATHSPECS: "1" };
}

/** Runs git and resolves with its exit code. Rejects only for spawn-level failures. */
function runGit(argv: string[], ctx: ToolContext, partialOk = false): Promise<GitRun> {
  return new Promise<GitRun>((resolve, reject) => {
    execFile(
      "git",
      argv,
      { cwd: ctx.cwd, env: gitEnv(), encoding: "buffer", maxBuffer: GIT_MAX_BUFFER_BYTES, timeout: GIT_TIMEOUT_MS, signal: ctx.signal, windowsHide: true },
      (err, stdout, stderr) => {
        const out = Buffer.from(stdout);
        const text = Buffer.from(stderr).toString("utf8");
        if (!err) return resolve({ code: 0, stdout: out, stderr: text, overflow: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.name === "AbortError") return reject(e);
        if (e.code === "ENOENT") return reject(toolError("unsupported", "git is not available"));
        if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          if (partialOk) return resolve({ code: 0, stdout: out, stderr: text, overflow: true });
          return reject(toolError("too_large", "git output is too large"));
        }
        if (e.killed) return reject(toolError("timeout", "git timed out"));
        if (typeof e.code === "number") {
          return resolve({ code: e.code, stdout: out, stderr: text, overflow: false });
        }
        return reject(e);
      },
    );
  });
}

/** Maps a failed git run to `not_git` or `git_failed`. Never includes git's stderr. */
function failure(run: GitRun): never {
  if (NOT_REPO.test(run.stderr)) throw toolError("not_git", "not a git repository");
  throw toolError("git_failed", "git command failed");
}

async function gitOut(argv: string[], ctx: ToolContext): Promise<Buffer> {
  const run = await runGit(argv, ctx);
  if (run.code !== 0) failure(run);
  return run.stdout;
}

/** Ref names: no leading `-` (no option injection), no `:` (no refspecs), bounded length. */
function checkRef(ref: string): string {
  if (ref.length > REF_MAX_CHARS || ref.startsWith("-") || !REF_PATTERN.test(ref)) {
    throw toolError("invalid_args", "ref is not a valid git ref name");
  }
  return ref;
}

/**
 * Resolves a user path inside the root (spec P1) and refuses secret and `.git`
 * paths (P3, P2). Returns an absolute path to pass after `--`.
 */
async function repoPath(ctx: ToolContext, userPath: string): Promise<string> {
  if (userPath.startsWith("-")) throw toolError("invalid_args", 'path must not start with "-"');
  const r = await resolveInWorkspace(ctx.root, userPath, (p) => realpath(p));
  if (!r.ok) throw toolError(r.reason, r.message);
  const rel = relative(ctx.root, r.abs).split(/[\\/]/).join("/");
  if (isSecretPath(rel) || isGitInternal(rel)) throw toolError("protected_path", "path is protected");
  return r.abs;
}

/** `names` is a NUL-separated list of repo-relative paths from git. */
function refuseProtected(names: Buffer): void {
  const list = names.toString("utf8").split("\0").filter((n) => n !== "");
  if (list.some((n) => isSecretPath(n) || isGitInternal(n))) {
    throw toolError("protected_path", "changes include a protected path");
  }
}

// git_status

/** Takes the first `n` space-separated fields; the remainder (the path) is kept whole. */
function take(rec: string, n: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = rec.indexOf(" ", pos);
    if (sp < 0) break;
    fields.push(rec.slice(pos, sp));
    pos = sp + 1;
  }
  return { fields, rest: rec.slice(pos) };
}

function parseHeader(line: string, out: GitStatusResult): void {
  const [, key = "", ...rest] = line.split(" ");
  const value = rest.join(" ");
  if (key === "branch.head") out.branch = value;
  else if (key === "branch.upstream") out.upstream = value;
  else if (key === "branch.ab") {
    const m = /^\+(\d+) -(\d+)$/.exec(value);
    if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
  }
}

function pushFile(out: GitStatusResult, path: string, xy: string, origPath?: string): void {
  if (out.files.length >= GIT_STATUS_MAX_FILES) {
    out.truncated = true;
    return;
  }
  const entry: GitFileStatus = { path, index: xy[0] ?? ".", worktree: xy[1] ?? "." };
  if (origPath !== undefined) entry.origPath = origPath;
  out.files.push(entry);
}

/** Parses `status --porcelain=v2 -b -z` output. */
function parseStatus(text: string): GitStatusResult {
  const out: GitStatusResult = { branch: "(detached)", ahead: 0, behind: 0, files: [], truncated: false };
  const recs = text.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i] ?? "";
    if (rec === "") continue;
    if (rec.startsWith("# ")) {
      parseHeader(rec, out);
      continue;
    }
    switch (rec[0]) {
      case "1": {
        const { fields, rest } = take(rec, 8);
        pushFile(out, rest, fields[1] ?? "..");
        break;
      }
      case "2": {
        // Rename/copy: the original path is the next NUL-terminated record.
        const { fields, rest } = take(rec, 9);
        const orig = recs[++i];
        pushFile(out, rest, fields[1] ?? "..", orig);
        break;
      }
      case "u": {
        const { fields, rest } = take(rec, 10);
        pushFile(out, rest, fields[1] ?? "UU");
        break;
      }
      case "?":
        pushFile(out, rec.slice(2), "??");
        break;
      default:
        // "!" (ignored) entries are not requested, so they never appear.
        break;
    }
  }
  return out;
}

export async function gitStatus(_args: GitStatusArgs, ctx: ToolContext): Promise<GitStatusResult> {
  const out = await gitOut(["status", "--porcelain=v2", "-b", "-z"], ctx);
  return parseStatus(out.toString("utf8"));
}

// git_diff / git_log

export async function gitDiff(args: GitDiffArgs, ctx: ToolContext): Promise<GitDiffResult> {
  const argv = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `--unified=${args.context}`];
  if (args.staged) argv.push("--cached");
  if (args.base !== undefined) argv.push(checkRef(args.base));
  argv.push("--");
  if (args.path !== undefined) argv.push(await repoPath(ctx, args.path));

  const run = await runGit(argv, ctx, true);
  if (run.code !== 0) failure(run);
  const truncated = run.overflow || run.stdout.length > GIT_DIFF_MAX_BYTES;
  const body = run.stdout.subarray(0, GIT_DIFF_MAX_BYTES);
  return { patch: body.toString("utf8"), truncated };
}

export async function gitLog(args: GitLogArgs, ctx: ToolContext): Promise<{ commits: GitLogEntry[] }> {
  const argv = ["log", `-n${args.limit}`, `--format=${LOG_FORMAT}`];
  if (args.ref !== undefined) argv.push(checkRef(args.ref));
  argv.push("--");
  if (args.path !== undefined) argv.push(await repoPath(ctx, args.path));

  const run = await runGit(argv, ctx);
  if (run.code !== 0) {
    // A repository with no commits yet has an empty history, not an error.
    if (EMPTY_REPO.test(run.stderr)) return { commits: [] };
    failure(run);
  }
  const commits: GitLogEntry[] = [];
  for (const raw of run.stdout.toString("utf8").split("\x1e")) {
    const rec = raw.replace(/^\n+/, "");
    if (rec === "") continue;
    const [hash = "", short = "", author = "", date = "", subject = ""] = rec.split("\x1f");
    commits.push({ hash, short, author, date, subject });
  }
  return { commits };
}

// git_commit

export async function gitCommit(args: GitCommitArgs, ctx: ToolContext): Promise<{ hash: string }> {
  const paths = args.paths ?? [];
  if (args.all && paths.length > 0) {
    throw toolError("invalid_args", 'use "paths" or "all", not both');
  }
  if (args.message.includes("\0")) throw toolError("invalid_args", '"message" must not contain NUL');

  const abs: string[] = [];
  for (const p of paths) abs.push(await repoPath(ctx, p));

  // `all` (= -a) would stage every modified or deleted tracked file: check them first.
  if (args.all) refuseProtected(await gitOut(["ls-files", "--full-name", "-z", "-m", "-d"], ctx));

  if (abs.length > 0) await gitOut(["add", "--", ...abs], ctx);
  try {
    refuseProtected(await gitOut(["diff", "--cached", "--name-only", "-z"], ctx));
  } catch (err) {
    // Unstage only what this call added; the user's other staged changes stay.
    if (abs.length > 0) await runGit(["reset", "-q", "--", ...abs], ctx);
    throw err;
  }

  // No amend and no --no-verify: hooks run as usual.
  const run = await runGit(["commit", ...(args.all ? ["-a"] : []), "-m", args.message], ctx);
  if (run.code !== 0) {
    if (NOTHING_TO_COMMIT.test(run.stdout.toString("utf8") + run.stderr)) {
      throw toolError("git_failed", "nothing to commit: no staged changes");
    }
    failure(run);
  }
  return { hash: (await gitOut(["rev-parse", "HEAD"], ctx)).toString("utf8").trim() };
}

// Registration

export function registerGitTools(registry: ToolRegistry): void {
  registry.register("git_status", gitStatus);
  registry.register("git_diff", gitDiff);
  registry.register("git_log", gitLog);
  registry.register("git_commit", gitCommit);
}
