/**
 * grep and get_diagnostics (spec docs/design/VSCODE-BRIDGE.md §3, §4.3).
 * grep is a pure Node walk over ctx.host: it skips node_modules/.git, symlinks,
 * secret paths (P3), binaries and oversized files, and stops at the time or visit cap.
 */
import type { Diagnostic, DiagnosticSeverity, Host } from "../host/types";
import { isSecretPath, normalizePath, resolveInWorkspace } from "../guard/paths";
import { toolError, type ToolContext, type ToolRegistry } from "./index";
import type { GetDiagnosticsArgs, GrepArgs } from "./schemas";
import { globToRegExp } from "./glob-match";
import {
  BINARY_SNIFF_BYTES,
  GREP_MAX_FILE_BYTES,
  GREP_MAX_LINE_CHARS,
  GREP_TIMEOUT_MS,
} from "./limits";

/** Characters of each line that are matched. Longer lines are cut before matching. */
const LINE_SCAN_CHARS = 10_000;
/** Directory entries visited by one grep call before it stops and reports `truncated`. */
const GREP_MAX_VISITS = 50_000;
/** Directories never entered by grep. */
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

const ABSOLUTE = /^(\/|\\|[A-Za-z]:)/;
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/** Path relative to `root` (both normalised). Returns `abs` unchanged when it is outside. */
function relTo(root: string, abs: string): string {
  if (abs === root) return ".";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Strips a trailing CR and cuts the line to GREP_MAX_LINE_CHARS for output. */
function clip(line: string): string {
  const noCr = line.endsWith("\r") ? line.slice(0, -1) : line;
  return noCr.length > GREP_MAX_LINE_CHARS ? noCr.slice(0, GREP_MAX_LINE_CHARS) : noCr;
}

/**
 * Resolves a user path (same rules as read_file) to `{abs, rel}`, where `rel` is
 * relative to the containing root. P3 applies to the lexical and the real path.
 */
async function guard(ctx: ToolContext, raw: string): Promise<{ abs: string; rel: string }> {
  const realpath = (p: string) => ctx.host.realpath(p);
  const roots = ABSOLUTE.test(raw) ? ctx.roots : [ctx.root];
  for (const root of roots) {
    const res = await resolveInWorkspace(root, raw, realpath);
    if (res.ok) {
      const normRoot = normalizePath(root);
      const rel = relTo(normRoot, res.abs);
      const real = await ctx.host.realpath(res.abs).catch(() => undefined);
      const realRoot = normalizePath(await ctx.host.realpath(normRoot).catch(() => normRoot));
      if (isSecretPath(rel) || (real !== undefined && isSecretPath(relTo(realRoot, normalizePath(real))))) {
        throw toolError("protected_path", "path is protected");
      }
      return { abs: res.abs, rel };
    }
    if (res.reason === "invalid_args") throw toolError("invalid_args", res.message);
  }
  throw toolError("outside_workspace", "path is outside the workspace");
}

async function statOrNotFound(host: Host, abs: string): Promise<{ kind: string }> {
  return host.stat(abs).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code === "ENOENT") throw toolError("not_found", "not found");
    throw err;
  });
}

/**
 * Text of a file to search, or `undefined` when it is skipped (binary, over the
 * size cap, or unreadable). A dirty editor buffer is searched in place of disk.
 */
async function readSearchable(ctx: ToolContext, abs: string): Promise<string | undefined> {
  const open = ctx.host.openDocuments.get(abs);
  if (open?.dirty) {
    if (open.text.length > GREP_MAX_FILE_BYTES || open.text.slice(0, BINARY_SNIFF_BYTES).includes("\0")) {
      return undefined;
    }
    return open.text;
  }
  const st = await ctx.host.stat(abs).catch(() => undefined);
  if (!st || st.size > GREP_MAX_FILE_BYTES) return undefined;
  const bytes = await ctx.host.readFile(abs).catch(() => undefined);
  if (!bytes || bytes.length > GREP_MAX_FILE_BYTES || isBinary(bytes)) return undefined;
  return DECODER.decode(bytes);
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
}

/** Compiles the pattern. A literal pattern is escaped; an invalid regex is `invalid_args`. */
function compileMatcher(args: GrepArgs): RegExp {
  const flags = args.caseSensitive ? "" : "i";
  const source = args.regex ? args.pattern : args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw toolError("invalid_args", `invalid regular expression: ${(err as Error).message}`);
  }
}

/** Walk state. `prefix` turns a search-relative path into a root-relative one. */
interface Scan {
  ctx: ToolContext;
  args: GrepArgs;
  re: RegExp;
  globRe?: RegExp;
  prefix: string;
  matches: GrepMatch[];
  visits: number;
  deadline: number;
  stop: boolean;
  truncated: boolean;
}

function stopScan(s: Scan): void {
  s.stop = true;
  s.truncated = true;
}

/**
 * Searches one file. `full` is the root-relative path (the output path), and
 * `name` is the path relative to the search base (what the glob filter sees).
 */
async function scanFile(s: Scan, abs: string, full: string, name: string): Promise<void> {
  if (s.stop) return;
  if (s.globRe && !s.globRe.test(name)) return;
  const text = await readSearchable(s.ctx, abs);
  if (text === undefined) return;

  const lines = text.split("\n");
  const c = s.args.context;
  for (let i = 0; i < lines.length; i++) {
    if (s.stop) return;
    if (Date.now() > s.deadline) return stopScan(s);
    const line = lines[i] ?? "";
    if (!s.re.test(line.slice(0, LINE_SCAN_CHARS))) continue;
    if (s.matches.length >= s.args.limit) return stopScan(s);

    const match: GrepMatch = { path: full, line: i + 1, text: clip(line) };
    if (c > 0) {
      match.before = lines.slice(Math.max(0, i - c), i).map(clip);
      match.after = lines.slice(i + 1, i + 1 + c).map(clip);
    }
    s.matches.push(match);
  }
}

async function walkDir(s: Scan, dirAbs: string, relPrefix: string): Promise<void> {
  const children = (await s.ctx.host.readdir(dirAbs)).slice().sort(byName);
  for (const child of children) {
    if (s.stop) return;
    if (s.ctx.signal.aborted) throw toolError("cancelled", "cancelled");
    if (++s.visits > GREP_MAX_VISITS || Date.now() > s.deadline) return stopScan(s);
    // Symlinks are not followed, so the walk cannot escape the workspace.
    if (child.kind === "symlink" || SKIPPED_DIRS.has(child.name)) continue;
    const walkRel = relPrefix ? `${relPrefix}/${child.name}` : child.name;
    const full = s.prefix + walkRel;
    if (isSecretPath(full)) continue;
    const abs = `${dirAbs}/${child.name}`;
    if (child.kind === "dir") await walkDir(s, abs, walkRel);
    else await scanFile(s, abs, full, walkRel);
  }
}

/** Searches file contents under `path` (default: the run root). Spec §3 `grep`. */
export async function grep(args: GrepArgs, ctx: ToolContext): Promise<GrepResult> {
  const re = compileMatcher(args);
  const base = await guard(ctx, args.path ?? ".");
  const st = await statOrNotFound(ctx.host, base.abs);

  const s: Scan = {
    ctx,
    args,
    re,
    prefix: base.rel === "." ? "" : `${base.rel}/`,
    matches: [],
    visits: 0,
    deadline: Date.now() + GREP_TIMEOUT_MS,
    stop: false,
    truncated: false,
  };
  if (args.glob !== undefined) s.globRe = globToRegExp(args.glob);

  if (st.kind === "dir") {
    await walkDir(s, base.abs, "");
  } else {
    const name = base.rel.slice(base.rel.lastIndexOf("/") + 1);
    await scanFile(s, base.abs, base.rel, name);
  }
  return { matches: s.matches, truncated: s.truncated };
}

// ---------------------------------------------------------------------------
// get_diagnostics
// ---------------------------------------------------------------------------

/** A host diagnostic, with `path` rewritten relative to its root. */
export type DiagnosticItem = Diagnostic;

export interface GetDiagnosticsResult {
  items: DiagnosticItem[];
  truncated: boolean;
}

/** Lower rank is more severe. The filter keeps items whose rank is at most the limit. */
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
const MAX_RANK: Record<GetDiagnosticsArgs["severity"], number> = { error: 0, warning: 1, all: 3 };

/** The root that contains `abs`, if any. */
function containingRoot(roots: readonly string[], abs: string): string | undefined {
  for (const root of roots) {
    const r = normalizePath(root);
    if (abs === r || abs.startsWith(r.endsWith("/") ? r : `${r}/`)) return r;
  }
  return undefined;
}

/** Lists diagnostics from the host, filtered by severity and path. Spec §3 `get_diagnostics`. */
export async function getDiagnostics(
  args: GetDiagnosticsArgs,
  ctx: ToolContext,
): Promise<GetDiagnosticsResult> {
  const scope = args.path === undefined ? undefined : (await guard(ctx, args.path)).abs;
  const rootNorm = normalizePath(ctx.root);
  const items: DiagnosticItem[] = [];

  for (const d of ctx.host.diagnostics() as readonly Diagnostic[]) {
    const abs = normalizePath(ABSOLUTE.test(d.path) ? d.path : `${rootNorm}/${d.path}`);
    const root = containingRoot(ctx.roots, abs);
    if (root === undefined) continue;
    if (scope !== undefined && abs !== scope && !abs.startsWith(`${scope.replace(/\/$/, "")}/`)) {
      continue;
    }
    const rel = relTo(root, abs);
    if (isSecretPath(rel)) continue;
    const rank = SEVERITY_RANK[d.severity] ?? SEVERITY_RANK.hint;
    if (rank > MAX_RANK[args.severity]) continue;

    items.push({
      path: rel,
      line: d.line,
      col: d.col,
      endLine: d.endLine,
      endCol: d.endCol,
      severity: d.severity,
      message: d.message,
      ...(d.source === undefined ? {} : { source: d.source }),
      ...(d.code === undefined ? {} : { code: d.code }),
    });
  }

  items.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line || a.col - b.col;
  });
  return { items: items.slice(0, args.limit), truncated: items.length > args.limit };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** Registers grep and get_diagnostics on `registry`. */
export function registerGrepTools(registry: ToolRegistry): void {
  registry.register("grep", grep);
  registry.register("get_diagnostics", getDiagnostics);
}
