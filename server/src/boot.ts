/* Boot entry (compiled to dist/boot.js by tsconfig.build.json). Decides which bundle runs, restores the pre-update
   backup when rolling back, and watches a freshly swapped bundle until it reports healthy.
   It runs BEFORE the database module loads: never import db.ts (or anything that opens the DB) here. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATA_DIR } from "./config.js";
import { restorePreUpdateBackup } from "./updater/preupdate.js";
import { requestRestart } from "./updater/restart.js";
import { readState, writeState, planBoot, markFailed, type FileState } from "./updater/state.js";
import { validateBundleDir } from "./updater/bundle.js";

/** A new bundle must report healthy (globalThis.__omnichatHealthy) within this window. */
const VERIFY_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 3;

export interface BootOptions {
  /** Root of the installed bundle (parent of its dist folder). Default: parent of this file's folder. */
  installedRoot?: string;
  /** Data directory with updates/state.json. Default: DATA_DIR from config. */
  dataDir?: string;
  /** Loads an entry module (default: dynamic import). Tests inject a spy. */
  importFn?: (url: string) => Promise<unknown>;
  /** Exit used when a rollback restore fails (the server must not start on a half-restored data dir). */
  exit?: (code: number) => void;
  /** Restart used when a bundle cannot start (default: requestRestart). */
  restart?: (reason: string) => void;
  now?: () => number;
}

export interface BootResult { ran: "installed" | "bundle"; dir: string; restored: string[] }

let watchdog: NodeJS.Timeout | null = null;

/** Clears the health watchdog (tests). */
export function stopWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
}

const log = (msg: string): void => { console.log(`[boot] ${msg}`); };
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readInstalledVersion(root: string): string {
  try {
    const v = readFileSync(join(root, "VERSION"), "utf8").trim();
    if (v) return v;
  } catch { /* no VERSION file: fall back to package.json */ }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch { /* unreadable: treated as oldest */ }
  return "0.0.0";
}

/** Bundle web dir swap: only when WEB_DIR is unset or still points at the installed web folder. */
function pointWebDir(bundleDir: string, installedRoot: string): void {
  const cur = process.env.WEB_DIR;
  if (!cur || resolve(cur) === resolve(installedRoot, "web")) process.env.WEB_DIR = join(bundleDir, "web");
}

/** Health watchdog for a freshly started bundle: rolls back when the flag is not set by the deadline. */
function armWatchdog(dataDir: string, version: string, deadline: number | null, now: () => number, restart: (r: string) => void): void {
  stopWatchdog();
  const left = deadline === null ? 0 : deadline - now();
  // a deadline that already passed (e.g. a late start) gets one full window, not an instant rollback
  const delay = left > 0 ? left : VERIFY_WINDOW_MS;
  const t = setTimeout(() => {
    watchdog = null;
    if ((globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy === true) return;
    const cur = readState(dataDir);
    if (cur.status !== "verifying" || cur.active?.version !== version) return;
    writeState(dataDir, markFailed(cur, "did not report healthy before the deadline", now()));
    log(`bundle ${version} did not report healthy in time; rolling back`);
    restart("bundle failed to start");
  }, delay);
  t.unref();
  watchdog = t;
}

/**
 * Boot decision and start. Returns after the chosen entry module has been imported.
 * In a real process the entry starts the HTTP server; a failed bundle start triggers a restart (see restart option).
 */
export async function bootMain(opts: BootOptions = {}): Promise<BootResult> {
  const installedRoot = resolve(opts.installedRoot ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
  const dataDir = opts.dataDir ?? DATA_DIR;
  const importFn = opts.importFn ?? ((url: string) => import(url));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const restart = opts.restart ?? ((reason: string) => requestRestart(reason, log));
  const now = opts.now ?? Date.now;
  const installedUrl = pathToFileURL(join(installedRoot, "dist", "index.js")).href;

  process.env.OMNICHAT_BOOT = "1";
  const delay = Number(process.env.OMNICHAT_START_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0 && delay <= 60_000) await sleep(delay);

  const installedVersion = readInstalledVersion(installedRoot);
  const s: FileState = readState(dataDir);
  const { plan, next } = planBoot(s, installedVersion, (d) => existsSync(d), MAX_ATTEMPTS, now());
  const planText = plan.action === "run-bundle" ? `run-bundle ${plan.bundle.version}` : "run-installed";
  log(`plan: ${planText}${plan.reason ? ` (${plan.reason})` : ""}`);

  // Rollback: put the pre-update data back BEFORE anything opens the database.
  let restored: string[] = [];
  if (plan.restore) {
    if (!next.backupDir) {
      log("restore requested but no backup is recorded; skipping the restore");
    } else {
      try {
        restored = restorePreUpdateBackup({ dataDir, backupDir: next.backupDir });
        log(`restored ${restored.length} item(s) from the pre-update backup`);
      } catch (e) {
        const msg = errMsg(e);
        log(`restore failed, not starting: ${msg}`);
        // keep restoreOnBoot so the next start retries the restore
        writeState(dataDir, {
          ...s,
          restoreOnBoot: true,
          lastResult: { status: "failed", rolledBack: true, version: s.active?.version ?? "", message: `restore failed: ${msg}`.slice(0, 500), at: now(), acknowledged: false },
        });
        exit(1);
        return { ran: "installed", dir: installedRoot, restored: [] };
      }
    }
  }
  writeState(dataDir, next);

  if (plan.action === "run-installed") {
    process.env.OMNICHAT_BUNDLE_ROOT = installedRoot;
    await importFn(installedUrl);
    return { ran: "installed", dir: installedRoot, restored };
  }

  const bundle = plan.bundle;
  const bundleUrl = pathToFileURL(join(bundle.dir, "dist", "index.js")).href;

  // Failure of a new bundle: blacklist it (markFailed => previous/installed becomes active) and restart.
  const fail = async (reason: string): Promise<BootResult> => {
    stopWatchdog();
    writeState(dataDir, markFailed(next, reason, now()));
    log(`bundle ${bundle.version} failed: ${reason}`);
    restart("bundle failed to start");
    // Only reached when the restart could not exit this process (requestRestart keeps it up when no copy can start).
    process.env.OMNICHAT_BUNDLE_ROOT = installedRoot;
    await importFn(installedUrl);
    return { ran: "installed", dir: installedRoot, restored };
  };

  const check = validateBundleDir(bundle.dir, bundle.version);
  if (!check.ok) return fail(`invalid bundle: ${check.reason}`);

  if (next.status === "verifying") armWatchdog(dataDir, bundle.version, next.verifyDeadline, now, restart);
  process.env.OMNICHAT_BUNDLE_ROOT = bundle.dir;
  pointWebDir(bundle.dir, installedRoot);
  try {
    await importFn(bundleUrl);
  } catch (e) {
    return fail(errMsg(e));
  }
  return { ran: "bundle", dir: bundle.dir, restored };
}

/** True when this module is the process entry (node dist/boot.js, tsx src/boot.ts), not an import from a test. */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const norm = (p: string): string => {
    const r = resolve(p);
    try { return realpathSync(r); } catch { return r; }
  };
  let self: string;
  try { self = norm(fileURLToPath(import.meta.url)); } catch { return false; }
  const candidates = [norm(arg)];
  if (!/\.[cm]?[jt]s$/i.test(arg)) candidates.push(norm(`${arg}.js`));
  return candidates.some((c) => (process.platform === "win32" ? c.toLowerCase() === self.toLowerCase() : c === self));
}

if (isEntry()) {
  bootMain().catch((e) => {
    console.error(`[boot] fatal: ${errMsg(e)}`);
    process.exit(1);
  });
}
