import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyState, readState, writeState, statePath, planBoot, markVerified, markFailed, beginApply, type FileState,
} from "./state.js";
import { createPreUpdateBackup, restorePreUpdateBackup, listPreUpdateBackups, PRE_UPDATE_KEEP } from "./preupdate.js";
import { detectInstall } from "./install-type.js";

let root: string;
before(() => { root = mkdtempSync(join(tmpdir(), "omni-upd-state-")); });
after(() => { rmSync(root, { recursive: true, force: true }); });

let n = 0;
const fresh = (): string => { const d = join(root, `d${n++}`); mkdirSync(d, { recursive: true }); return d; };
const always = () => true;
const never = () => false;
const bundle = (version: string) => ({ version, dir: `/bundles/${version}` });

test("planBoot: no state runs the installed bundle", () => {
  const { plan, next } = planBoot(emptyState(), "1.0.0", always);
  assert.deepEqual(plan, { action: "run-installed", restore: false });
  assert.deepEqual(next, emptyState());
});

test("planBoot: newer active bundle that exists runs the bundle; verifying increments attempts", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), status: "verifying", attempts: 0 };
  const r = planBoot(s, "1.0.0", always);
  assert.equal(r.plan.action, "run-bundle");
  assert.deepEqual((r.plan as any).bundle, bundle("1.1.0"));
  assert.equal((r.plan as any).restore, false);
  assert.equal(r.next.attempts, 1);
  assert.equal(r.next.status, "verifying");
  // idle bundle: attempts unchanged
  const idle = planBoot({ ...s, status: "idle" }, "1.0.0", always);
  assert.equal(idle.plan.action, "run-bundle");
  assert.equal(idle.next.attempts, 0);
});

test("planBoot: active not newer than the installed version (installer upgrade) is ignored and cleared", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.0.0"), previous: null, status: "verifying", attempts: 1 };
  const r = planBoot(s, "1.2.0", always);
  assert.deepEqual(r.plan, { action: "run-installed", restore: false, reason: "installer upgrade overtook the stored bundle" });
  assert.equal(r.next.active, null);
  assert.equal(r.next.status, "idle");
  assert.equal(r.next.attempts, 0);
});

test("planBoot: missing bundle folder runs the installed bundle", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), status: "verifying" };
  const r = planBoot(s, "1.0.0", never);
  assert.equal(r.plan.action, "run-installed");
  assert.equal(r.next.active, null);
});

test("planBoot: a version in failed is never run again", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), failed: ["1.1.0"] };
  const r = planBoot(s, "1.0.0", always);
  assert.equal(r.plan.action, "run-installed");
  assert.equal(r.next.active, null);
});

test("planBoot: verifying with attempts >= max rolls back: run-installed with restore and a failed lastResult", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), status: "verifying", attempts: 3, backupDir: "/b/pre" };
  const r = planBoot(s, "1.0.0", always, 3, 1000);
  assert.deepEqual(r.plan, { action: "run-installed", restore: true, reason: "restoring the pre-update data" });
  assert.deepEqual(r.next.failed, ["1.1.0"]);
  assert.equal(r.next.active, null);
  assert.equal(r.next.restoreOnBoot, false);
  assert.equal(r.next.lastResult?.status, "failed");
  assert.equal(r.next.lastResult?.rolledBack, true);
  assert.match(r.next.lastResult?.message ?? "", /did not start after 3 attempts/);
  assert.equal(r.next.lastResult?.at, 1000);
});

test("planBoot: attempts below max still runs the bundle", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), status: "verifying", attempts: 2 };
  const r = planBoot(s, "1.0.0", always, 3);
  assert.equal(r.plan.action, "run-bundle");
  assert.equal(r.next.attempts, 3);
});

test("planBoot: restoreOnBoot restores then is cleared (run previous bundle when there is one)", () => {
  const installed = planBoot({ ...emptyState(), restoreOnBoot: true, backupDir: "/b" }, "1.0.0", always);
  assert.deepEqual(installed.plan, { action: "run-installed", restore: true, reason: "restoring the pre-update data" });
  assert.equal(installed.next.restoreOnBoot, false);

  const prev = planBoot({ ...emptyState(), active: bundle("1.1.0"), restoreOnBoot: true, backupDir: "/b" }, "1.0.0", always);
  assert.equal(prev.plan.action, "run-bundle");
  assert.equal((prev.plan as any).restore, true);
  assert.equal(prev.next.restoreOnBoot, false);
});

test("readState: missing file, corrupt JSON and non-object JSON give the empty state", () => {
  const d = fresh();
  assert.deepEqual(readState(d), emptyState());
  mkdirSync(join(d, "updates"));
  writeFileSync(statePath(d), "{not json");
  assert.deepEqual(readState(d), emptyState());
  writeFileSync(statePath(d), "[1,2]");
  assert.deepEqual(readState(d), emptyState());
});

test("readState: unknown keys are dropped, missing keys default, wrong types fall back", () => {
  const d = fresh();
  mkdirSync(join(d, "updates"));
  writeFileSync(statePath(d), JSON.stringify({
    active: { version: "1.1.0", dir: "/x", extra: 1 },
    previous: "nope",
    status: "bogus",
    attempts: -4,
    backupDir: 12,
    restoreOnBoot: "yes",
    verifyDeadline: "soon",
    failed: ["1.0.5", 7, "", "1.0.5"],
    lastResult: { status: "failed", version: "1.1.0", message: "m", at: 5, rolledBack: true },
    surprise: { nested: true },
  }));
  const s = readState(d);
  assert.deepEqual(s.active, { version: "1.1.0", dir: "/x" });
  assert.equal(s.previous, null);
  assert.equal(s.status, "idle");
  assert.equal(s.attempts, 0);
  assert.equal(s.backupDir, null);
  assert.equal(s.restoreOnBoot, false);
  assert.equal(s.verifyDeadline, null);
  assert.deepEqual(s.failed, ["1.0.5"]);
  assert.deepEqual(s.lastResult, { status: "failed", version: "1.1.0", message: "m", at: 5, acknowledged: false, rolledBack: true });
  assert.equal((s as any).surprise, undefined);
  assert.equal(s.v, 1);
});

test("readState: lastResult with a wrong status is dropped", () => {
  const d = fresh();
  mkdirSync(join(d, "updates"));
  writeFileSync(statePath(d), JSON.stringify({ lastResult: { status: "maybe", version: "1", message: "m", at: 1 } }));
  assert.equal(readState(d).lastResult, null);
});

test("writeState then readState round-trips, leaves no tmp files and uses mode 0600 where supported", () => {
  const d = fresh();
  const s = beginApply(emptyState(), { version: "1.1.0", dir: "/b/1.1.0", previous: null, backupDir: "/b/pre", deadlineMs: 60_000, now: 1_000 });
  writeState(d, s);
  assert.deepEqual(readState(d), s);
  const names = readdirFiles(join(d, "updates"));
  assert.deepEqual(names, ["state.json"]);
  if (process.platform !== "win32") assert.equal(statSync(statePath(d)).mode & 0o777, 0o600);
});

test("markVerified clears the attempt counter and records ok", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), status: "verifying", attempts: 2, backupDir: "/b", verifyDeadline: 9, restoreOnBoot: true };
  const v = markVerified(s, 500);
  assert.equal(v.status, "idle");
  assert.equal(v.attempts, 0);
  assert.equal(v.verifyDeadline, null);
  assert.equal(v.backupDir, null);
  assert.equal(v.restoreOnBoot, false);
  assert.deepEqual(v.lastResult, { status: "ok", version: "1.1.0", message: "started and verified", at: 500, acknowledged: false });
});

test("markFailed rolls back to previous, blacklists the version and asks for a restore when a backup exists", () => {
  const s: FileState = { ...emptyState(), active: bundle("1.1.0"), previous: bundle("1.0.5"), status: "verifying", attempts: 1, backupDir: "/b/pre" };
  const f = markFailed(s, "health check failed", 700);
  assert.deepEqual(f.active, bundle("1.0.5"));
  assert.equal(f.previous, null);
  assert.deepEqual(f.failed, ["1.1.0"]);
  assert.equal(f.restoreOnBoot, true);
  assert.equal(f.status, "idle");
  assert.deepEqual(f.lastResult, { status: "failed", rolledBack: true, version: "1.1.0", message: "health check failed", at: 700, acknowledged: false });
  const noBackup = markFailed({ ...s, backupDir: null }, "x", 1);
  assert.equal(noBackup.restoreOnBoot, false);
});

test("beginApply sets verifying, the deadline and clears restoreOnBoot", () => {
  const s: FileState = { ...emptyState(), restoreOnBoot: true };
  const b = beginApply(s, { version: "2.0.0", dir: "/b/2", previous: bundle("1.0.0"), backupDir: "/b/pre", deadlineMs: 60_000, now: 100 });
  assert.equal(b.status, "verifying");
  assert.deepEqual(b.active, { version: "2.0.0", dir: "/b/2" });
  assert.deepEqual(b.previous, bundle("1.0.0"));
  assert.equal(b.verifyDeadline, 60_100);
  assert.equal(b.attempts, 0);
  assert.equal(b.restoreOnBoot, false);
});

test("full cycle: apply, crash twice, then rollback on the fourth boot", () => {
  const d = fresh();
  const applied = beginApply(emptyState(), { version: "1.1.0", dir: "/b/1.1.0", previous: null, backupDir: "/b/pre", deadlineMs: 60_000, now: 0 });
  writeState(d, applied);
  let state = readState(d);
  for (let boot = 1; boot <= 3; boot++) {
    const r = planBoot(state, "1.0.0", always);
    assert.equal(r.plan.action, "run-bundle", `boot ${boot}`);
    writeState(d, r.next);
    state = readState(d);
  }
  const r = planBoot(state, "1.0.0", always);
  assert.equal(r.plan.action, "run-installed");
  assert.equal((r.plan as any).restore, true);
});

const readdirFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

// ---- pre-update backups ----

function makeDataDir(): { dataDir: string; parent: string } {
  const parent = fresh();
  const dataDir = join(parent, "data");
  mkdirSync(join(dataDir, "plugins", "dsh"), { recursive: true });
  mkdirSync(join(dataDir, "backups", "omnichat-old"), { recursive: true });
  mkdirSync(join(dataDir, "updates"), { recursive: true });
  writeFileSync(join(dataDir, "secret.key"), "a".repeat(64));
  writeFileSync(join(dataDir, "local-admin.token"), "tok-1");
  writeFileSync(join(dataDir, "effort-map.json"), "{}");
  writeFileSync(join(dataDir, "omnichat.db"), "LIVE-DB");
  writeFileSync(join(dataDir, "omnichat.db-wal"), "WAL");
  writeFileSync(join(dataDir, "omnichat.db-shm"), "SHM");
  writeFileSync(join(dataDir, "plugins", "dsh", "a.json"), "plugin-a");
  writeFileSync(join(dataDir, "backups", "omnichat-old", "x"), "x");
  writeFileSync(join(dataDir, "updates", "state.json"), "{}");
  writeFileSync(join(parent, "config.env"), "PORT=8787\n");
  return { dataDir, parent };
}

const vacuumFake = (target: string) => writeFileSync(target, "SNAPSHOT-DB");

test("createPreUpdateBackup: folder name, contents, excludes, manifest", () => {
  const { dataDir } = makeDataDir();
  const b = createPreUpdateBackup({ dataDir, oldVersion: "1.0.0", vacuumInto: vacuumFake, now: new Date(2026, 9, 18, 12, 30, 5) });
  assert.match(b.dir.split(/[\\/]/).pop()!, /^pre-update-1\.0\.0-20261018-123005$/);
  const names = readdirFiles(b.dir);
  for (const want of ["omnichat.db", "secret.key", "local-admin.token", "effort-map.json", "config.env", "manifest.json", "plugins"]) {
    assert.ok(names.includes(want), `missing ${want}: ${names}`);
  }
  assert.ok(!names.includes("omnichat.db-wal") && !names.includes("omnichat.db-shm"));
  assert.ok(!names.includes("backups") && !names.includes("updates"));
  assert.equal(readFileSync(join(b.dir, "omnichat.db"), "utf8"), "SNAPSHOT-DB");
  assert.equal(readFileSync(join(b.dir, "config.env"), "utf8"), "PORT=8787\n");
  assert.equal(readFileSync(join(b.dir, "plugins", "dsh", "a.json"), "utf8"), "plugin-a");
  const manifest = JSON.parse(readFileSync(join(b.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.oldVersion, "1.0.0");
  assert.equal(manifest.createdAt, new Date(2026, 9, 18, 12, 30, 5).toISOString());
  assert.ok(manifest.files.includes("plugins/dsh/a.json"));
  assert.ok(b.files.includes("manifest.json"));
});

test("createPreUpdateBackup: a failing snapshot removes the partial folder and rethrows", () => {
  const { dataDir } = makeDataDir();
  assert.throws(() => createPreUpdateBackup({ dataDir, oldVersion: "1.0.0", vacuumInto: () => { throw new Error("disk full"); }, now: new Date(2026, 0, 1) }), /disk full/);
  assert.deepEqual(listPreUpdateBackups(dataDir).filter((x) => x.name.includes("20260101")), []);
});

test("retention keeps the newest PRE_UPDATE_KEEP pre-update folders", () => {
  assert.equal(PRE_UPDATE_KEEP, 3);
  const { dataDir } = makeDataDir();
  const made: string[] = [];
  for (let i = 0; i < 5; i++) {
    made.push(createPreUpdateBackup({ dataDir, oldVersion: `1.0.${i}`, vacuumInto: vacuumFake, now: new Date(2026, 0, 1, 0, 0, i) }).dir);
  }
  const left = listPreUpdateBackups(dataDir).map((b) => b.oldVersion);
  assert.deepEqual(left, ["1.0.4", "1.0.3", "1.0.2"]);
  assert.equal(existsSync(made[0]), false);
  assert.equal(existsSync(made[1]), false);
  assert.equal(existsSync(made[4]), true);
  // the non-pre-update backup folder is untouched
  assert.ok(existsSync(join(dataDir, "backups", "omnichat-old", "x")));
});

test("restorePreUpdateBackup restores files, the DB, plugins and config.env, and deletes stale -wal/-shm", () => {
  const { dataDir, parent } = makeDataDir();
  const b = createPreUpdateBackup({ dataDir, oldVersion: "1.0.0", vacuumInto: vacuumFake, now: new Date(2026, 4, 5, 1, 1, 1) });
  // the update changed things after the snapshot
  writeFileSync(join(dataDir, "omnichat.db"), "MIGRATED-DB");
  writeFileSync(join(dataDir, "omnichat.db-wal"), "STALE-WAL");
  writeFileSync(join(dataDir, "omnichat.db-shm"), "STALE-SHM");
  writeFileSync(join(dataDir, "local-admin.token"), "tok-NEW");
  writeFileSync(join(parent, "config.env"), "PORT=9999\n");
  writeFileSync(join(dataDir, "plugins", "dsh", "a.json"), "changed");

  const restored = restorePreUpdateBackup({ dataDir, backupDir: b.dir, dbFileName: "omnichat.db" });
  assert.ok(restored.includes("omnichat.db") && restored.includes("secret.key") && restored.includes("config.env"));
  assert.equal(readFileSync(join(dataDir, "omnichat.db"), "utf8"), "SNAPSHOT-DB");
  assert.equal(existsSync(join(dataDir, "omnichat.db-wal")), false);
  assert.equal(existsSync(join(dataDir, "omnichat.db-shm")), false);
  assert.equal(readFileSync(join(dataDir, "local-admin.token"), "utf8"), "tok-1");
  assert.equal(readFileSync(join(parent, "config.env"), "utf8"), "PORT=8787\n");
  assert.equal(readFileSync(join(dataDir, "plugins", "dsh", "a.json"), "utf8"), "plugin-a");
  assert.equal(existsSync(join(dataDir, "omnichat.db-journal")), false);
});

test("restorePreUpdateBackup does not touch config.env when the backup has none", () => {
  const { dataDir, parent } = makeDataDir();
  const b = createPreUpdateBackup({ dataDir, oldVersion: "1.0.0", vacuumInto: vacuumFake, now: new Date(2026, 6, 1) });
  rmSync(join(parent, "config.env"));
  rmSync(join(b.dir, "config.env"));
  writeFileSync(join(parent, "config.env"), "LATER=1\n");
  restorePreUpdateBackup({ dataDir, backupDir: b.dir, dbFileName: "omnichat.db" });
  assert.equal(readFileSync(join(parent, "config.env"), "utf8"), "LATER=1\n");
});

test("restorePreUpdateBackup refuses a folder without a database snapshot", () => {
  const { dataDir } = makeDataDir();
  const empty = fresh();
  assert.throws(() => restorePreUpdateBackup({ dataDir, backupDir: empty, dbFileName: "omnichat.db" }), /no database snapshot/);
});

// ---- install type matrix ----

test("detectInstall: docker via env and via /.dockerenv", () => {
  const viaEnv = detectInstall({ OMNICHAT_DOCKER: "1" }, never, "dist/boot.js");
  assert.equal(viaEnv.type, "docker");
  assert.equal(viaEnv.selfUpdate, false);
  assert.equal(viaEnv.dockerCommand, "docker compose pull && docker compose up -d");
  const viaFs = detectInstall({}, (p) => p === "/.dockerenv", "dist/boot.js");
  assert.equal(viaFs.type, "docker");
  assert.equal(viaFs.selfUpdate, false);
});

test("detectInstall: server-app with and without OMNICHAT_BOOT", () => {
  const booted = detectInstall({ OMNICHAT_INSTALL_TYPE: "server-app", OMNICHAT_BOOT: "1" }, never, "C:/app/dist/boot.js");
  assert.deepEqual(booted, { type: "server-app", selfUpdate: true, reason: null, dockerCommand: null });
  const old = detectInstall({ OMNICHAT_INSTALL_TYPE: "server-app" }, never, "C:/app/dist/index.js");
  assert.equal(old.type, "server-app");
  assert.equal(old.selfUpdate, false);
  assert.equal(old.reason, "launcher predates the update system; install the new installer once");
});

test("detectInstall: each launcher type is recognised, unknown values are not", () => {
  for (const t of ["windows-service", "linux-service", "macos-service", "tarball"]) {
    assert.equal(detectInstall({ OMNICHAT_INSTALL_TYPE: t, OMNICHAT_BOOT: "1" }, never, "dist/boot.js").type, t);
  }
  assert.equal(detectInstall({ OMNICHAT_INSTALL_TYPE: "hacked", OMNICHAT_BOOT: "1" }, never, "dist/boot.js").type, "dev");
});

test("detectInstall: dev when running from source or without a launcher", () => {
  const src = detectInstall({ OMNICHAT_INSTALL_TYPE: "tarball", OMNICHAT_BOOT: "1" }, never, "C:/work/omnichat/server/src/index.ts");
  assert.equal(src.type, "dev");
  assert.equal(src.selfUpdate, false);
  assert.match(src.reason ?? "", /source/);
  const none = detectInstall({}, never, "dist/index.js");
  assert.equal(none.type, "dev");
  assert.equal(none.selfUpdate, false);
  assert.ok(none.reason);
});

