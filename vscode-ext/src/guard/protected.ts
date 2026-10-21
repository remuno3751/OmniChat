/**
 * checkProtected: spec §4.2 step 1 and §4.3 protected items for the 12 bridge tools.
 *
 * Path rules (P1 outside, P2 git-write, P3 secrets) use the injected realpath when given (extension).
 * Without it the check is lexical only (server). Any failure to analyse is protected as
 * "unparseable" (fail closed). Command rules live in ./protected-cmd.ts.
 */
import type { ToolArgs, ToolName } from "../protocol/frames";
import { isGitInternal, isSecretPath, normalizePath, resolveInWorkspace, type RealpathFn } from "./paths";
import {
  checkCommandString,
  identityRealpath,
  insideRoots,
  joinCwd,
  RULE,
  unparse,
  type Ctx,
  type Hit,
} from "./protected-cmd";

export type ProtectedVerdict =
  | { protected: false }
  | { protected: true; rule: string; reason: string };

export interface ProtectedCall {
  tool: ToolName;
  args: ToolArgs;
}

export interface ProtectedContext {
  /** Workspace roots of the run (absolute). */
  roots: string[];
  /** Working directory of the run (absolute when known). */
  cwd: string;
  /** Symlink resolver. Omit on the server, which checks lexically only. */
  realpath?: RealpathFn;
  platform?: "posix" | "win32";
}

export async function checkProtected(call: ProtectedCall, ctx: ProtectedContext): Promise<ProtectedVerdict> {
  let hit: Hit | null;
  try {
    hit = await dispatch(call, ctx);
  } catch {
    hit = unparse("could not be checked");
  }
  return hit ? { protected: true, rule: hit.rule, reason: hit.reason } : { protected: false };
}

async function dispatch(call: ProtectedCall, ctx: Ctx): Promise<Hit | null> {
  const a = call.args;
  switch (call.tool) {
    case "read_file":
      return fileArg(ctx, a.path, false);
    case "write_file":
    case "edit_file":
      return fileArg(ctx, a.path, true);
    case "list_dir":
    case "glob":
    case "grep":
    case "get_diagnostics":
    case "git_diff":
    case "git_log":
      return a.path === undefined ? null : fileArg(ctx, a.path, false);
    case "git_status":
      return null;
    case "git_commit":
      return commitArg(ctx, a.paths);
    case "run_command":
      return runArg(ctx, a);
    default:
      return unparse("unknown tool");
  }
}

async function fileArg(ctx: Ctx, raw: unknown, write: boolean): Promise<Hit | null> {
  if (typeof raw !== "string") return unparse("path is not a string");
  return checkFile(ctx, raw, write);
}

async function commitArg(ctx: Ctx, paths: unknown): Promise<Hit | null> {
  if (paths === undefined) return null;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    return unparse("paths must be strings");
  }
  for (const p of paths as string[]) {
    const hit = await checkFile(ctx, p, true);
    if (hit) return hit;
  }
  return null;
}

async function runArg(ctx: Ctx, a: ToolArgs): Promise<Hit | null> {
  if (typeof a.command !== "string") return unparse("command is not a string");
  let cwd = ctx.cwd;
  if (a.cwd !== undefined) {
    if (typeof a.cwd !== "string") return unparse("cwd is not a string");
    const target = joinCwd(ctx.cwd, a.cwd);
    if ((await insideRoots(ctx, target)) !== "ok") {
      return { rule: RULE.outside, reason: "cwd is outside the workspace" };
    }
    cwd = target;
  }
  return checkCommandString(a.command, { ...ctx, cwd });
}

/** P1 (outside), P2 (.git writes, edits only) and P3 (secrets) on the lexical path and its symlink target. */
async function checkFile(ctx: Ctx, raw: string, write: boolean): Promise<Hit | null> {
  const rp = ctx.realpath ?? identityRealpath;
  let found: { abs: string; root: string } | null = null;
  let invalid = false;
  for (const root of ctx.roots) {
    const r = await resolveInWorkspace(root, raw, rp);
    if (r.ok) {
      found = { abs: r.abs, root };
      break;
    }
    if (r.reason !== "outside_workspace") invalid = true;
  }
  if (found === null) {
    return invalid
      ? unparse("path could not be resolved")
      : { rule: RULE.outside, reason: "path is outside the workspace" };
  }
  const root = normalizePath(found.root);
  const realRoot = normalizePath(await rp(root));
  const real = await realOf(found.abs, rp);
  for (const rel of [relTo(found.abs, root), relTo(real, realRoot)]) {
    if (write && isGitInternal(rel)) return { rule: RULE.gitWrite, reason: "write inside .git" };
    if (isSecretPath(rel)) return { rule: RULE.secret, reason: "secret-looking path" };
  }
  return null;
}

const isMissing = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  ["ENOENT", "ENOTDIR"].includes(String((err as { code?: unknown }).code));

const appendSeg = (base: string, seg: string): string =>
  base.endsWith("/") ? `${base}${seg}` : `${base}/${seg}`;

/** Real path of `abs`. A missing tail (a file about to be created) is appended to the resolved parent. */
async function realOf(abs: string, rp: RealpathFn): Promise<string> {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return normalizePath(tail.reduce(appendSeg, normalizePath(await rp(cur))));
    } catch (err) {
      const i = cur.lastIndexOf("/");
      if (!isMissing(err) || i <= 0) throw err;
      tail.unshift(cur.slice(i + 1));
      cur = cur.slice(0, i);
    }
  }
}

/** `abs` relative to `root` (case-insensitive compare). Both must be normalised. */
function relTo(abs: string, root: string): string {
  if (abs.toLowerCase() === root.toLowerCase()) return "";
  const base = root.endsWith("/") ? root : `${root}/`;
  return abs.toLowerCase().startsWith(base.toLowerCase()) ? abs.slice(base.length) : abs;
}
