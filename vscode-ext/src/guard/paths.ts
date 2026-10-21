/**
 * Path guard for the VS Code tools (spec §3 common rules, §4.3 P1-P3).
 *
 * Pure string logic: no `vscode` or `node:` imports. Symlink resolution is
 * injected as `realpath`, so tests can use a fake filesystem.
 *
 * Paths are normalised to forward slashes. Windows drive (`C:/x`) and UNC
 * (`//srv/share/x`) forms are "Windows-style". They never match a POSIX root.
 * Comparisons are case-insensitive only when the root is Windows-style.
 */

export type PathRefusalReason = "invalid_args" | "outside_workspace" | "io_error";

export type ResolveResult =
  | { ok: true; abs: string }
  | { ok: false; reason: PathRefusalReason; message: string };

export type RealpathFn = (p: string) => Promise<string>;

const MAX_PATH_LENGTH = 4096;
const MAX_COMPONENT_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
// Home-relative forms are "outside the roots" per spec §4.3.
const HOME_PREFIX = /^(~|\$HOME|%USERPROFILE%)/i;

interface Parts {
  prefix: string;
  absolute: boolean;
  segments: string[];
}

/** Splits into a root prefix (drive or UNC), absolute flag and clean segments. */
function split(input: string): Parts {
  let s = input.replace(/\\/g, "/");
  let prefix = "";
  let absolute = false;

  const drive = /^[A-Za-z]:/.exec(s);
  const unc = !drive ? /^\/\/[^/]+(?:\/[^/]+)?/.exec(s) : null;
  if (drive) {
    prefix = drive[0];
    absolute = true;
    s = s.slice(2);
  } else if (unc) {
    prefix = unc[0];
    absolute = true;
    s = s.slice(unc[0].length);
  } else if (s.startsWith("/")) {
    absolute = true;
  }

  const segments: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      } // absolute: `/..` clamps to the root, as the OS does
      continue;
    }
    segments.push(seg);
  }
  return { prefix, absolute, segments };
}

/**
 * Lexical normalisation: `\` to `/`, resolves `.` and `..`, drops trailing `/`.
 * Does not check roots and does not touch the filesystem. A relative result
 * may start with `..`, which the caller must treat as an escape.
 */
export function normalizePath(input: string): string {
  const { prefix, absolute, segments } = split(input);
  const body = segments.join("/");
  return absolute ? `${prefix}/${body}` : body;
}

function isWindowsStyle(normalized: string): boolean {
  return /^[A-Za-z]:/.test(normalized) || normalized.startsWith("//");
}

/** True when `child` equals `root` or lies beneath it. Both must be normalised. */
function isWithin(child: string, root: string): boolean {
  if (isWindowsStyle(child) !== isWindowsStyle(root)) return false;
  const ci = isWindowsStyle(root);
  const c = ci ? child.toLowerCase() : child;
  const r = ci ? root.toLowerCase() : root;
  if (c === r) return true;
  const base = r.endsWith("/") ? r : `${r}/`;
  return c.startsWith(base);
}

function joinSegs(base: string, segs: readonly string[]): string {
  if (segs.length === 0) return base;
  return `${base.endsWith("/") ? base : `${base}/`}${segs.join("/")}`;
}

function isMissing(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolves `candidate` (lexically inside `root`) through symlinks. Each prefix
 * is realpath'd in turn. Once a component is missing (a file about to be
 * created), the remaining components are appended to the resolved parent.
 * Caveat: a dangling symlink also reports ENOENT, so the injected realpath
 * should not be a plain fs.realpath for paths that might be dangling links.
 */
async function resolveExisting(
  root: string,
  realRoot: string,
  candidate: string,
  realpath: RealpathFn,
): Promise<string> {
  const base = root.endsWith("/") ? root : `${root}/`;
  const rest = candidate.slice(base.length).split("/").filter((s) => s !== "");
  let real = realRoot;
  for (let i = 0; i < rest.length; i++) {
    const lex = joinSegs(root, rest.slice(0, i + 1));
    try {
      real = normalizePath(await realpath(lex));
    } catch (err) {
      if (!isMissing(err)) throw err;
      return normalizePath(joinSegs(real, rest.slice(i)));
    }
  }
  return real;
}

function refuse(reason: PathRefusalReason, message: string): ResolveResult {
  return { ok: false, reason, message };
}

/**
 * Resolves a user-supplied path to an absolute path inside `root`.
 *
 * Refuses (spec P1 "outside"):
 * - `..` escapes and absolute paths outside `root` (case-sensitive for POSIX
 *   roots, case-insensitive for Windows-style roots);
 * - `~`, `$HOME` and `%USERPROFILE%` prefixes;
 * - Windows drive and UNC paths when `root` is POSIX;
 * - symlinks whose realpath lies outside the realpath of `root`.
 *
 * Also refuses NUL and control characters, paths over 4096 characters and
 * components over 255 characters (`invalid_args`).
 */
export async function resolveInWorkspace(
  root: string,
  userPath: string,
  realpath: RealpathFn,
): Promise<ResolveResult> {
  if (typeof root !== "string" || typeof userPath !== "string") {
    return refuse("invalid_args", "path must be a string");
  }
  if (userPath.length > MAX_PATH_LENGTH) return refuse("invalid_args", "path is too long");
  if (CONTROL_CHARS.test(userPath)) {
    return refuse("invalid_args", "path contains control characters");
  }
  if (userPath.split(/[\\/]/).some((seg) => seg.length > MAX_COMPONENT_LENGTH)) {
    return refuse("invalid_args", "path component is too long");
  }
  if (HOME_PREFIX.test(userPath)) {
    return refuse("outside_workspace", "home-relative paths are outside the workspace");
  }

  const normRoot = normalizePath(root);
  if (!split(normRoot).absolute) return refuse("invalid_args", "workspace root must be absolute");

  const rootSlash = normRoot.endsWith("/") ? normRoot : `${normRoot}/`;
  const candidate = split(userPath).absolute
    ? normalizePath(userPath)
    : normalizePath(rootSlash + userPath);

  if (!isWithin(candidate, normRoot)) {
    return refuse("outside_workspace", "path is outside the workspace");
  }

  try {
    const realRoot = normalizePath(await realpath(normRoot));
    const real = await resolveExisting(normRoot, realRoot, candidate, realpath);
    if (!isWithin(real, realRoot)) {
      return refuse("outside_workspace", "path resolves outside the workspace");
    }
    return { ok: true, abs: candidate };
  } catch {
    return refuse("io_error", "path could not be resolved");
  }
}

const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const SECRET_PATH_RULES: readonly RegExp[] = [
  /(^|\/)\.(ssh|gnupg|aws|kube)(\/|$)/,
  /(^|\/)(\.npmrc|\.netrc|\.git-credentials|\.docker\/config\.json)$/,
];

/**
 * Spec §4.3 P3: secret-looking paths, which are protected for both read and
 * edit. `relPath` may be relative or absolute.
 */
export function isSecretPath(relPath: string): boolean {
  const p = normalizePath(relPath);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/^\.env(\..+)?$/.test(base) && !ENV_TEMPLATES.has(base)) return true;
  if (/\.(pem|key|p12|pfx|ppk)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) return true;
  return SECRET_PATH_RULES.some((rule) => rule.test(p));
}

/** Spec §4.3 P2: `.git` files or directories (including submodule and worktree `.git` files). */
export function isGitInternal(relPath: string): boolean {
  return /(^|\/)\.git(\/|$)/.test(normalizePath(relPath));
}
