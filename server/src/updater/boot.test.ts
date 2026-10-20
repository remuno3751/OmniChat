import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { bootMain, stopWatchdog } from "../boot.js";
import { DB_PATH } from "../config.js";
import { HOST_EPOCH, pruneBundles, stageBundle, validateBundleDir } from "./bundle.js";
import { createPreUpdateBackup } from "./preupdate.js";
import { RESTART_EXIT_CODE } from "./restart.js";
import { beginApply, emptyState, markFailed, readState, writeState, type FileState } from "./state.js";

// ---------- fixtures (generated at runtime, nothing committed) ----------

const bases: string[] = [];
function makeBase(): string {
  const b = mkdtempSync(join(tmpdir(), "omni-c8a-"));
  bases.push(b);
  return b;
}

/** Files of a small valid bundle. */
function bundleFiles(version: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "dist/index.js": "export {};\n",
    "dist/boot.js": "export {};\n",
    "package.json": JSON.stringify({ name: "omnichat-server", version }),
    "bundle.json": JSON.stringify({ version, minNode: "24.0.0", minHostEpoch: HOST_EPOCH }),
    VERSION: `${version}\n`,
    "web/index.html": "<!doctype html>",
    ...extra,
  };
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

async function zipOf(files: Record<string, string>, extra?: (z: JSZip) => void): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, content] of Object.entries(files)) z.file(name, content);
  extra?.(z);
  return z.generateAsync({ type: "nodebuffer" });
}

/**
 * Turns the named entry into a Unix symlink in the central directory: "version made by" = Unix (3.30) and
 * external attributes = S_IFLNK | 0777 in the high 16 bits. (JSZip does not write these bits itself.)
 */
function markSymlinkEntry(buf: Buffer, name: string): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 46 <= out.length; i++) {
    if (out.readUInt32LE(i) !== 0x02014b50) continue;
    const len = out.readUInt16LE(i + 28);
    if (out.toString("utf8", i + 46, i + 46 + len) !== name) continue;
    out.writeUInt16LE(0x031e, i + 4);
    out.writeUInt32LE((0o120777 << 16) >>> 0, i + 38);
  }
  return out;
}

/** Every path below dir (relative, forward slashes), used to prove nothing outside a folder changed. */
function walkAll(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory()) out.push(...walkAll(dir, r));
  }
  return out.sort();
}

const indexUrl = (root: string): string => pathToFileURL(join(resolve(root), "dist", "index.js")).href;

function spyImport(calls: string[], onImport?: (url: string) => void): (url: string) => Promise<unknown> {
  return async (url: string) => {
    calls.push(url);
    onImport?.(url);
    return {};
  };
}

const ENV_KEYS = ["OMNICHAT_BOOT", "OMNICHAT_BUNDLE_ROOT", "WEB_DIR", "OMNICHAT_START_DELAY_MS"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
});

afterEach(() => {
  stopWatchdog();
  delete (globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy;
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

// ---------- validateBundleDir ----------

describe("validateBundleDir", () => {
  test("accepts a complete bundle", () => {
    const base = makeBase();
    const dir = join(base, "b");
    writeTree(dir, bundleFiles("1.1.0"));
    const r = validateBundleDir(dir, "1.1.0");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.manifest.version, "1.1.0");
  });

  test("rejects a missing dist/index.js", () => {
    const base = makeBase();
    const dir = join(base, "b");
    const files = bundleFiles("1.1.0");
    delete (files as Record<string, string | undefined>)["dist/index.js"];
    writeTree(dir, files);
    const r = validateBundleDir(dir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /dist\/index\.js/);
  });

  test("rejects a wrong version", () => {
    const base = makeBase();
    const dir = join(base, "b");
    writeTree(dir, bundleFiles("1.1.0"));
    const r = validateBundleDir(dir, "1.2.0");
    assert.equal(r.ok, false);
  });

  test("rejects minNode higher than the running Node", () => {
    const base = makeBase();
    const dir = join(base, "b");
    writeTree(dir, bundleFiles("1.1.0", {
      "bundle.json": JSON.stringify({ version: "1.1.0", minNode: "99.0.0", minHostEpoch: 1 }),
    }));
    const r = validateBundleDir(dir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Node/);
  });

  test("rejects minHostEpoch higher than this host", () => {
    const base = makeBase();
    const dir = join(base, "b");
    writeTree(dir, bundleFiles("1.1.0", {
      "bundle.json": JSON.stringify({ version: "1.1.0", minNode: "24.0.0", minHostEpoch: HOST_EPOCH + 1 }),
    }));
    const r = validateBundleDir(dir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /full installer/);
  });

  test("rejects a folder with neither bundle.json nor VERSION", () => {
    const base = makeBase();
    const dir = join(base, "b");
    const files = bundleFiles("1.1.0");
    delete (files as Record<string, string | undefined>)["bundle.json"];
    delete (files as Record<string, string | undefined>).VERSION;
    writeTree(dir, files);
    assert.equal(validateBundleDir(dir).ok, false);
  });
});

// ---------- stageBundle ----------

describe("stageBundle", () => {
  test("happy path: extracts, validates and renames atomically", async () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, await zipOf(bundleFiles("1.1.0")));

    const { dir } = await stageBundle({ zipFile, version: "1.1.0", updatesDir });
    assert.equal(dir, join(updatesDir, "bundles", "1.1.0"));
    assert.ok(existsSync(join(dir, "dist", "index.js")));
    assert.ok(existsSync(join(dir, "web", "index.html")));
    assert.equal(readFileSync(join(dir, "VERSION"), "utf8").trim(), "1.1.0");
    assert.equal(existsSync(join(updatesDir, "bundles", "1.1.0.tmp")), false);
    assert.equal(validateBundleDir(dir, "1.1.0").ok, true);
  });

  test("restaging the same version replaces the folder", async () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, await zipOf(bundleFiles("1.1.0")));
    await stageBundle({ zipFile, version: "1.1.0", updatesDir });
    const again = await stageBundle({ zipFile, version: "1.1.0", updatesDir });
    assert.ok(existsSync(join(again.dir, "dist", "index.js")));
  });

  test("failure leaves no .tmp folder and no final folder (missing dist/boot.js)", async () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    const files = bundleFiles("1.1.0");
    delete (files as Record<string, string | undefined>)["dist/boot.js"];
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, await zipOf(files));
    await assert.rejects(stageBundle({ zipFile, version: "1.1.0", updatesDir }), /dist\/boot\.js/);
    const names = readdirSync(join(updatesDir, "bundles"));
    assert.deepEqual(names, []);
  });

  test("version mismatch between zip and requested version is rejected", async () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, await zipOf(bundleFiles("1.1.0")));
    await assert.rejects(stageBundle({ zipFile, version: "1.2.0", updatesDir }));
    assert.deepEqual(readdirSync(join(updatesDir, "bundles")), []);
  });

  test("a file that is not a zip is rejected", async () => {
    const base = makeBase();
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, "not a zip at all");
    await assert.rejects(stageBundle({ zipFile, version: "1.1.0", updatesDir: join(base, "updates") }), /zip/);
  });

  test("an unsafe version string is rejected before anything is written", async () => {
    const base = makeBase();
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, await zipOf(bundleFiles("1.1.0")));
    await assert.rejects(stageBundle({ zipFile, version: "../1.1.0", updatesDir: join(base, "updates") }));
    assert.equal(existsSync(join(base, "updates")), false);
  });

  // Zip-slip: each malicious entry is built next to a valid bundle, so the rejection must come from the entry check.
  const evilNames = [
    "../evil.txt",
    "../../evil.txt",
    "dist/../../evil.txt",
    "/abs.txt",
    "C:\\win.txt",
    "..\\evil.txt",
    "dist\\..\\..\\evil.txt",
  ];
  for (const name of evilNames) {
    test(`zip-slip: entry "${name}" is rejected and nothing outside updates/ changes`, async () => {
      const base = makeBase();
      const updatesDir = join(base, "updates");
      mkdirSync(join(updatesDir, "bundles"), { recursive: true });
      const zipFile = join(base, "bundle.zip");
      writeFileSync(zipFile, await zipOf({ ...bundleFiles("1.1.0"), [name]: "pwned" }));
      const before = walkAll(base);
      await assert.rejects(stageBundle({ zipFile, version: "1.1.0", updatesDir }), /unsafe|escape|bundle/);
      assert.deepEqual(walkAll(base), before);
      assert.equal(existsSync(join(base, "evil.txt")), false);
      assert.equal(existsSync(join(base, "abs.txt")), false);
      assert.equal(existsSync(join(base, "win.txt")), false);
    });
  }

  test("zip-slip: a symlink entry is rejected", async () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    mkdirSync(join(updatesDir, "bundles"), { recursive: true });
    const zipFile = join(base, "bundle.zip");
    writeFileSync(zipFile, markSymlinkEntry(await zipOf(bundleFiles("1.1.0"), (z) => {
      z.file("dist/link.js", "/etc/passwd");
    }), "dist/link.js"));
    const before = walkAll(base);
    await assert.rejects(stageBundle({ zipFile, version: "1.1.0", updatesDir }), /symlink/);
    assert.deepEqual(walkAll(base), before);
  });

  test("pruneBundles keeps only the listed folders and removes leftover .tmp folders", () => {
    const base = makeBase();
    const updatesDir = join(base, "updates");
    for (const v of ["1.0.0", "1.1.0", "1.2.0"]) writeTree(join(updatesDir, "bundles", v), bundleFiles(v));
    mkdirSync(join(updatesDir, "bundles", "1.3.0.tmp"), { recursive: true });
    const removed = pruneBundles(updatesDir, ["1.2.0"]);
    assert.equal(removed, 3);
    assert.deepEqual(readdirSync(join(updatesDir, "bundles")), ["1.2.0"]);
  });
});

// ---------- bootMain ----------

interface Fixture { base: string; installedRoot: string; dataDir: string; bundleDir: string }

/** Installed app at 1.0.0 and a staged 1.1.0 bundle under the data dir. */
function fixture(): Fixture {
  const base = makeBase();
  const installedRoot = join(base, "app");
  const dataDir = join(base, "data");
  const bundleDir = join(dataDir, "updates", "bundles", "1.1.0");
  writeTree(installedRoot, bundleFiles("1.0.0"));
  writeTree(bundleDir, bundleFiles("1.1.0"));
  return { base, installedRoot, dataDir, bundleDir };
}

function saveState(dataDir: string, patch: Partial<FileState>): void {
  writeState(dataDir, { ...emptyState(), ...patch });
}

describe("bootMain", () => {
  test("(1) no state: runs the installed bundle", async () => {
    const f = fixture();
    const calls: string[] = [];
    const r = await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls) });
    assert.equal(r.ran, "installed");
    assert.deepEqual(calls, [indexUrl(f.installedRoot)]);
    assert.equal(process.env.OMNICHAT_BUNDLE_ROOT, resolve(f.installedRoot));
    assert.equal(process.env.OMNICHAT_BOOT, "1");
    assert.equal(existsSync(join(f.dataDir, "updates", "state.json")), true, "state is written on every boot");
  });

  test("(2) active newer bundle: imports the bundle index and swaps the web dir", async () => {
    const f = fixture();
    saveState(f.dataDir, { active: { version: "1.1.0", dir: f.bundleDir }, status: "idle" });
    const calls: string[] = [];
    const r = await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls) });
    assert.equal(r.ran, "bundle");
    assert.equal(r.dir, f.bundleDir);
    assert.deepEqual(calls, [indexUrl(f.bundleDir)]);
    assert.equal(process.env.OMNICHAT_BUNDLE_ROOT, f.bundleDir);
    assert.equal(process.env.WEB_DIR, join(f.bundleDir, "web"), "unset WEB_DIR points at the bundle");

    // WEB_DIR still at the installed web folder: swapped
    process.env.WEB_DIR = join(f.installedRoot, "web");
    await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport([]) });
    assert.equal(process.env.WEB_DIR, join(f.bundleDir, "web"));

    // operator-chosen WEB_DIR: left alone
    const custom = join(f.base, "custom-web");
    process.env.WEB_DIR = custom;
    await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport([]) });
    assert.equal(process.env.WEB_DIR, custom);
  });

  test("(2b) a bundle that is not newer than the installed version is ignored", async () => {
    const f = fixture();
    saveState(f.dataDir, { active: { version: "0.9.0", dir: f.bundleDir }, status: "idle" });
    const calls: string[] = [];
    const r = await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls) });
    assert.equal(r.ran, "installed");
    assert.deepEqual(calls, [indexUrl(f.installedRoot)]);
    assert.equal(readState(f.dataDir).active, null);
  });

  test("(3) import throws: version blacklisted, restart requested, next boot runs installed", async () => {
    const f = fixture();
    saveState(f.dataDir, { active: { version: "1.1.0", dir: f.bundleDir }, status: "idle" });
    const calls: string[] = [];
    const restarts: string[] = [];
    const importFn = async (url: string) => {
      calls.push(url);
      if (url === indexUrl(f.bundleDir)) throw new Error("cannot find module");
      return {};
    };
    const r = await bootMain({
      installedRoot: f.installedRoot, dataDir: f.dataDir, importFn, restart: (reason) => restarts.push(reason),
    });
    assert.equal(r.ran, "installed");
    assert.deepEqual(restarts, ["bundle failed to start"]);
    assert.equal(RESTART_EXIT_CODE, 75);
    assert.deepEqual(calls, [indexUrl(f.bundleDir), indexUrl(f.installedRoot)]);

    const st = readState(f.dataDir);
    assert.deepEqual(st.failed, ["1.1.0"]);
    assert.equal(st.active, null);
    assert.equal(st.lastResult?.status, "failed");
    assert.equal(st.lastResult?.rolledBack, true);
    assert.match(st.lastResult?.message ?? "", /cannot find module/);

    // same state on the next boot: installed, no second restart
    const calls2: string[] = [];
    const r2 = await bootMain({
      installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls2), restart: (reason) => restarts.push(reason),
    });
    assert.equal(r2.ran, "installed");
    assert.deepEqual(calls2, [indexUrl(f.installedRoot)]);
    assert.equal(restarts.length, 1);
  });

  test("(3b) a bundle that fails validation is blacklisted without importing it", async () => {
    const f = fixture();
    rmSync(join(f.bundleDir, "dist", "boot.js"));
    saveState(f.dataDir, { active: { version: "1.1.0", dir: f.bundleDir }, status: "idle" });
    const calls: string[] = [];
    const restarts: string[] = [];
    const r = await bootMain({
      installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls), restart: (reason) => restarts.push(reason),
    });
    assert.equal(r.ran, "installed");
    assert.deepEqual(calls, [indexUrl(f.installedRoot)]);
    assert.equal(restarts.length, 1);
    assert.deepEqual(readState(f.dataDir).failed, ["1.1.0"]);
  });

  test("(4) rollback restores the pre-update backup BEFORE the entry is imported", async () => {
    const f = fixture();
    const dbName = basename(DB_PATH);
    writeFileSync(join(f.dataDir, dbName), "OLD-DB");
    writeFileSync(join(f.dataDir, "secret.key"), "OLD-KEY");
    const backup = createPreUpdateBackup({
      dataDir: f.dataDir,
      oldVersion: "1.0.0",
      vacuumInto: (target) => writeFileSync(target, "OLD-DB"),
    });
    // the failed update changed the live data
    writeFileSync(join(f.dataDir, dbName), "NEW-DB");
    writeFileSync(join(f.dataDir, "secret.key"), "NEW-KEY");

    const s = markFailed(
      beginApply(emptyState(), {
        version: "1.1.0", dir: f.bundleDir, previous: null, backupDir: backup.dir, deadlineMs: 60_000, now: Date.now(),
      }),
      "verification failed", Date.now(),
    );
    writeState(f.dataDir, s);
    assert.equal(s.restoreOnBoot, true);

    const seen: { url: string; db: string; key: string }[] = [];
    const r = await bootMain({
      installedRoot: f.installedRoot,
      dataDir: f.dataDir,
      importFn: spyImport([], (url) => {
        seen.push({
          url,
          db: readFileSync(join(f.dataDir, dbName), "utf8"),
          key: readFileSync(join(f.dataDir, "secret.key"), "utf8"),
        });
      }),
    });
    assert.equal(r.ran, "installed");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, indexUrl(f.installedRoot));
    assert.equal(seen[0].db, "OLD-DB", "database restored before the import");
    assert.equal(seen[0].key, "OLD-KEY", "key restored before the import");
    assert.ok(r.restored.includes(dbName));
    assert.ok(r.restored.includes("secret.key"));
    assert.equal(readState(f.dataDir).restoreOnBoot, false);
  });

  test("(4b) a failing restore exits 1 and does not start the server", async () => {
    const f = fixture();
    saveState(f.dataDir, {
      active: null,
      status: "idle",
      restoreOnBoot: true,
      backupDir: join(f.dataDir, "backups", "missing"),
      failed: ["1.1.0"],
    });
    const calls: string[] = [];
    const codes: number[] = [];
    await bootMain({
      installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls), exit: (c) => codes.push(c),
    });
    assert.deepEqual(codes, [1]);
    assert.deepEqual(calls, []);
    assert.equal(readState(f.dataDir).restoreOnBoot, true, "the next start retries the restore");
  });

  test("(5) crash-loop guard: attempts >= 3 rolls back without importing the bundle", async () => {
    const f = fixture();
    saveState(f.dataDir, {
      active: { version: "1.1.0", dir: f.bundleDir },
      status: "verifying",
      attempts: 3,
      verifyDeadline: Date.now() + 60_000,
    });
    const calls: string[] = [];
    const restarts: string[] = [];
    const r = await bootMain({
      installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls), restart: (x) => restarts.push(x),
    });
    assert.equal(r.ran, "installed");
    assert.deepEqual(calls, [indexUrl(f.installedRoot)]);
    assert.deepEqual(restarts, []);
    const st = readState(f.dataDir);
    assert.deepEqual(st.failed, ["1.1.0"]);
    assert.equal(st.status, "idle");
  });

  test("(5b) a verifying bundle counts one more attempt on each start", async () => {
    const f = fixture();
    saveState(f.dataDir, {
      active: { version: "1.1.0", dir: f.bundleDir },
      status: "verifying",
      attempts: 0,
      verifyDeadline: Date.now() + 60_000,
    });
    const calls: string[] = [];
    const r = await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport(calls) });
    assert.equal(r.ran, "bundle");
    assert.deepEqual(calls, [indexUrl(f.bundleDir)]);
    assert.equal(readState(f.dataDir).attempts, 1);
  });

  test("(6) watchdog: a bundle that never reports healthy is rolled back at the deadline", async () => {
    const f = fixture();
    saveState(f.dataDir, {
      active: { version: "1.1.0", dir: f.bundleDir },
      status: "verifying",
      attempts: 0,
      verifyDeadline: Date.now() + 30,
    });
    const restarts: string[] = [];
    await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport([]), restart: (x) => restarts.push(x) });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(restarts, ["bundle failed to start"]);
    const st = readState(f.dataDir);
    assert.deepEqual(st.failed, ["1.1.0"]);
    assert.equal(st.active, null);
  });

  test("(6b) watchdog: a healthy bundle is left alone", async () => {
    const f = fixture();
    saveState(f.dataDir, {
      active: { version: "1.1.0", dir: f.bundleDir },
      status: "verifying",
      attempts: 0,
      verifyDeadline: Date.now() + 30,
    });
    const restarts: string[] = [];
    await bootMain({ installedRoot: f.installedRoot, dataDir: f.dataDir, importFn: spyImport([]), restart: (x) => restarts.push(x) });
    (globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy = true;
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(restarts, []);
    assert.deepEqual(readState(f.dataDir).failed, []);
  });
});
