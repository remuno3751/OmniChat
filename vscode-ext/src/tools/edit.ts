/**
 * Edit tools: write_file and edit_file (spec docs/design/VSCODE-BRIDGE.md §3, §4.3).
 *
 * Every write goes through `Host.applyEdit`, so the VS Code host can apply it as
 * one undoable WorkspaceEdit and save it. Paths are guarded by P1 (workspace),
 * P2 (`.git`) and P3 (secrets), checked lexically and after symlink resolution.
 */
import type { FileStat, Host } from "../host/types";
import { isGitInternal, isSecretPath, normalizePath, resolveInWorkspace } from "../guard/paths";
import { toolError, type ToolContext, type ToolRegistry } from "./index";
import type { EditFileArgs, WriteFileArgs } from "./schemas";
import { BINARY_SNIFF_BYTES, READ_FILE_MAX_BYTES } from "./limits";

const ENCODER = new TextEncoder();
// ignoreBOM: true keeps a leading BOM in the text, as the spec requires.
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const ABSOLUTE = /^(\/|\\|[A-Za-z]:)/;
const EDIT_LABEL = "OmniChat edit";

interface Guarded {
  /** Absolute path inside a root. */
  abs: string;
  /** Path relative to the root that contains it, with forward slashes. */
  rel: string;
}

function protectedErr(): Error {
  return toolError("protected_path", "path is protected");
}

/** Path relative to `root` (both normalised). Returns `abs` unchanged when it is outside. */
function relTo(root: string, abs: string): string {
  if (abs === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

function refusesEdit(rel: string): boolean {
  return isSecretPath(rel) || isGitInternal(rel);
}

/** P2 + P3 on the lexical path and on the symlink-resolved path. */
async function checkProtected(host: Host, root: string, abs: string): Promise<Guarded> {
  const rel = relTo(root, abs);
  if (refusesEdit(rel)) throw protectedErr();
  let real: string | undefined;
  try {
    real = await host.realpath(abs);
  } catch (err) {
    // Missing path: a file about to be created. Anything else (for example a
    // dangling symlink) is refused so it cannot redirect the write.
    if ((err as { code?: unknown } | null)?.code !== "ENOENT") {
      throw toolError("io_error", "path could not be resolved");
    }
  }
  if (real !== undefined) {
    const realRoot = normalizePath(await host.realpath(root).catch(() => root));
    if (refusesEdit(relTo(realRoot, normalizePath(real)))) throw protectedErr();
  }
  return { abs, rel };
}

/**
 * Resolves a user path. Relative paths resolve against the run's root;
 * absolute paths must lie inside one of the run's roots.
 */
async function guardEdit(ctx: ToolContext, raw: string): Promise<Guarded> {
  const realpath = (p: string) => ctx.host.realpath(p);
  const roots = ABSOLUTE.test(raw) ? ctx.roots : [ctx.root];
  for (const root of roots) {
    const res = await resolveInWorkspace(root, raw, realpath);
    if (res.ok) return checkProtected(ctx.host, normalizePath(root), res.abs);
    if (res.reason === "invalid_args") throw toolError("invalid_args", res.message);
  }
  throw toolError("outside_workspace", "path is outside the workspace");
}

/** Refusal for a file with unsaved editor changes (overwriting would drop them). */
function dirtyEditor(rel: string): Error {
  return toolError("dirty_editor", "file has unsaved editor changes", { path: rel });
}

/** Stat that returns `undefined` for a missing path. */
async function statIfExists(host: Host, abs: string): Promise<FileStat | undefined> {
  try {
    return await host.stat(abs);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export interface WriteFileResult {
  path: string;
  created: boolean;
  bytes: number;
}

export async function writeFile(args: WriteFileArgs, ctx: ToolContext): Promise<WriteFileResult> {
  const g = await guardEdit(ctx, args.path);

  const existing = await statIfExists(ctx.host, g.abs);
  if (existing?.kind === "dir") throw toolError("invalid_args", "path is a directory");
  if (existing !== undefined && ctx.host.openDocuments.get(g.abs)?.dirty) throw dirtyEditor(g.rel);

  if (!args.createDirs) {
    const parent = await statIfExists(ctx.host, g.abs.replace(/\/[^/]*$/, "") || "/");
    if (parent === undefined) throw toolError("not_found", `parent directory does not exist: ${g.rel}`);
  }

  const { created } = await ctx.host.applyEdit({
    label: EDIT_LABEL,
    path: g.abs,
    content: args.content,
  });
  return { path: g.rel, created, bytes: ENCODER.encode(args.content).length };
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export interface EditFileResult {
  path: string;
  replacements: number;
}

/** Counts non-overlapping occurrences of `needle` in `hay` (needle is non-empty). */
function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    count++;
    at = hay.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * A file is CRLF when it has `\r\n` and no bare `\n`. Such a file gets
 * `oldString`/`newString` converted to CRLF before matching. Any other file
 * (LF, or mixed) matches with LF.
 */
function eolOf(text: string): "\r\n" | "\n" {
  const crlf = countOccurrences(text, "\r\n");
  const bareLf = countOccurrences(text, "\n") - crlf;
  return crlf > 0 && bareLf === 0 ? "\r\n" : "\n";
}

function withEol(s: string, eol: "\r\n" | "\n"): string {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

export async function editFile(args: EditFileArgs, ctx: ToolContext): Promise<EditFileResult> {
  if (args.oldString === args.newString) {
    throw toolError("invalid_args", "oldString and newString are identical");
  }
  const g = await guardEdit(ctx, args.path);

  const st = await statIfExists(ctx.host, g.abs);
  if (st === undefined) throw toolError("not_found", `not found: ${g.rel}`);
  if (st.kind === "dir") throw toolError("invalid_args", "path is a directory");

  if (ctx.host.openDocuments.get(g.abs)?.dirty) throw dirtyEditor(g.rel);

  if (st.size > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
  const bytes = await ctx.host.readFile(g.abs);
  if (bytes.length > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
  if (bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES)).includes(0)) {
    throw toolError("binary_file", "file is binary");
  }

  const text = DECODER.decode(bytes);
  const eol = eolOf(text);
  const needle = withEol(args.oldString, eol);
  const replacement = withEol(args.newString, eol);

  const count = countOccurrences(text, needle);
  if (count === 0) throw toolError("not_found", "oldString not found");
  if (count > 1 && !args.replaceAll) {
    throw toolError("not_unique", "oldString matches more than once", { count });
  }

  const content = args.replaceAll
    ? text.split(needle).join(replacement)
    : text.replace(needle, () => replacement);

  await ctx.host.applyEdit({ label: EDIT_LABEL, path: g.abs, content });
  return { path: g.rel, replacements: args.replaceAll ? count : 1 };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Registers write_file and edit_file on `registry`. */
export function registerEditTools(registry: ToolRegistry): void {
  registry.register("write_file", writeFile);
  registry.register("edit_file", editFile);
}
