// Update service: check GitHub, download + verify the server bundle, stage it, take a pre-update backup, swap the
// file state and restart. Also runs the post-boot health check of a freshly swapped bundle (verify or roll back).
//
// Everything that touches the outside world is injected through UpdateDeps so tests can drive apply() end to end
// (fake GitHub, fake VACUUM INTO, fake restart). getUpdateService() wires the production defaults from env.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, HOST, PORT } from "../config.js";
import { db } from "../db.js";
import {
  GithubClient, UpdateErr, findChecksumAssets, findPlugin, findServerBundle, pickLatest,
  type DownloadOptions, type ListResult,
} from "./github.js";
import { sumFor, verifySha256 } from "./checksums.js";
import { gt } from "./semver.js";
import { detectInstall, type InstallInfo } from "./install-type.js";
import { requestRestart } from "./restart.js";
import { createPreUpdateBackup } from "./preupdate.js";
import { pruneBundles, stageBundle } from "./bundle.js";
import { beginApply, markFailed, markVerified, readState, writeState, type FileState } from "./state.js";
import { getRuntime, getUpdateSettings, getUpdateToken, setRuntime, setUpdateSettings } from "./store.js";
import type { Channel, Phase, ReleaseAsset, ReleaseInfo, UpdateError, UpdateStatus } from "./types.js";

/** Subset of GithubClient the service uses (tests may pass a fake). */
export interface GithubLike {
  listReleases(prev?: { etag: string; releases: ReleaseInfo[] }): Promise<ListResult>;
  downloadAsset(asset: ReleaseAsset, destFile: string, opts?: DownloadOptions): Promise<void>;
  fetchAssetText(asset: ReleaseAsset, maxBytes?: number): Promise<string>;
}

export interface HealthResult { ok: boolean; reason?: string }

export interface UpdateDeps {
  /** DATA_DIR of the running server: updates/ and backups/ live below it. */
  dataDir: string;
  /** Folder of the bundle that is running now (its package.json carries the version). */
  runningRoot: string;
  /** Version of the running bundle. */
  currentVersion: string;
  install(): InstallInfo;
  createGithub(): GithubLike;
  /** Writes a consistent copy of the live database to the target path (VACUUM INTO). */
  vacuumInto(target: string): void;
  /** Restarts the process. Production: requestRestart. */
  restart(reason: string): void;
  /** Health of the freshly started bundle (own /healthz + /version + DB check). */
  health(expectVersion: string): Promise<HealthResult>;
  now(): number;
  /** Delay between the reply to apply() and the restart. */
  restartDelayMs: number;
  /** Delay before the first scheduled check after start(). */
  firstCheckDelayMs: number;
  /** Poll interval of the post-boot health check. */
  verifyPollMs: number;
}

const TICK_MS = 10 * 60_000; // the scheduler wakes up this often and checks whether a check is due
const RETRY_AFTER_ERROR_MS = 15 * 60_000; // a failed automatic check is retried after this, not after checkHours
const HOUR_MS = 3_600_000;
const VERIFY_WINDOW_MS = 60_000; // must match the window the boot watchdog uses (boot.ts)
const SUM_MAX_BYTES = 1024 * 1024;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** Current GitHub token or "" (never throws: a bad stored secret must not break status). */
function tokenOrEmpty(): string {
  try { return getUpdateToken(); } catch { return ""; }
}

/** Newer-than test that never throws (invalid versions are never newer). */
function newerThan(a: string, b: string): boolean {
  try { return gt(a, b); } catch { return false; }
}

function defaultRunningRoot(): string {
  if (process.env.OMNICHAT_BUNDLE_ROOT) return resolve(process.env.OMNICHAT_BUNDLE_ROOT);
  // src/updater/service.ts or dist/updater/service.js: two levels up is the server root (= bundle root)
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readPkgVersion(root: string): string {
  try {
    const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch { return "0.0.0"; }
}

async function defaultHealth(expect: string): Promise<HealthResult> {
  const host = /^\d+\.\d+\.\d+\.\d+$/.test(HOST) && HOST !== "0.0.0.0" ? HOST : "127.0.0.1";
  const base = `http://${host}:${PORT}`;
  try {
    const h = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) });
    if (!h.ok || (await h.text()).trim() !== "ok") return { ok: false, reason: "/healthz did not answer ok" };
    const v = await fetch(`${base}/version`, { signal: AbortSignal.timeout(5_000) });
    const j = (await v.json()) as { version?: unknown };
    if (j.version !== expect) return { ok: false, reason: `/version reports ${String(j.version)}, expected ${expect}` };
  } catch (e) {
    return { ok: false, reason: `HTTP check failed: ${errText(e)}` };
  }
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (!row || Object.values(row)[0] !== "ok") return { ok: false, reason: "database quick_check failed" };
  } catch (e) {
    return { ok: false, reason: `database check failed: ${errText(e)}` };
  }
  return { ok: true };
}

function defaultDeps(dataDir: string): UpdateDeps {
  const runningRoot = defaultRunningRoot();
  return {
    dataDir,
    runningRoot,
    currentVersion: readPkgVersion(runningRoot),
    install: () => detectInstall(),
    createGithub: () => {
      const env = process.env;
      return new GithubClient({
        apiBase: env.OMNICHAT_UPDATE_API_BASE || "https://api.github.com",
        repo: env.OMNICHAT_UPDATE_REPO || "remuno3751/omnichat",
        token: tokenOrEmpty(),
        allowHttp: env.OMNICHAT_UPDATE_ALLOW_HTTP === "1",
      });
    },
    vacuumInto: (target: string) => {
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    },
    restart: (reason: string) => requestRestart(reason),
    health: defaultHealth,
    now: () => Date.now(),
    restartDelayMs: 800,
    firstCheckDelayMs: Number(process.env.OMNICHAT_UPDATE_FIRST_DELAY_MS ?? 60_000) || 60_000,
    verifyPollMs: 1_000,
  };
}

interface ApplyJob {
  release: ReleaseInfo;
  bundle: ReleaseAsset;
  sums: ReleaseAsset | null;
  per: ReleaseAsset | null;
}

export class UpdateService {
  private phase: Phase = "idle";
  private progress: number | null = null;
  private applyError: UpdateError | null = null;
  private applyJob: Promise<void> | null = null;
  private checkJob: Promise<UpdateStatus> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly deps: UpdateDeps) {}

  /** Snapshot for GET /update/status. isAdmin is informational only (routes enforce admin for mutations). */
  status(isAdmin: boolean): UpdateStatus {
    const s = getUpdateSettings();
    const rt = getRuntime();
    const install = this.deps.install();
    const st = readState(this.deps.dataDir);
    const latest = pickLatest(rt.releases ?? [], s.channel);

    let bundleAssetFound = false;
    let plugin: UpdateStatus["plugin"] = null;
    if (latest) {
      const bundle = findServerBundle(latest);
      if (bundle) {
        const c = findChecksumAssets(latest, bundle.name);
        bundleAssetFound = c.sums !== null || c.per !== null;
      }
      plugin = findPlugin(latest);
    }

    return {
      current: this.deps.currentVersion,
      installType: install.type,
      selfUpdate: install.selfUpdate,
      selfUpdateReason: install.reason,
      dockerCommand: install.dockerCommand,
      channel: s.channel,
      checkHours: s.checkHours,
      tokenSet: s.tokenSet,
      latest,
      updateAvailable: latest !== null && newerThan(latest.version, this.deps.currentVersion),
      skipped: latest !== null && s.skipped.includes(latest.version),
      skippedVersions: s.skipped,
      bundleAssetFound,
      lastCheckedAt: rt.lastCheckedAt,
      lastError: this.applyError ?? rt.lastError,
      phase: this.phase,
      progress: this.progress,
      lastApply: st.lastResult,
      plugin,
      isAdmin,
    };
  }

  /** Queries GitHub (ETag cached). Never throws: failures land in lastError. An explicit channel is persisted. */
  async checkNow(opts: { channel?: Channel } = {}): Promise<UpdateStatus> {
    if (this.checkJob) return this.checkJob;
    if (opts.channel && opts.channel !== getUpdateSettings().channel) setUpdateSettings({ channel: opts.channel });
    this.checkJob = this.doCheck().finally(() => { this.checkJob = null; });
    return this.checkJob;
  }

  private async doCheck(): Promise<UpdateStatus> {
    const wasIdle = this.phase === "idle";
    if (wasIdle) this.phase = "checking";
    try {
      const rt = getRuntime();
      const prev = rt.etag && rt.releases ? { etag: rt.etag, releases: rt.releases } : undefined;
      const res = await this.deps.createGithub().listReleases(prev);
      setRuntime({ etag: res.etag, releases: res.releases, lastCheckedAt: this.deps.now(), lastError: null });
    } catch (e) {
      setRuntime({ lastCheckedAt: this.deps.now(), lastError: this.toError(e, "update check failed") });
    } finally {
      if (wasIdle) this.phase = "idle";
    }
    return this.status(true);
  }

  /**
   * Starts an update to `version` (default: newest on the channel). Guards run synchronously and reject with an
   * UpdateErr; the download, verification, staging, backup and state swap run in the background (poll status()).
   * The restart is scheduled after the reply (restartDelayMs).
   */
  async apply(version?: string): Promise<{ ok: true; phase: Phase }> {
    const install = this.deps.install();
    if (!install.selfUpdate) {
      if (install.type === "docker") {
        throw new UpdateErr("unsupported", `This server runs in Docker and cannot replace itself. On the host run: ${install.dockerCommand}`);
      }
      throw new UpdateErr("unsupported", `Self update is not available for this install: ${install.reason ?? install.type}`);
    }
    if (this.phase !== "idle" && this.phase !== "error") {
      throw new UpdateErr("busy", `an update step is already running (${this.phase})`);
    }

    const s = getUpdateSettings();
    const releases = getRuntime().releases ?? [];
    let release: ReleaseInfo | null;
    if (version) {
      const want = version.replace(/^v/i, "");
      release = releases.find((r) => r.version === want) ?? null;
      if (!release) throw new UpdateErr("not-found", "that version is not in the release listing: run a check first");
    } else {
      release = pickLatest(releases, s.channel);
      if (!release) throw new UpdateErr("not-found", "no release is known yet: run a check first");
    }
    if (s.channel === "stable" && release.prerelease) {
      throw new UpdateErr("other", "that release is a prerelease; switch the channel to prerelease first");
    }
    if (!newerThan(release.version, this.deps.currentVersion)) {
      throw new UpdateErr("other", `version ${release.version} is not newer than the running ${this.deps.currentVersion}`);
    }
    const bundle = findServerBundle(release);
    if (!bundle) throw new UpdateErr("not-found", `release ${release.version} has no server bundle`);
    const c = findChecksumAssets(release, bundle.name);
    if (!c.sums && !c.per) throw new UpdateErr("checksum-missing", `release ${release.version} has no checksum for its bundle`);

    this.applyError = null;
    this.phase = "downloading";
    this.progress = 0;
    this.applyJob = this.runApply({ release, bundle, sums: c.sums, per: c.per }).finally(() => { this.applyJob = null; });
    return { ok: true, phase: this.phase };
  }

  /** Resolves when the running apply or check job (if any) has finished. Never rejects. */
  async settled(): Promise<void> {
    while (this.applyJob || this.checkJob) {
      const pending: Promise<unknown>[] = [];
      if (this.applyJob) pending.push(this.applyJob);
      if (this.checkJob) pending.push(this.checkJob);
      await Promise.all(pending);
    }
  }

  private async runApply(job: ApplyJob): Promise<void> {
    const { dataDir } = this.deps;
    const updatesDir = join(dataDir, "updates");
    const version = job.release.version;
    const zipDir = join(updatesDir, "downloads");
    const zipFile = join(zipDir, job.bundle.name);
    let stagedDir: string | null = null;
    let backupDir: string | null = null;
    let stateWritten = false;
    try {
      mkdirSync(zipDir, { recursive: true, mode: 0o700 });
      const gh = this.deps.createGithub();

      // 1. checksum first (small text assets), so a release without one never downloads the big zip
      const sumsText = job.sums ? await gh.fetchAssetText(job.sums, SUM_MAX_BYTES) : null;
      let expected = sumFor(job.bundle.name, sumsText, null);
      if (!expected && job.per) expected = sumFor(job.bundle.name, sumsText, await gh.fetchAssetText(job.per, SUM_MAX_BYTES));
      if (!expected) throw new UpdateErr("checksum-missing", `no sha256 checksum for ${job.bundle.name} in the release`);

      // 2. download
      this.phase = "downloading";
      this.progress = 0;
      await gh.downloadAsset(job.bundle, zipFile, { onProgress: (f) => { this.progress = f; } });

      // 3. verify (a mismatch throws checksum-mismatch; the file is removed in the catch below)
      this.phase = "verifying";
      this.progress = null;
      await verifySha256(zipFile, expected);

      // 4. stage into updates/bundles/<version> (validated by bundle.ts)
      this.phase = "staging";
      rmSync(join(updatesDir, "bundles", version), { recursive: true, force: true });
      try {
        stagedDir = (await stageBundle({ zipFile, version, updatesDir })).dir;
      } catch (e) {
        if (e instanceof UpdateErr) throw e;
        throw new UpdateErr("bundle-invalid", `bundle could not be staged: ${errText(e)}`);
      }

      // 5. pre-update snapshot (database + data files)
      this.phase = "backing-up";
      try {
        backupDir = createPreUpdateBackup({ dataDir, oldVersion: this.deps.currentVersion, vacuumInto: this.deps.vacuumInto }).dir;
      } catch (e) {
        throw new UpdateErr("other", `pre-update backup failed: ${errText(e)}`);
      }

      // 6. swap the file state (the only change to state.json; everything before this point is reversible)
      const before = readState(dataDir);
      const running = before.active && norm(before.active.dir) === norm(this.deps.runningRoot) ? before.active : null;
      const next = beginApply(
        { ...before, failed: before.failed.filter((v) => v !== version) },
        { version, dir: stagedDir, previous: running, backupDir, deadlineMs: VERIFY_WINDOW_MS, now: this.deps.now() },
      );
      writeState(dataDir, next);
      stateWritten = true;

      await rm(zipFile, { force: true }).catch(() => undefined);
      this.phase = "restarting";
      this.progress = null;
      setTimeout(() => this.deps.restart(`update to ${version}`), this.deps.restartDelayMs);
    } catch (e) {
      const err = this.toError(e, "update failed");
      this.phase = "error";
      this.progress = null;
      this.applyError = err;
      await rm(zipFile, { force: true }).catch(() => undefined);
      if (!stateWritten) {
        // nothing references these yet: remove them so a retry starts clean
        if (stagedDir) rmSync(stagedDir, { recursive: true, force: true });
        if (backupDir) rmSync(backupDir, { recursive: true, force: true });
      }
    }
  }

  /** Marks the last apply result as seen; status().lastApply then carries acknowledged=true. */
  acknowledge(): UpdateStatus {
    const st = readState(this.deps.dataDir);
    if (st.lastResult && !st.lastResult.acknowledged) {
      writeState(this.deps.dataDir, { ...st, lastResult: { ...st.lastResult, acknowledged: true } });
    }
    this.applyError = null;
    return this.status(true);
  }

  /**
   * Post-boot verification: when this process runs the bundle that the file state is verifying, check its health
   * within the window. Success marks it verified; failure rolls back and restarts.
   */
  private async verifyBoot(st: FileState): Promise<void> {
    const active = st.active;
    if (!active) return;
    const deadline = st.verifyDeadline ?? this.deps.now() + VERIFY_WINDOW_MS;
    let res: HealthResult = { ok: false, reason: "not checked" };
    for (;;) {
      try {
        res = await this.deps.health(active.version);
      } catch (e) {
        res = { ok: false, reason: errText(e) };
      }
      if (res.ok || this.deps.now() >= deadline) break;
      await sleep(this.deps.verifyPollMs);
    }

    const cur = readState(this.deps.dataDir);
    if (cur.status !== "verifying" || cur.active?.version !== active.version) return; // state moved on meanwhile
    const now = this.deps.now();
    if (res.ok) {
      (globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy = true;
      writeState(this.deps.dataDir, markVerified(cur, now));
      const keep = [active.version, ...(cur.previous ? [cur.previous.version] : [])];
      pruneBundles(join(this.deps.dataDir, "updates"), keep);
      return;
    }
    const reason = `new version did not start: ${res.reason ?? "health check failed"}`;
    writeState(this.deps.dataDir, markFailed(cur, reason, now));
    this.deps.restart(`rollback: ${reason}`);
  }

  /** Starts the scheduler (unref'd timers) and the post-boot verification. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const st = readState(this.deps.dataDir);
    if (st.status === "verifying" && st.active && norm(st.active.dir) === norm(this.deps.runningRoot)) {
      void this.verifyBoot(st).catch(() => undefined);
    }
    this.schedule(this.deps.firstCheckDelayMs);
  }

  /** Stops the scheduler (tests). */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
    this.timer.unref();
  }

  /**
   * Checks when the interval since the last check has passed (checkHours 0 = off; settings are re-read every tick).
   * After a failed check the next attempt is due after RETRY_AFTER_ERROR_MS; lastError stays in the status until a check succeeds.
   */
  private async tick(): Promise<void> {
    let nextMs = TICK_MS;
    try {
      const s = getUpdateSettings();
      const rt = getRuntime();
      const interval = rt.lastError ? RETRY_AFTER_ERROR_MS : s.checkHours * HOUR_MS;
      const due = s.checkHours > 0 && (rt.lastCheckedAt === null || this.deps.now() - rt.lastCheckedAt >= interval);
      if (due && this.phase === "idle") await this.checkNow();
      if (s.checkHours > 0 && getRuntime().lastError) nextMs = RETRY_AFTER_ERROR_MS;
    } catch {
      // the scheduler never takes the server down
    } finally {
      this.schedule(nextMs);
    }
  }

  private toError(e: unknown, fallback: string): UpdateError {
    const at = this.deps.now();
    if (e instanceof UpdateErr) {
      let message = e.message;
      if (e.code === "rate-limited" && e.resetAt) message += `; resets at ${new Date(e.resetAt).toISOString()}`;
      return { code: e.code, message: this.clean(message), at };
    }
    return { code: "other", message: this.clean(`${fallback}: ${errText(e)}`), at };
  }

  /** Removes the GitHub token from any text that may reach a client or a log. */
  private clean(s: string): string {
    const t = tokenOrEmpty();
    const out = t ? s.split(t).join("[redacted]") : s;
    return out.slice(0, 500);
  }
}

/** Builds a service from explicit deps (tests) or the production defaults (dataDir required). */
export function createUpdateService(input: Partial<UpdateDeps> & { dataDir: string }): UpdateService {
  const defaults = defaultDeps(input.dataDir);
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  return new UpdateService({ ...defaults, ...given } as UpdateDeps);
}

let instance: UpdateService | null = null;

/** Process-wide service (production). Used by the routes, local-admin routes and index.ts. */
export function getUpdateService(): UpdateService {
  if (!instance) instance = createUpdateService({ dataDir: DATA_DIR });
  return instance;
}
