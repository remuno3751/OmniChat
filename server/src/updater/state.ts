/* File-based update state machine: <DATA_DIR>/updates/state.json.
   boot.ts reads it BEFORE the database is opened, so this module must never import db.ts (or anything that opens the DB).
   Everything here is pure except readState/writeState (plain fs). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplyResult } from "./types.js";
import { compareVersions } from "./semver.js";

export interface BundleRef { version: string; dir: string }

export interface FileState {
  v: 1;
  /** Bundle that should run (null = the installed bundle). */
  active: BundleRef | null;
  /** Bundle that was running before `active` (null = the installed bundle). Rollback target. */
  previous: BundleRef | null;
  status: "idle" | "verifying";
  /** Boots that started this bundle without reaching "verified". */
  attempts: number;
  /** Pre-update backup folder (DB + files) to restore on rollback. */
  backupDir: string | null;
  /** Restore the pre-update backup on the next boot, before the DB is opened. */
  restoreOnBoot: boolean;
  verifyDeadline: number | null;
  /** Versions that failed and must never be auto-retried. */
  failed: string[];
  lastResult: ApplyResult | null;
}

export function emptyState(): FileState {
  return {
    v: 1, active: null, previous: null, status: "idle", attempts: 0, backupDir: null,
    restoreOnBoot: false, verifyDeadline: null, failed: [], lastResult: null,
  };
}

export const statePath = (dataDir: string): string => join(dataDir, "updates", "state.json");

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function bundleRef(x: unknown): BundleRef | null {
  if (!isObj(x) || typeof x.version !== "string" || typeof x.dir !== "string") return null;
  if (!x.version || !x.dir) return null;
  return { version: x.version.slice(0, 64), dir: x.dir };
}

function applyResult(x: unknown): ApplyResult | null {
  if (!isObj(x)) return null;
  if ((x.status !== "ok" && x.status !== "failed") || typeof x.version !== "string"
    || typeof x.message !== "string" || typeof x.at !== "number" || !Number.isFinite(x.at)) return null;
  return {
    status: x.status as "ok" | "failed",
    version: x.version.slice(0, 64),
    message: x.message.slice(0, 2000),
    at: x.at,
    acknowledged: x.acknowledged === true,
    ...(typeof x.rolledBack === "boolean" ? { rolledBack: x.rolledBack } : {}),
  };
}

/** Tolerant read: a missing, corrupt or unexpected file gives the empty state; unknown keys are dropped; wrong types fall back. */
export function readState(dataDir: string): FileState {
  const s = emptyState();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(statePath(dataDir), "utf8")); } catch { return s; }
  if (!isObj(raw)) return s;
  s.active = bundleRef(raw.active);
  s.previous = bundleRef(raw.previous);
  s.status = raw.status === "verifying" ? "verifying" : "idle";
  s.attempts = typeof raw.attempts === "number" && Number.isFinite(raw.attempts) && raw.attempts >= 0 ? Math.floor(raw.attempts) : 0;
  s.backupDir = typeof raw.backupDir === "string" && raw.backupDir ? raw.backupDir : null;
  s.restoreOnBoot = raw.restoreOnBoot === true;
  s.verifyDeadline = typeof raw.verifyDeadline === "number" && Number.isFinite(raw.verifyDeadline) ? raw.verifyDeadline : null;
  s.failed = Array.isArray(raw.failed)
    ? [...new Set(raw.failed.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64))].slice(-200)
    : [];
  s.lastResult = applyResult(raw.lastResult);
  return s;
}

const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Atomic write: tmp file (mode 0600) then rename. Retries briefly because Windows may refuse a rename while AV scans the file. */
export function writeState(dataDir: string, s: FileState): void {
  const file = statePath(dataDir);
  mkdirSync(join(dataDir, "updates"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...s, v: 1 }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort (no-op on Windows) */ }
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 4 || (code !== "EPERM" && code !== "EBUSY")) { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
      sleepMs(50);
    }
  }
}

export type BootPlan =
  | { action: "run-installed"; restore: boolean; reason?: string }
  /** `restore` is true only for a rollback boot (the caller restores the pre-update backup before opening the DB). */
  | { action: "run-bundle"; bundle: BundleRef; restore: boolean; reason?: string };

/** True when `a` is a strictly newer semver than `b` (invalid versions are never newer). */
function isNewer(a: string, b: string): boolean {
  try { return compareVersions(a, b) > 0; } catch { return false; }
}

/**
 * Pure boot decision. `exists(dir)` tells whether a bundle folder is still on disk.
 * The caller persists `next` (writeState) before acting on `plan`.
 */
export function planBoot(
  s: FileState,
  installedVersion: string,
  exists: (dir: string) => boolean,
  maxAttempts = 3,
  now = Date.now(),
): { plan: BootPlan; next: FileState } {
  let st: FileState = { ...s, failed: [...s.failed] };
  let restore = s.restoreOnBoot;
  st.restoreOnBoot = false;

  // Started too many times without verifying: roll back now (same effect as markFailed).
  if (st.active && st.status === "verifying" && st.attempts >= maxAttempts) {
    st = markFailed(st, `did not start after ${maxAttempts} attempts`, now);
    restore = restore || st.restoreOnBoot;
    st.restoreOnBoot = false;
  }

  if (st.status === "verifying" && !st.active) { st.status = "idle"; st.attempts = 0; st.verifyDeadline = null; }

  const cand = st.active;
  if (cand) {
    let why: string | null = null;
    if (!isNewer(cand.version, installedVersion)) why = "installer upgrade overtook the stored bundle";
    else if (st.failed.includes(cand.version)) why = `bundle ${cand.version} previously failed`;
    else if (!exists(cand.dir)) why = "bundle folder is missing";
    if (why === null) {
      if (st.status === "verifying") st.attempts += 1;
      return { plan: { action: "run-bundle", bundle: cand, restore, ...(restore ? { reason: "restoring the pre-update data" } : {}) }, next: st };
    }
    // Stored bundle cannot run: forget it, fall back to the installed bundle.
    st = { ...st, active: null, status: "idle", attempts: 0, verifyDeadline: null };
    return { plan: { action: "run-installed", restore, reason: why }, next: st };
  }

  return { plan: { action: "run-installed", restore, ...(restore ? { reason: "restoring the pre-update data" } : {}) }, next: st };
}

/** Successful start + health check: the bundle is good, the pre-update backup is no longer needed for rollback. */
export function markVerified(s: FileState, now: number): FileState {
  return {
    ...s, status: "idle", attempts: 0, verifyDeadline: null, backupDir: null, restoreOnBoot: false,
    lastResult: { status: "ok", version: s.active?.version ?? "", message: "started and verified", at: now, acknowledged: false },
  };
}

/** Rollback: the version is blacklisted, `previous` becomes active, and the backup is restored on the next boot if one exists. */
export function markFailed(s: FileState, reason: string, now: number): FileState {
  const v = s.active?.version ?? "";
  const failed = v && !s.failed.includes(v) ? [...s.failed, v] : [...s.failed];
  return {
    ...s, failed, active: s.previous, previous: null, status: "idle", attempts: 0, verifyDeadline: null,
    restoreOnBoot: s.backupDir !== null,
    lastResult: { status: "failed", rolledBack: true, version: v, message: reason.slice(0, 500), at: now, acknowledged: false },
  };
}

/** Start of an apply: `previous` is the bundle running right now (null = installed). */
export function beginApply(
  s: FileState,
  o: { version: string; dir: string; previous: BundleRef | null; backupDir: string | null; deadlineMs: number; now: number },
): FileState {
  return {
    ...s, active: { version: o.version, dir: o.dir }, previous: o.previous, backupDir: o.backupDir,
    status: "verifying", attempts: 0, verifyDeadline: o.now + o.deadlineMs, restoreOnBoot: false,
  };
}
