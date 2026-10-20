/* Server bundle: validation of an unpacked bundle folder and zip-slip safe extraction of a bundle zip.
   Plain fs + jszip. Must not import db.ts: boot.ts uses this module before the database opens. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { UpdateErr } from "./github.js";
import { compareVersions, parseVersion } from "./semver.js";

/** Host contract version. A bundle with a larger minHostEpoch needs the full installer. */
export const HOST_EPOCH = 1;
export const DEFAULT_MIN_NODE = "24.0.0";
/** Limits for an extracted bundle (a release bundle is a few tens of MB). */
const MAX_ENTRIES = 200_000;
const MAX_UNCOMPRESSED = 1.5 * 1024 ** 3;
/** Files that must exist for a bundle to start. */
const REQUIRED = ["dist/index.js", "dist/boot.js", "package.json"] as const;

export const bundleAssetName = (ver: string): string => `omnichat-server-bundle-${ver}.zip`;

export interface BundleManifest { version: string; minNode: string; minHostEpoch: number }
export type BundleCheck = { ok: true; manifest: BundleManifest } | { ok: false; reason: string };

const clip = (s: string): string => s.slice(0, 120);
const bad = (reason: string): BundleCheck => ({ ok: false, reason });
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Checks an unpacked bundle folder. `expectVersion` (optional) must match the bundle version exactly.
 * Version source: bundle.json (preferred) and/or the VERSION file; both must agree when both exist.
 */
export function validateBundleDir(dir: string, expectVersion?: string): BundleCheck {
  for (const rel of REQUIRED) {
    if (!isFile(join(dir, rel))) return bad(`missing ${rel}`);
  }

  let bj: Record<string, unknown> | null = null;
  if (isFile(join(dir, "bundle.json"))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"));
      if (!isObj(parsed)) return bad("bundle.json is not an object");
      bj = parsed;
    } catch {
      return bad("bundle.json is not valid JSON");
    }
  }
  const fileVer = isFile(join(dir, "VERSION")) ? readFileSync(join(dir, "VERSION"), "utf8").trim() : null;
  if (!bj && fileVer === null) return bad("missing bundle.json and VERSION");

  const jsonVer = bj && typeof bj.version === "string" ? bj.version : null;
  if (jsonVer !== null && fileVer !== null && fileVer !== jsonVer) return bad("VERSION and bundle.json disagree");
  const version = jsonVer ?? fileVer ?? "";
  if (!version) return bad("bundle version is empty");
  if (!parseVersion(version)) return bad(`invalid bundle version "${clip(version)}"`);
  if (expectVersion !== undefined && version !== expectVersion) {
    return bad(`bundle is ${clip(version)}, expected ${clip(expectVersion)}`);
  }

  const minNode = bj?.minNode === undefined ? DEFAULT_MIN_NODE : bj.minNode;
  if (typeof minNode !== "string") return bad("bundle.json minNode must be a string");
  const minHostEpoch = bj?.minHostEpoch === undefined ? 1 : bj.minHostEpoch;
  if (typeof minHostEpoch !== "number" || !Number.isInteger(minHostEpoch) || minHostEpoch < 1) {
    return bad("bundle.json minHostEpoch must be a positive integer");
  }
  try {
    if (compareVersions(process.versions.node, minNode) < 0) {
      return bad(`needs Node ${clip(minNode)} or newer (running ${process.versions.node})`);
    }
  } catch {
    return bad(`invalid minNode "${clip(minNode)}"`);
  }
  if (minHostEpoch > HOST_EPOCH) return bad("needs the full installer (host epoch too old)");

  return { ok: true, manifest: { version, minNode, minHostEpoch } };
}

/** Rejects any entry name that could leave the target folder or name a special file. Returns the safe path segments. */
function safeSegments(name: string): string[] {
  const unsafe = (): never => { throw new UpdateErr("bundle-invalid", `unsafe entry name in bundle: "${clip(name)}"`); };
  if (name.includes("\\") || name.includes("\0")) unsafe();
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) unsafe();
  const parts = name.split("/");
  if (parts[parts.length - 1] === "") parts.pop(); // directory marker
  if (parts.length === 0) unsafe();
  for (const p of parts) {
    // no empty, "." or ".." segments; no ":" (drive letters and NTFS streams)
    if (p === "" || p === "." || p === ".." || p.includes(":")) unsafe();
  }
  return parts;
}

/** Declared uncompressed size of a loaded entry (internal JSZip field; 0 when unavailable). */
function declaredSize(f: JSZip.JSZipObject): number {
  const d = (f as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  return typeof d?.uncompressedSize === "number" && Number.isFinite(d.uncompressedSize) ? d.uncompressedSize : 0;
}

function isSymlink(f: JSZip.JSZipObject): boolean {
  const mode = (f as unknown as { unixPermissions?: unknown }).unixPermissions;
  return typeof mode === "number" && (mode & 0o170000) === 0o120000;
}

function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== "EPERM" && code !== "EBUSY")) throw e;
      // Windows may refuse a rename while an antivirus scan holds the folder: short wait, then retry
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/**
 * Extracts a bundle zip into `<updatesDir>/bundles/<version>.tmp`, validates it, then renames it to `<updatesDir>/bundles/<version>`.
 * Every entry is checked before anything is written: absolute paths, "..", backslashes, drive letters and symlinks are refused.
 * On any failure the temporary folder is removed and nothing else changes. Throws UpdateErr("bundle-invalid").
 */
export async function stageBundle(opts: { zipFile: string; version: string; updatesDir: string }): Promise<{ dir: string }> {
  const { zipFile, version, updatesDir } = opts;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version) || version.includes("..") || !parseVersion(version)) {
    throw new UpdateErr("bundle-invalid", `unsafe bundle version "${clip(version)}"`);
  }
  const bundles = join(updatesDir, "bundles");
  const tmp = join(bundles, `${version}.tmp`);
  const dest = join(bundles, version);
  mkdirSync(bundles, { recursive: true, mode: 0o700 });
  rmSync(tmp, { recursive: true, force: true });

  try {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readFileSync(zipFile));
    } catch {
      throw new UpdateErr("bundle-invalid", "bundle is not a valid zip file");
    }
    const names = Object.keys(zip.files);
    if (names.length > MAX_ENTRIES) throw new UpdateErr("bundle-invalid", "bundle has too many entries");

    // Pass 1: validate every entry before writing anything.
    const plan: { segs: string[]; file: JSZip.JSZipObject }[] = [];
    let declared = 0;
    for (const name of names) {
      const file = zip.files[name];
      const segs = safeSegments(name);
      if (isSymlink(file)) throw new UpdateErr("bundle-invalid", `symlink refused in bundle: "${clip(name)}"`);
      if (!file.dir) declared += declaredSize(file);
      if (declared > MAX_UNCOMPRESSED) throw new UpdateErr("bundle-invalid", "bundle is too large when unpacked");
      plan.push({ segs, file });
    }

    // Pass 2: write inside the temporary folder only.
    const root = resolve(tmp);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let written = 0;
    for (const { segs, file } of plan) {
      const target = resolve(root, ...segs);
      const rel = relative(root, target);
      if (rel === "" && !file.dir) throw new UpdateErr("bundle-invalid", "bundle entry resolves to the root");
      if (rel.startsWith("..") || isAbsolute(rel)) throw new UpdateErr("bundle-invalid", "bundle entry escapes the bundle folder");
      if (file.dir) {
        mkdirSync(target, { recursive: true });
        continue;
      }
      const buf = await file.async("nodebuffer");
      written += buf.length;
      if (written > MAX_UNCOMPRESSED) throw new UpdateErr("bundle-invalid", "bundle is too large when unpacked");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buf);
    }

    const check = validateBundleDir(root, version);
    if (!check.ok) throw new UpdateErr("bundle-invalid", check.reason);

    rmSync(dest, { recursive: true, force: true });
    renameWithRetry(root, dest);
    return { dir: dest };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (e instanceof UpdateErr) throw e;
    throw new UpdateErr("bundle-invalid", `bundle staging failed: ${(e as Error).message.slice(0, 200)}`);
  }
}

/** Removes staged bundle folders (and leftover .tmp folders) whose name is not in `keep`. Returns how many were removed. */
export function pruneBundles(updatesDir: string, keep: string[]): number {
  const bundles = join(updatesDir, "bundles");
  if (!existsSync(bundles)) return 0;
  let n = 0;
  for (const name of readdirSync(bundles)) {
    if (keep.includes(name)) continue;
    try {
      rmSync(join(bundles, name), { recursive: true, force: true });
      n++;
    } catch { /* keep going: a locked folder is retried by the next prune */ }
  }
  return n;
}
