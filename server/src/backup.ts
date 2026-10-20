import { mkdirSync, chmodSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { db } from "./db.js";
import { DATA_DIR } from "./config.js";

export interface BackupInfo { name: string; size: number; createdAt: number }

export const BACKUP_DIR = resolve(join(DATA_DIR, "backups"));
const intEnv = (k: string, d: number) => {
  const v = process.env[k];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export const BACKUP_INTERVAL_HOURS = intEnv("BACKUP_INTERVAL_HOURS", 24);
export const BACKUP_KEEP = Math.max(1, Math.trunc(intEnv("BACKUP_KEEP", 7)));
/** First scheduled run delay (default 5 min; overridable for tests). */
const FIRST_DELAY_MS = intEnv("BACKUP_FIRST_DELAY_MS", 5 * 60_000);

const NAME_RE = /^omnichat-\d{8}-\d{6}(?:-\d{1,4})?\.db$/;
export const isBackupName = (n: unknown): n is string => typeof n === "string" && n.length <= 40 && NAME_RE.test(n);

/** Absolute path of a validated backup name (null if invalid or outside the backup dir). */
export function backupPath(name: unknown): string | null {
  if (!isBackupName(name)) return null;
  const p = resolve(join(BACKUP_DIR, name));
  return p.startsWith(BACKUP_DIR + sep) ? p : null;
}

const info = (name: string): BackupInfo | null => {
  try {
    const st = statSync(join(BACKUP_DIR, name));
    return st.isFile() ? { name, size: st.size, createdAt: Math.round(st.mtimeMs) } : null;
  } catch { return null; }
};

/** Newest first. */
export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR).filter(isBackupName).map(info).filter((x): x is BackupInfo => !!x)
    .sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
}

const pad = (n: number) => String(n).padStart(2, "0");
function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Consistent snapshot via VACUUM INTO (safe while the database is in use: WAL readers/writers are not corrupted). */
export function createBackup(): BackupInfo {
  mkdirSync(BACKUP_DIR, { recursive: true });
  let name = `omnichat-${stamp()}.db`;
  for (let i = 2; existsSync(join(BACKUP_DIR, name)); i++) name = `omnichat-${stamp()}-${i}.db`;
  const target = join(BACKUP_DIR, name).replace(/'/g, "''");
  db.exec(`VACUUM INTO '${target}'`);
  try { chmodSync(join(BACKUP_DIR, name), 0o600); } catch { /* best effort */ }
  pruneBackups();
  return info(name)!;
}

export function deleteBackup(name: string): boolean {
  const p = backupPath(name);
  if (!p || !existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function pruneBackups(keep = BACKUP_KEEP): number {
  const all = listBackups();
  let n = 0;
  for (const b of all.slice(keep)) if (deleteBackup(b.name)) n++;
  return n;
}

let timer: NodeJS.Timeout | null = null;
/** Scheduler: first check after 5 min, then hourly; a backup is made when none is younger than the interval. */
export function startBackupScheduler(): void {
  if (BACKUP_INTERVAL_HOURS <= 0 || timer) return;
  const intervalMs = BACKUP_INTERVAL_HOURS * 3_600_000;
  const tick = () => {
    try {
      const newest = listBackups()[0];
      if (!newest || Date.now() - newest.createdAt >= intervalMs) createBackup();
    } catch (e) { console.error("[backup] failed:", (e as Error).message); }
  };
  const first = setTimeout(() => {
    tick();
    timer = setInterval(tick, Math.min(intervalMs, 3_600_000));
    timer.unref();
  }, FIRST_DELAY_MS);
  first.unref();
  timer = first;
}
