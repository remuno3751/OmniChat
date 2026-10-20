// Read-only access to the working folder for Code preview (protocol: BRIDGE-v2.md, section C).
// The bridge is the last gate: every rule below is enforced here, whatever the server sends.
// dsh-plugin/dist/fsread.js is a JS copy of this file; both are checked by the same test cases.
import fs from "node:fs";
import path from "node:path";

export const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;
export const LIST_MAX_ENTRIES = 2000;
export const PREVIEW_RATE_PER_SEC = 20;
export const PREVIEW_MAX_CONCURRENT = 4;

const READ_TYPES = new Map<string, string>([
  [".html", "text/html"], [".htm", "text/html"], [".css", "text/css"],
  [".js", "text/javascript"], [".mjs", "text/javascript"], [".json", "application/json"],
  [".svg", "image/svg+xml"], [".txt", "text/plain"], [".md", "text/markdown"], [".csv", "text/csv"],
  [".xml", "application/xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
  [".mp3", "audio/mpeg"], [".wav", "audio/wav"], [".ogg", "audio/ogg"], [".mp4", "video/mp4"], [".webm", "video/webm"],
]);

const DENY_SUFFIX = [".pem", ".key", ".p12", ".pfx", ".keystore", ".env"];
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export interface FsEntry { name: string; kind: "file" | "dir"; size: number }
export type FsListResult = { ok: true; entries: FsEntry[]; truncated: boolean } | { ok: false; error: string };
export type FsReadResult =
  | { ok: true; content: string; size: number; mime: string; truncated: boolean }
  | { ok: false; error: string };

/** Secret-looking file names (never listed, never read). */
export function isDenied(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith(".env")) return true;
  if (DENY_SUFFIX.some((s) => n.endsWith(s))) return true;
  if (n.startsWith("id_rsa") || n.startsWith("id_ed25519")) return true;
  return n.includes("credential") || n.includes("secret");
}

/** One path segment: no hidden names, no node_modules, no secrets, no ADS/wildcards, no device names. */
function segmentOk(seg: string): boolean {
  if (!seg || seg === "." || seg === ".." || seg.startsWith(".")) return false;
  if (seg.toLowerCase() === "node_modules" || isDenied(seg)) return false;
  if (RESERVED_NAME.test(seg.split(".")[0] ?? "")) return false;
  if (/[:*?"<>|]/.test(seg) || /[. ]$/.test(seg)) return false;
  return true;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function isInside(root: string, p: string): boolean {
  const r = fold(path.resolve(root));
  const x = fold(path.resolve(p));
  if (x === r) return true;
  const rel = path.relative(r, x);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/** Every segment of `real` (relative to the root) passes segmentOk. */
function relOk(root: string, real: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(real));
  return rel === "" || rel.split(path.sep).every(segmentOk);
}

export type Resolved =
  | { ok: true; root: string; abs: string; real: string; rel: string }
  | { ok: false; error: string };

/**
 * Maps a relative path (forward or back slashes) to a real path inside `cwd`.
 * "" means the working folder itself. Refuses `..`, absolute paths, drive letters, UNC, `\\?\`, NUL,
 * and anything whose real location (after symlinks and junctions) is outside `cwd`.
 */
export function resolveSafe(cwd: string, relPath: unknown): Resolved {
  if (typeof relPath !== "string" || relPath.length > 1024 || relPath.includes("\0")) return { ok: false, error: "invalid path" };
  if (/^[\\/]/.test(relPath) || /^[a-zA-Z]:/.test(relPath)) return { ok: false, error: "path not allowed" };
  const trimmed = relPath.replace(/[\\/]+$/, "");
  const segs = trimmed === "" ? [] : trimmed.split(/[\\/]/);
  if (!segs.every(segmentOk)) return { ok: false, error: "path not allowed" };
  let root: string;
  try {
    root = fs.realpathSync.native(path.resolve(cwd));
  } catch {
    return { ok: false, error: "workspace unavailable" };
  }
  const abs = path.join(root, ...segs);
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!isInside(root, real) || !relOk(root, real)) return { ok: false, error: "path not allowed" };
  return { ok: true, root, abs, real, rel: path.relative(root, real).split(path.sep).join("/") };
}

/** Lists a folder: hidden, denied and node_modules entries are left out; at most LIST_MAX_ENTRIES. */
export function listDir(cwd: string, rel: unknown): FsListResult {
  const r = resolveSafe(cwd, rel === undefined ? "" : rel);
  if (!r.ok) return r;
  let st: fs.Stats;
  try {
    st = fs.statSync(r.real);
  } catch {
    return { ok: false, error: "not found" };
  }
  if (!st.isDirectory()) return { ok: false, error: "not a directory" };
  let names: string[];
  try {
    names = fs.readdirSync(r.real).sort();
  } catch {
    return { ok: false, error: "cannot read directory" };
  }
  const entries: FsEntry[] = [];
  let more = false;
  for (const name of names) {
    if (!segmentOk(name)) continue;
    let child: string;
    let cs: fs.Stats;
    try {
      child = fs.realpathSync.native(path.join(r.real, name));
      cs = fs.statSync(child);
    } catch {
      continue;
    }
    if (!isInside(r.root, child) || !relOk(r.root, child)) continue;
    if (cs.isDirectory()) entries.push({ name, kind: "dir", size: 0 });
    else if (cs.isFile()) entries.push({ name, kind: "file", size: cs.size });
    else continue;
    if (entries.length > LIST_MAX_ENTRIES) {
      more = true;
      entries.pop();
      break;
    }
  }
  entries.sort((a, b) => (a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === "dir" ? -1 : 1));
  return { ok: true, entries, truncated: more };
}

function normMax(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) return PREVIEW_MAX_BYTES;
  return Math.min(v, PREVIEW_MAX_BYTES);
}

/** Reads one allowed regular file (base64). Over `maxBytes` (max 3 MB) only the head is returned, with truncated: true. */
export function readFile(cwd: string, rel: unknown, maxBytes?: unknown): FsReadResult {
  const r = resolveSafe(cwd, rel);
  if (!r.ok) return r;
  if (r.rel === "") return { ok: false, error: "not a file" };
  let regular = false;
  try {
    regular = fs.statSync(r.real).isFile();
  } catch {
    regular = false;
  }
  if (!regular) return { ok: false, error: "not a file" };
  const mime = READ_TYPES.get(path.extname(r.real).toLowerCase());
  if (!mime) return { ok: false, error: "file type not allowed" };
  const limit = normMax(maxBytes);
  let fd: number;
  try {
    fd = fs.openSync(r.real, "r");
  } catch {
    return { ok: false, error: "cannot open file" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, error: "not a file" };
    // Re-check after open: the path must still lead to the same file, inside the folder (TOCTOU guard).
    let again: string;
    let ag: fs.Stats;
    try {
      again = fs.realpathSync.native(r.abs);
      ag = fs.statSync(again);
    } catch {
      return { ok: false, error: "file changed while reading" };
    }
    if (!isInside(r.root, again) || !relOk(r.root, again) || ag.dev !== st.dev || ag.ino !== st.ino) {
      return { ok: false, error: "file changed while reading" };
    }
    const want = Math.min(st.size, limit);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const n = fs.readSync(fd, buf, off, want - off, off);
      if (n <= 0) break;
      off += n;
    }
    return {
      ok: true,
      content: buf.subarray(0, off).toString("base64"),
      size: st.size,
      mime,
      truncated: st.size > limit,
    };
  } catch {
    return { ok: false, error: "read failed" };
  } finally {
    fs.closeSync(fd);
  }
}

/** Rate and concurrency limit for fs requests: PREVIEW_RATE_PER_SEC per second, PREVIEW_MAX_CONCURRENT at once. */
export class FsLimiter {
  private stamps: number[] = [];
  private active = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly perSec = PREVIEW_RATE_PER_SEC,
    private readonly maxActive = PREVIEW_MAX_CONCURRENT,
  ) {}

  /** Returns a release function when admitted, or null when refused. */
  admit(): (() => void) | null {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 1000);
    if (this.stamps.length >= this.perSec || this.active >= this.maxActive) return null;
    this.stamps.push(t);
    this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
    };
  }
}
