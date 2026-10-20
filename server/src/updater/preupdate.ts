/* Pre-update backup: a folder <DATA_DIR>/backups/pre-update-<oldVersion>-<YYYYMMDD-HHMMSS>/ with the database,
   the encryption key, the admin token, the plugins and (when present) the config.env next to DATA_DIR.
   Must not import db.ts: restore runs in boot.ts before the database is opened. */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DB_PATH } from "../config.js";

export const PRE_UPDATE_KEEP = 3;
/** Canonical database file name inside a backup folder. */
const DB_NAME = "omnichat.db";
/** Database side files: never copied (the snapshot is taken with VACUUM INTO). */
const DB_SIDE = /\.db(-wal|-shm|-journal)?$/i;
const PRE_RE = /^pre-update-(.+)-(\d{8}-\d{6})(?:-\d+)?$/;

export interface PreUpdateBackup { dir: string; files: string[] }
export interface PreUpdateInfo { name: string; dir: string; oldVersion: string; createdAt: number }

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Keeps the folder name safe: only version characters survive. */
const safeVersion = (v: string): string => v.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 40) || "unknown";

function copyFile(src: string, dst: string): void {
  copyFileSync(src, dst);
  try { chmodSync(dst, 0o600); } catch { /* best effort */ }
}

/** Relative file paths below `dir` (forward slashes). */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/**
 * Snapshot before an update. `vacuumInto(target)` must write a consistent copy of the live database to `target`
 * (the caller passes a function built on the live `db`). Throws when the database snapshot fails; the partial folder is removed.
 */
export function createPreUpdateBackup(opts: {
  dataDir: string;
  oldVersion: string;
  vacuumInto: (target: string) => void;
  now?: Date;
}): PreUpdateBackup {
  const { dataDir } = opts;
  const now = opts.now ?? new Date();
  const root = join(dataDir, "backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const ver = safeVersion(opts.oldVersion);
  let name = `pre-update-${ver}-${stamp(now)}`;
  for (let i = 2; existsSync(join(root, name)); i++) name = `pre-update-${ver}-${stamp(now)}-${i}`;
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  try {
    opts.vacuumInto(join(dir, DB_NAME));
    if (!existsSync(join(dir, DB_NAME))) throw new Error("database snapshot was not written");
    try { chmodSync(join(dir, DB_NAME), 0o600); } catch { /* best effort */ }

    // Top-level regular files (secret.key, local-admin.token, effort-map.json, ...). Database files are skipped.
    // Best effort per file: a file locked by another process (log) must not block the update.
    for (const e of readdirSync(dataDir, { withFileTypes: true })) {
      if (!e.isFile() || DB_SIDE.test(e.name)) continue;
      try { copyFile(join(dataDir, e.name), join(dir, e.name)); } catch (err) {
        if (e.name === "secret.key") throw err; // without the key the encrypted secrets are unusable
      }
    }
    const plugins = join(dataDir, "plugins");
    if (existsSync(plugins) && statSync(plugins).isDirectory()) cpSync(plugins, join(dir, "plugins"), { recursive: true });
    const cfg = join(dataDir, "..", "config.env");
    if (existsSync(cfg) && statSync(cfg).isFile()) copyFile(cfg, join(dir, "config.env"));

    const files = walk(dir);
    const manifest = { oldVersion: opts.oldVersion, createdAt: now.toISOString(), files };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    files.push("manifest.json");
    prunePreUpdateBackups(dataDir, PRE_UPDATE_KEEP);
    return { dir, files };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Pre-update folders, newest first. */
export function listPreUpdateBackups(dataDir: string): PreUpdateInfo[] {
  const root = join(dataDir, "backups");
  if (!existsSync(root)) return [];
  const out: PreUpdateInfo[] = [];
  for (const name of readdirSync(root)) {
    const m = PRE_RE.exec(name);
    if (!m) continue;
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    let oldVersion = m[1];
    let createdAt = statSync(dir).mtimeMs;
    try {
      const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
      if (typeof mf.createdAt === "string" && Number.isFinite(Date.parse(mf.createdAt))) createdAt = Date.parse(mf.createdAt);
      if (typeof mf.oldVersion === "string") oldVersion = mf.oldVersion;
    } catch { /* no manifest: keep the folder name and mtime */ }
    out.push({ name, dir, oldVersion, createdAt });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

/** Deletes pre-update folders beyond the newest `keep`. Returns how many were removed. */
export function prunePreUpdateBackups(dataDir: string, keep = PRE_UPDATE_KEEP): number {
  let n = 0;
  for (const b of listPreUpdateBackups(dataDir).slice(Math.max(0, keep))) {
    try { rmSync(b.dir, { recursive: true, force: true }); n++; } catch { /* keep going */ }
  }
  return n;
}

/**
 * Copies a snapshot back. Call only when the database is NOT open (boot.ts, before the DB module loads).
 * Returns the restored names.
 */
export function restorePreUpdateBackup(opts: { dataDir: string; backupDir: string; dbFileName?: string }): string[] {
  const { dataDir, backupDir } = opts;
  const dbFileName = opts.dbFileName ?? basename(DB_PATH);
  if (!existsSync(join(backupDir, DB_NAME))) throw new Error("pre-update backup has no database snapshot");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const restored: string[] = [];

  const dbTarget = join(dataDir, dbFileName);
  // stale WAL/SHM from the failed run would be replayed onto the restored file: remove them first
  for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(dbTarget + suffix, { force: true });
  copyFile(join(backupDir, DB_NAME), dbTarget);
  restored.push(dbFileName);

  for (const e of readdirSync(backupDir, { withFileTypes: true })) {
    if (e.name === DB_NAME || e.name === "manifest.json" || e.name === "config.env" || DB_SIDE.test(e.name)) continue;
    if (e.isFile()) {
      copyFile(join(backupDir, e.name), join(dataDir, e.name));
      restored.push(e.name);
    } else if (e.isDirectory() && e.name === "plugins") {
      cpSync(join(backupDir, "plugins"), join(dataDir, "plugins"), { recursive: true, force: true });
      restored.push("plugins");
    }
  }

  const cfg = join(backupDir, "config.env");
  if (existsSync(cfg)) {
    copyFile(cfg, join(dataDir, "..", "config.env"));
    restored.push("config.env");
  }
  return restored;
}
