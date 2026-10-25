/**
 * Read-only file tools: read_file, list_dir, glob (spec docs/design/VSCODE-BRIDGE.md §3, §4.3).
 *
 * Every `path` goes through resolveInWorkspace. Secret paths (P3) are refused
 * with `protected_path`, both lexically and after symlink resolution.
 */
import type { Host } from "../host/types";
import { openDocumentFor, relUnder } from "../host/vscode";
import { isSecretPath, normalizePath, resolveInWorkspace } from "../guard/paths";
import { outsideCandidate, outsideRefusal } from "../guard/outside";
import { toolError, type ToolContext, type ToolRegistry } from "./index";
import type { GlobArgs, ListDirArgs, ReadFileArgs } from "./schemas";
import { globToRegExp } from "./glob-match";
import {
  BINARY_SNIFF_BYTES,
  LIST_DIR_MAX_ENTRIES,
  READ_FILE_MAX_BYTES,
} from "./limits";

/** UTF-8 bytes of content returned by one read_file call. Keeps the result under the 256 KB cap. */
const READ_OUTPUT_BUDGET_BYTES = 192 * 1024;
/** Directory entries visited by one glob call before it stops and reports `truncated`. */
const GLOB_MAX_VISITS = 50_000;
/** Directories never entered by list_dir (depth > 1) or glob. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

const ENCODER = new TextEncoder();
// ignoreBOM: true keeps a leading BOM in the text, as the spec requires.
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const ABSOLUTE = /^(\/|\\|[A-Za-z]:)/;

interface Guarded {
  /** Absolute path inside a root. */
  abs: string;
  /** Path relative to the root that contains it, with forward slashes. */
  rel: string;
}

function protectedErr(): Error {
  return toolError("protected_path", "path is protected");
}

/** P3 on the lexical path and on the symlink-resolved path. */
async function checkSecret(host: Host, root: string, abs: string): Promise<Guarded> {
  const rel = relUnder(root, abs);
  if (isSecretPath(rel)) throw protectedErr();
  const real = await host.realpath(abs).catch(() => undefined);
  if (real !== undefined) {
    const realRoot = normalizePath(await host.realpath(root).catch(() => root));
    if (isSecretPath(relUnder(realRoot, normalizePath(real)))) throw protectedErr();
  }
  return { abs, rel };
}

/**
 * Resolves a user path. Relative paths resolve against the run's root;
 * absolute paths must lie inside one of the run's roots.
 * Failures: invalid_args (bad form) or outside_workspace (everything else).
 */
async function guard(ctx: ToolContext, raw: string): Promise<Guarded> {
  const realpath = (p: string) => ctx.host.realpath(p);
  const roots = ABSOLUTE.test(raw) ? ctx.roots : [ctx.root];
  let onlyOutside = true;
  for (const root of roots) {
    const res = await resolveInWorkspace(root, raw, realpath);
    if (res.ok) return checkSecret(ctx.host, normalizePath(root), res.abs);
    if (res.reason === "invalid_args") throw toolError("invalid_args", res.message);
    if (res.reason !== "outside_workspace") onlyOutside = false;
  }
  if (ctx.allowOutside && onlyOutside) {
    const abs = outsideCandidate(ctx.root, raw);
    if (abs !== null) {
      if ((await outsideRefusal(abs, realpath, false)) !== null) throw protectedErr();
      return { abs, rel: abs };
    }
  }
  throw toolError("outside_workspace", "path is outside the workspace");
}

async function statOrNotFound(host: Host, g: Guarded): Promise<{ kind: string; size: number }> {
  try {
    return await host.stat(g.abs);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") {
      throw toolError("not_found", `not found: ${g.rel}`);
    }
    throw err;
  }
}

function joinAbs(dir: string, name: string): string {
  return `${dir.replace(/[\\/]$/, "")}/${name}`;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export interface ReadFileResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export async function readFile(args: ReadFileArgs, ctx: ToolContext): Promise<ReadFileResult> {
  const g = await guard(ctx, args.path);
  const st = await statOrNotFound(ctx.host, g);
  if (st.kind === "dir") throw toolError("invalid_args", "path is a directory");

  // A dirty editor buffer is the source of truth (spec: "開いている dirty バッファ").
  const open = openDocumentFor(ctx.host.openDocuments, g.abs);
  let text: string;
  if (open?.dirty) {
    if (ENCODER.encode(open.text).length > READ_FILE_MAX_BYTES) {
      throw toolError("too_large", "file is larger than 5 MB");
    }
    if (open.text.slice(0, BINARY_SNIFF_BYTES).includes("\0")) {
      throw toolError("binary_file", "file is binary");
    }
    text = open.text;
  } else {
    if (st.size > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
    const bytes = await ctx.host.readFile(g.abs);
    if (bytes.length > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
    if (isBinary(bytes)) throw toolError("binary_file", "file is binary");
    text = DECODER.decode(bytes);
  }

  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;

  const start = args.offset;
  const end = Math.min(total, start - 1 + args.limit);
  const picked: string[] = [];
  let used = 0;
  let partial = false;
  for (let i = start - 1; i < end; i++) {
    const line = lines[i] ?? "";
    const cost = ENCODER.encode(line).length + 1;
    if (used + cost > READ_OUTPUT_BUDGET_BYTES) {
      // A single line over the budget is cut so the call still makes progress.
      if (picked.length === 0) {
        picked.push(line.slice(0, Math.floor(READ_OUTPUT_BUDGET_BYTES / 4)));
        partial = true;
      }
      break;
    }
    picked.push(line);
    used += cost;
  }

  const endLine = start - 1 + picked.length;
  return {
    path: g.rel,
    content: picked.join("\n"),
    startLine: start,
    endLine,
    totalLines: total,
    truncated: endLine < total || partial,
  };
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

interface ListEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  size?: number;
}

export interface ListDirResult {
  entries: ListEntry[];
  truncated: boolean;
}

export async function listDir(args: ListDirArgs, ctx: ToolContext): Promise<ListDirResult> {
  const g = await guard(ctx, args.path);
  const st = await statOrNotFound(ctx.host, g);
  if (st.kind !== "dir") throw toolError("invalid_args", "path is not a directory");

  const entries: ListEntry[] = [];
  let truncated = false;

  // Depth-first, children in name order. Symlinks are listed but never entered.
  const walk = async (dirAbs: string, relPrefix: string, depthLeft: number): Promise<void> => {
    const children = (await ctx.host.readdir(dirAbs)).slice().sort(byName);
    for (const child of children) {
      if (ctx.signal.aborted) throw toolError("cancelled", "cancelled");
      if (!args.includeHidden && child.name.startsWith(".")) continue;
      const rel = relPrefix ? `${relPrefix}/${child.name}` : child.name;
      if (isSecretPath(rel)) continue;
      if (entries.length >= LIST_DIR_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const childAbs = joinAbs(dirAbs, child.name);
      const entry: ListEntry = { path: rel, type: child.kind };
      if (child.kind === "file") {
        const size = await ctx.host.stat(childAbs).then((s) => s.size).catch(() => undefined);
        if (size !== undefined) entry.size = size;
      }
      entries.push(entry);
      if (child.kind === "dir" && depthLeft > 1 && !SKIPPED_DIRS.has(child.name)) {
        await walk(childAbs, rel, depthLeft - 1);
      }
    }
  };

  await walk(g.abs, g.rel === "." ? "" : g.rel, args.depth);
  return { entries, truncated };
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

export interface GlobResult {
  files: string[];
  truncated: boolean;
}

export async function glob(args: GlobArgs, ctx: ToolContext): Promise<GlobResult> {
  const base = await guard(ctx, args.path ?? ".");
  const st = await statOrNotFound(ctx.host, base);
  if (st.kind !== "dir") throw toolError("invalid_args", "path is not a directory");

  const re = globToRegExp(args.pattern);
  const outPrefix = base.rel === "." ? "" : `${base.rel}/`;
  const matches: string[] = [];
  let visits = 0;
  let truncated = false;

  // Symlinks are not followed, so the walk cannot escape the workspace.
  const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
    const children = (await ctx.host.readdir(dirAbs)).slice().sort(byName);
    for (const child of children) {
      if (ctx.signal.aborted) throw toolError("cancelled", "cancelled");
      if (++visits > GLOB_MAX_VISITS) {
        truncated = true;
        return;
      }
      if (SKIPPED_DIRS.has(child.name)) continue;
      const rel = relPrefix ? `${relPrefix}/${child.name}` : child.name;
      if (child.kind === "dir") {
        await walk(joinAbs(dirAbs, child.name), rel);
      } else if (child.kind === "file" && re.test(rel) && !isSecretPath(rel)) {
        matches.push(rel);
      }
    }
  };

  await walk(base.abs, "");
  matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = matches.slice(0, args.limit).map((m) => `${outPrefix}${m}`);
  return { files, truncated: truncated || matches.length > args.limit };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Registers read_file, list_dir and glob on `registry`. */
export function registerFileTools(registry: ToolRegistry): void {
  registry.register("read_file", readFile);
  registry.register("list_dir", listDir);
  registry.register("glob", glob);
}
