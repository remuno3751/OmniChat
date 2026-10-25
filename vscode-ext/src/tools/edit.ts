/**
 * Edit tools: write_file and edit_file (spec docs/design/VSCODE-BRIDGE.md §3, §4.3).
 *
 * Every write goes through `Host.applyEdit`, so the VS Code host can apply it as
 * one undoable WorkspaceEdit and save it. Paths are guarded by P1 (workspace),
 * P2 (`.git`) and P3 (secrets), checked lexically and after symlink resolution.
 */
import type { FileEdit, FileStat, Host } from "../host/types";
import { openDocumentFor, relUnder } from "../host/vscode";
import { isGitInternal, isSecretPath, normalizePath, resolveInWorkspace } from "../guard/paths";
import { outsideCandidate, outsideRefusal } from "../guard/outside";
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

function refusesEdit(rel: string): boolean {
  return isSecretPath(rel) || isGitInternal(rel);
}

/** P2 + P3 on the lexical path and on the symlink-resolved path. */
async function checkProtected(host: Host, root: string, abs: string): Promise<Guarded> {
  const rel = relUnder(root, abs);
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
    if (refusesEdit(relUnder(realRoot, normalizePath(real)))) throw protectedErr();
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
  let onlyOutside = true;
  for (const root of roots) {
    const res = await resolveInWorkspace(root, raw, realpath);
    if (res.ok) return checkProtected(ctx.host, normalizePath(root), res.abs);
    if (res.reason === "invalid_args") throw toolError("invalid_args", res.message);
    if (res.reason !== "outside_workspace") onlyOutside = false;
  }
  if (ctx.allowOutside && onlyOutside) {
    const abs = outsideCandidate(ctx.root, raw);
    if (abs !== null) {
      if ((await outsideRefusal(abs, realpath, true)) !== null) throw protectedErr();
      return { abs, rel: abs };
    }
  }
  throw toolError("outside_workspace", "path is outside the workspace");
}

/** Refusal for a file with unsaved editor changes (overwriting would drop them). */
function dirtyEditor(rel: string): Error {
  return toolError("dirty_editor", "file has unsaved editor changes", { path: rel });
}

/**
 * Runs `host.applyEdit` and turns its failure into a tool error that carries the
 * real reason. The generic mapper in tools/index.ts hides raw messages.
 */
async function hostApply(host: Host, edit: FileEdit): Promise<{ created: boolean }> {
  try {
    return await host.applyEdit(edit);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ENOENT") throw toolError("not_found", "not found");
    const reason = err instanceof Error ? err.message : String(err);
    throw toolError(
      "io_error",
      `write failed: ${reason}`,
      typeof code === "string" ? { code } : undefined,
    );
  }
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
  if (existing !== undefined && openDocumentFor(ctx.host.openDocuments, g.abs)?.dirty) {
    throw dirtyEditor(g.rel);
  }

  if (!args.createDirs) {
    const parent = await statIfExists(ctx.host, g.abs.replace(/\/[^/]*$/, "") || "/");
    if (parent === undefined) throw toolError("not_found", `parent directory does not exist: ${g.rel}`);
  }

  const { created } = await hostApply(ctx.host, {
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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The dominant line ending: CRLF when `\r\n` outnumbers bare `\n`, LF otherwise.
 * Only inserted text takes this ending; untouched lines keep their own bytes.
 */
function dominantEol(text: string): "\r\n" | "\n" {
  const crlf = text.split("\r\n").length - 1;
  const bareLf = text.split("\n").length - 1 - crlf;
  return crlf > bareLf ? "\r\n" : "\n";
}

/**
 * Pattern for `oldString` that matches the file whatever its line endings: each
 * line break in the needle also matches `\r\n`, so mixed CRLF/LF files match.
 */
function eolInsensitive(oldString: string, flags: string): RegExp {
  const src = oldString.replace(/\r\n/g, "\n").split("\n").map(escapeRe).join("\\r?\\n");
  return new RegExp(src, flags);
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

  if (openDocumentFor(ctx.host.openDocuments, g.abs)?.dirty) throw dirtyEditor(g.rel);

  if (st.size > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
  const bytes = await ctx.host.readFile(g.abs);
  if (bytes.length > READ_FILE_MAX_BYTES) throw toolError("too_large", "file is larger than 5 MB");
  if (bytes.subarray(0, Math.min(bytes.length, BINARY_SNIFF_BYTES)).includes(0)) {
    throw toolError("binary_file", "file is binary");
  }

  const text = DECODER.decode(bytes);
  const replacement = withEol(args.newString, dominantEol(text));

  const count = (text.match(eolInsensitive(args.oldString, "g")) ?? []).length;
  if (count === 0) throw toolError("not_found", "oldString not found");
  if (count > 1 && !args.replaceAll) {
    throw toolError("not_unique", "oldString matches more than once", { count });
  }

  const content = args.replaceAll
    ? text.replace(eolInsensitive(args.oldString, "g"), () => replacement)
    : text.replace(eolInsensitive(args.oldString, ""), () => replacement);

  await hostApply(ctx.host, { label: EDIT_LABEL, path: g.abs, content });
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
