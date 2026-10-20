// Update service tests: in-process (fake GitHub, fake VACUUM INTO, fake restart, temp DATA_DIR) plus an HTTP-level
// pass over the routes against a real server child process.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { startFakeGithub, type FakeGithub, type FakeRelease } from "./fake-github.js";
import { GithubClient } from "./github.js";
import { startServer, api, type TestServer } from "../test-server.js";

// In-process DB on a temp file. Env must be set BEFORE anything that loads config.ts / db.ts (dynamic imports below).
const tmpRoot = mkdtempSync(join(tmpdir(), "omni-upd-svc-"));
process.env.DATA_DIR = tmpRoot;
process.env.DB_PATH = join(tmpRoot, "t.db");
process.env.OMNICHAT_SECRET_KEY = "service-test-master-key-123";
delete process.env.OMNICHAT_UPDATE_TOKEN;
delete process.env.OMNICHAT_UPDATE_CHANNEL;
delete process.env.OMNICHAT_UPDATE_CHECK_HOURS;
delete process.env.OMNICHAT_UPDATE_API_BASE;
delete process.env.OMNICHAT_UPDATE_ALLOW_HTTP;

const svcMod = await import("./service.js");
const store = await import("./store.js");
const stateMod = await import("./state.js");
const preMod = await import("./preupdate.js");
const { rawDb } = await import("../db.js");
type Over = Record<string, unknown>;

const REPO = "remuno3751/omnichat";
const INSTALLED_NODE = { type: "server-app", selfUpdate: true, reason: null, dockerCommand: null } as const;

let fake: FakeGithub;
before(async () => { fake = await startFakeGithub(); });
after(async () => {
  await fake.stop();
  rawDb.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rawDb.exec("DELETE FROM server_settings WHERE key IN ('update', 'update_state')");
  fake.setReleases([]);
  fake.setRateLimit(false);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

/** A small valid server bundle (pure fixture; the real bundle has far more). */
async function bundleZip(version: string, omit: string[] = []): Promise<Buffer> {
  const z = new JSZip();
  const files: Record<string, string> = {
    "dist/index.js": "console.log('index');\n",
    "dist/boot.js": "console.log('boot');\n",
    "package.json": JSON.stringify({ name: "omnichat-server", version }) + "\n",
    "bundle.json": JSON.stringify({ version, minNode: "24.0.0", minHostEpoch: 1 }) + "\n",
    VERSION: version + "\n",
  };
  for (const k of omit) delete files[k];
  for (const [k, v] of Object.entries(files)) z.file(k, v);
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function release(version: string, zip: Buffer, extra: Partial<FakeRelease> = {}): FakeRelease {
  return {
    tag: `v${version}`,
    body: `notes for ${version}`,
    assets: [{ name: `omnichat-server-bundle-${version}.zip`, data: zip }],
    ...extra,
  };
}

interface Made {
  svc: InstanceType<typeof svcMod.UpdateService>;
  dataDir: string;
  restarts: string[];
  vacuums: { count: number };
}

/** A service over a fresh temp DATA_DIR. Defaults: installed server-app, running 1.0.0, GitHub = fake. */
function make(over: Over = {}): Made {
  const dataDir = (over.dataDir as string | undefined) ?? mkdtempSync(join(tmpRoot, "data-"));
  const restarts: string[] = [];
  const vacuums = { count: 0 };
  const svc = svcMod.createUpdateService({
    dataDir,
    currentVersion: "1.0.0",
    runningRoot: join(dataDir, "installed"),
    install: () => ({ ...INSTALLED_NODE }),
    createGithub: () => new GithubClient({ apiBase: fake.base, repo: REPO, allowHttp: true }),
    vacuumInto: (target: string) => {
      vacuums.count++;
      writeFileSync(target, "fake sqlite snapshot");
    },
    restart: (reason: string) => { restarts.push(reason); },
    health: async () => ({ ok: true }),
    now: () => Date.now(),
    restartDelayMs: 0,
    firstCheckDelayMs: 3_600_000,
    verifyPollMs: 5,
    ...over,
  } as Parameters<typeof svcMod.createUpdateService>[0]);
  return { svc, dataDir, restarts, vacuums };
}

const codeOf = (fn: () => unknown) => (e: any) => e?.code === fn();

describe("check", () => {
  test("finds a newer release and reports the bundle as available", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make();
    const st = await m.svc.checkNow();
    assert.equal(st.current, "1.0.0");
    assert.equal(st.latest?.version, "1.1.0");
    assert.equal(st.updateAvailable, true);
    assert.equal(st.bundleAssetFound, true);
    assert.equal(st.lastError, null);
    assert.equal(typeof st.lastCheckedAt, "number");
    assert.equal(st.phase, "idle");
    assert.equal(st.isAdmin, true);
    assert.equal(m.svc.status(false).isAdmin, false);
  });

  test("the same or an older release is not an update", async () => {
    fake.setReleases([release("0.9.0", await bundleZip("0.9.0"))]);
    const st = await make().svc.checkNow();
    assert.equal(st.latest?.version, "0.9.0");
    assert.equal(st.updateAvailable, false);
  });

  test("skip list hides the version from the skipped flag until unskipped", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make();
    await m.svc.checkNow();
    store.skipVersion("v1.1.0");
    let st = m.svc.status(true);
    assert.equal(st.skipped, true);
    assert.deepEqual(st.skippedVersions, ["1.1.0"]);
    assert.equal(st.updateAvailable, true);
    store.unskipVersion("1.1.0");
    st = m.svc.status(true);
    assert.equal(st.skipped, false);
    assert.deepEqual(st.skippedVersions, []);
  });

  test("stable ignores prereleases, prerelease channel sees them (and the channel choice persists)", async () => {
    fake.setReleases([
      release("1.2.0-rc.1", await bundleZip("1.2.0-rc.1"), { prerelease: true }),
      release("1.1.0", await bundleZip("1.1.0")),
    ]);
    const m = make();
    const stable = await m.svc.checkNow();
    assert.equal(stable.channel, "stable");
    assert.equal(stable.latest?.version, "1.1.0");

    const pre = await m.svc.checkNow({ channel: "prerelease" });
    assert.equal(pre.channel, "prerelease");
    assert.equal(pre.latest?.version, "1.2.0-rc.1");
    assert.equal(pre.latest?.prerelease, true);
    assert.equal(store.getUpdateSettings().channel, "prerelease");
    store.setUpdateSettings({ channel: "stable" });
  });

  test("second check sends If-None-Match and gets a 304", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make();
    await m.svc.checkNow();
    const before304 = fake.hits.notModified;
    const st = await m.svc.checkNow();
    assert.equal(fake.hits.notModified, before304 + 1);
    assert.equal(st.latest?.version, "1.1.0");
    assert.equal(st.lastError, null);
  });

  test("rate limit is reported with a readable message", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    fake.setRateLimit(true);
    try {
      const st = await make().svc.checkNow();
      assert.equal(st.lastError?.code, "rate-limited");
      assert.match(st.lastError?.message ?? "", /rate limit/i);
      assert.equal(st.phase, "idle");
    } finally {
      fake.setRateLimit(false);
    }
  });
});

describe("apply", () => {
  test("happy path: verified bundle staged, backup taken, state swapped, restart requested", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make();
    await m.svc.checkNow();
    const r = await m.svc.apply();
    assert.equal(r.ok, true);
    await m.svc.settled();

    const st = m.svc.status(true);
    assert.equal(st.phase, "restarting");
    assert.equal(st.lastError, null);

    const s = stateMod.readState(m.dataDir);
    assert.equal(s.active?.version, "1.1.0");
    assert.equal(s.previous, null); // the installed bundle was running
    assert.equal(s.status, "verifying");
    assert.ok(s.backupDir && existsSync(s.backupDir), "pre-update backup folder exists");
    assert.equal(s.active?.dir, join(m.dataDir, "updates", "bundles", "1.1.0"));
    assert.ok(existsSync(join(s.active!.dir, "dist", "index.js")), "bundle folder is present");
    assert.ok(existsSync(join(s.backupDir!, "omnichat.db")), "database snapshot is in the backup");
    assert.equal(m.vacuums.count, 1);
    assert.equal(readdirSync(join(m.dataDir, "updates", "downloads")).length, 0, "downloaded zip removed");

    const raw = JSON.parse(readFileSync(stateMod.statePath(m.dataDir), "utf8"));
    assert.equal(raw.status, "verifying");
    assert.equal(raw.active.version, "1.1.0");

    await waitFor(() => m.restarts.length === 1);
    assert.match(m.restarts[0], /1\.1\.0/);
  });

  test("wrong checksum: checksum-mismatch and nothing changes on disk", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"), { withSums: "wrong" })]);
    const m = make();
    await m.svc.checkNow();
    await m.svc.apply();
    await m.svc.settled();

    const st = m.svc.status(true);
    assert.equal(st.phase, "error");
    assert.equal(st.lastError?.code, "checksum-mismatch");
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false, "state.json untouched");
    assert.equal(existsSync(join(m.dataDir, "updates", "bundles", "1.1.0")), false, "no bundle folder");
    assert.equal(preMod.listPreUpdateBackups(m.dataDir).length, 0, "no pre-update backup");
    assert.equal(readdirSync(join(m.dataDir, "updates", "downloads")).length, 0, "bad zip deleted");
    assert.equal(m.vacuums.count, 0);
    assert.deepEqual(m.restarts, []);
  });

  test("release without any checksum asset is refused with checksum-missing", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"), { withSums: "none" })]);
    const m = make();
    await m.svc.checkNow();
    assert.equal(m.svc.status(true).bundleAssetFound, false);
    await assert.rejects(m.svc.apply(), codeOf(() => "checksum-missing"));
    assert.equal(m.svc.status(true).phase, "idle");
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false);
  });

  test("SHA256SUMS that does not list the bundle is checksum-missing (found at job time)", async () => {
    fake.setReleases([
      release("1.1.0", await bundleZip("1.1.0"), {
        withSums: "none",
        assets: [
          { name: "omnichat-server-bundle-1.1.0.zip", data: await bundleZip("1.1.0") },
          { name: "SHA256SUMS", data: `${"a".repeat(64)}  some-other-file.zip\n` },
        ],
      }),
    ]);
    const m = make();
    await m.svc.checkNow();
    assert.equal(m.svc.status(true).bundleAssetFound, true, "a checksum asset exists");
    await m.svc.apply();
    await m.svc.settled();
    const st = m.svc.status(true);
    assert.equal(st.phase, "error");
    assert.equal(st.lastError?.code, "checksum-missing");
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false);
    assert.equal(existsSync(join(m.dataDir, "updates", "bundles", "1.1.0")), false);
  });

  test("docker install: unsupported with the pull command", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make({
      install: () => ({ type: "docker", selfUpdate: false, reason: "running in Docker", dockerCommand: "docker compose pull && docker compose up -d" }),
    });
    await m.svc.checkNow();
    await assert.rejects(m.svc.apply(), (e: any) => e.code === "unsupported" && /docker compose pull/.test(e.message));
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false);
  });

  test("a second apply while one runs is busy", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make();
    await m.svc.checkNow();
    await m.svc.apply();
    await assert.rejects(m.svc.apply(), codeOf(() => "busy"));
    await m.svc.settled();
    assert.equal(m.svc.status(true).phase, "restarting");
  });

  test("apply refuses versions that are not newer", async () => {
    fake.setReleases([release("0.9.0", await bundleZip("0.9.0"))]);
    const m = make();
    await m.svc.checkNow();
    await assert.rejects(m.svc.apply(), codeOf(() => "other"));
  });

  test("backup failure: phase error, state untouched, staged bundle removed, no restart", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make({ vacuumInto: () => { throw new Error("disk full"); } });
    await m.svc.checkNow();
    await m.svc.apply();
    await m.svc.settled();
    const st = m.svc.status(true);
    assert.equal(st.phase, "error");
    assert.match(st.lastError?.message ?? "", /pre-update backup failed/);
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false);
    assert.equal(existsSync(join(m.dataDir, "updates", "bundles", "1.1.0")), false);
    assert.equal(preMod.listPreUpdateBackups(m.dataDir).length, 0);
    assert.deepEqual(m.restarts, []);
  });

  test("a zip that is not a valid bundle is bundle-invalid and changes nothing", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0", ["dist/boot.js"]))]);
    const m = make();
    await m.svc.checkNow();
    await m.svc.apply();
    await m.svc.settled();
    const st = m.svc.status(true);
    assert.equal(st.phase, "error");
    assert.equal(st.lastError?.code, "bundle-invalid");
    assert.equal(existsSync(stateMod.statePath(m.dataDir)), false);
    assert.equal(m.vacuums.count, 0);
  });

  test("the token never appears in an error message", async () => {
    const token = "ghp_svc_secret_token_42";
    store.setUpdateSettings({ githubToken: token });
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const m = make({ vacuumInto: () => { throw new Error(`leak test ${token}`); } });
    await m.svc.checkNow();
    await m.svc.apply();
    await m.svc.settled();
    const st = m.svc.status(true);
    assert.equal(st.phase, "error");
    assert.equal(JSON.stringify(st).includes(token), false);
    store.setUpdateSettings({ githubToken: null });
  });
});

describe("post-boot verification", () => {
  function stagedState(dataDir: string, o: { health: boolean; deadlineMs?: number }) {
    const root = join(dataDir, "updates", "bundles", "1.1.0");
    mkdirSync(root, { recursive: true });
    const backup = join(dataDir, "backups", "pre-update-1.0.0-20260101-000000");
    mkdirSync(backup, { recursive: true });
    const st = stateMod.beginApply(stateMod.emptyState(), {
      version: "1.1.0", dir: root, previous: null, backupDir: backup, deadlineMs: 60_000, now: Date.now(),
    });
    stateMod.writeState(dataDir, { ...st, verifyDeadline: Date.now() + (o.deadlineMs ?? 60_000) });
    return { root, backup };
  }

  test("healthy new bundle is marked verified and the process stays up", async () => {
    const dataDir = mkdtempSync(join(tmpRoot, "boot-ok-"));
    const { root } = stagedState(dataDir, { health: true });
    const m = make({ dataDir, runningRoot: root, currentVersion: "1.1.0", health: async () => ({ ok: true }) });
    try {
      m.svc.start();
      await waitFor(() => stateMod.readState(dataDir).status === "idle");
      const s = stateMod.readState(dataDir);
      assert.equal(s.lastResult?.status, "ok");
      assert.equal(s.backupDir, null);
      assert.equal(s.active?.version, "1.1.0");
      assert.equal((globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy, true);
      assert.deepEqual(m.restarts, []);
    } finally {
      m.svc.stop();
      delete (globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy;
    }
  });

  test("failing health check rolls back: version blacklisted, restore on next boot, restart requested", async () => {
    const dataDir = mkdtempSync(join(tmpRoot, "boot-bad-"));
    const { root, backup } = stagedState(dataDir, { health: false, deadlineMs: -1 });
    const m = make({ dataDir, runningRoot: root, currentVersion: "1.1.0", health: async () => ({ ok: false, reason: "boom" }) });
    try {
      m.svc.start();
      await waitFor(() => m.restarts.length === 1);
      const s = stateMod.readState(dataDir);
      assert.equal(s.active, null);
      assert.deepEqual(s.failed, ["1.1.0"]);
      assert.equal(s.restoreOnBoot, true);
      assert.equal(s.lastResult?.status, "failed");
      assert.equal(s.lastResult?.rolledBack, true);
      assert.match(s.lastResult?.message ?? "", /boom/);
      assert.match(m.restarts[0], /rollback/);
      assert.equal(existsSync(backup), true);

      // the failure is shown until acknowledged
      assert.equal(m.svc.status(true).lastApply?.acknowledged, false);
      m.svc.acknowledge();
      assert.equal(stateMod.readState(dataDir).lastResult?.acknowledged, true);
      assert.equal(m.svc.status(true).lastApply?.acknowledged, true);
    } finally {
      m.svc.stop();
    }
  });

  test("health check retries until the deadline", async () => {
    const dataDir = mkdtempSync(join(tmpRoot, "boot-retry-"));
    const { root } = stagedState(dataDir, { health: true, deadlineMs: 60_000 });
    let calls = 0;
    const m = make({
      dataDir, runningRoot: root, currentVersion: "1.1.0",
      health: async () => { calls++; return calls < 3 ? { ok: false, reason: "not yet" } : { ok: true }; },
    });
    try {
      m.svc.start();
      await waitFor(() => stateMod.readState(dataDir).status === "idle");
      assert.equal(calls, 3);
      assert.equal(stateMod.readState(dataDir).lastResult?.status, "ok");
    } finally {
      m.svc.stop();
      delete (globalThis as { __omnichatHealthy?: boolean }).__omnichatHealthy;
    }
  });
});

describe("HTTP routes", () => {
  let S: TestServer;
  let adminTok = "";
  let userTok = "";
  const SECRET = "ghp_http_route_secret_0001";
  const seen: string[] = [];
  const keep = (text: string) => { seen.push(text); return text; };

  before(async () => {
    S = await startServer({
      OMNICHAT_UPDATE_API_BASE: fake.base,
      OMNICHAT_UPDATE_ALLOW_HTTP: "1",
      OMNICHAT_OPEN_FIRST_REGISTRATION: "1",
      ALLOW_REGISTRATION: "1",
      OMNICHAT_UPDATE_FIRST_DELAY_MS: "3600000",
    });
    const a = await api(S.base, "POST", "/auth/register", { username: "admin1", password: "password123" });
    adminTok = a.json.token;
    const u = await api(S.base, "POST", "/auth/register", { username: "user1", password: "password123" });
    userTok = u.json.token;
    assert.equal(a.json.isAdmin, true);
    assert.equal(u.json.isAdmin, false);
  });
  after(() => S.stop());

  test("status needs a token; non-admin can read it, admin-only mutations refuse", async () => {
    assert.equal((await api(S.base, "GET", "/update/status")).status, 401);
    const r = await api(S.base, "GET", "/update/status", undefined, userTok);
    assert.equal(r.status, 200);
    assert.equal(r.json.isAdmin, false);
    assert.equal(r.json.installType, "dev");
    assert.equal(r.json.selfUpdate, false);
    assert.equal(r.json.tokenSet, false);
    assert.equal((await api(S.base, "POST", "/update/check", {}, userTok)).status, 403);
    assert.equal((await api(S.base, "POST", "/update/apply", {}, userTok)).status, 403);
    assert.equal((await api(S.base, "POST", "/update/ack", {}, userTok)).status, 403);
  });

  test("admin check finds the release; skip and unskip round trip", async () => {
    fake.setReleases([release("1.1.0", await bundleZip("1.1.0"))]);
    const c = await api(S.base, "POST", "/update/check", {}, adminTok);
    assert.equal(c.status, 200);
    assert.equal(c.json.latest.version, "1.1.0");
    assert.equal(c.json.isAdmin, true);

    assert.equal((await api(S.base, "POST", "/update/skip", { version: "1.1.0" }, userTok)).status, 403);
    assert.equal((await api(S.base, "POST", "/update/skip", { version: "not-a-version" }, adminTok)).status, 400);
    const sk = await api(S.base, "POST", "/update/skip", { version: "v1.1.0" }, adminTok);
    assert.equal(sk.status, 200);
    assert.equal(sk.json.skipped, true);
    const un = await api(S.base, "POST", "/update/unskip", { version: "1.1.0" }, adminTok);
    assert.equal(un.json.skipped, false);
  });

  test("bad channel in check is 400", async () => {
    assert.equal((await api(S.base, "POST", "/update/check", { channel: "nightly" }, adminTok)).status, 400);
  });

  test("PUT /update/config validates and never echoes the token", async () => {
    const cfg = (body: unknown, tok = adminTok) => api(S.base, "PUT", "/update/config", body, tok);
    assert.equal((await cfg({ checkHours: 1.5 })).status, 400);
    assert.equal((await cfg({ checkHours: 721 })).status, 400);
    assert.equal((await cfg({ checkHours: "6" })).status, 400);
    assert.equal((await cfg({ channel: "nightly" })).status, 400);
    assert.equal((await cfg({ githubToken: 5 })).status, 400);
    assert.equal((await cfg({ checkHours: 6 }, userTok)).status, 403);

    const ok = await cfg({ checkHours: 6, channel: "prerelease", githubToken: SECRET });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.checkHours, 6);
    assert.equal(ok.json.channel, "prerelease");
    assert.equal(ok.json.tokenSet, true);
    keep(ok.text);

    const st = await api(S.base, "GET", "/update/status", undefined, userTok);
    assert.equal(st.json.tokenSet, true);
    keep(st.text);

    const cleared = await cfg({ githubToken: null, channel: "stable" });
    assert.equal(cleared.json.tokenSet, false);
    assert.equal(cleared.json.channel, "stable");
    keep(cleared.text);
  });

  test("apply on a dev install is 409 unsupported; ack works for admin", async () => {
    const r = await api(S.base, "POST", "/update/apply", {}, adminTok);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "unsupported");
    assert.equal((await api(S.base, "POST", "/update/apply", { version: "bad" }, adminTok)).status, 400);
    assert.equal((await api(S.base, "POST", "/update/ack", {}, adminTok)).status, 200);
  });

  test("/version reports the install type", async () => {
    const v = await api(S.base, "GET", "/version");
    assert.equal(v.json.installType, "dev");
    assert.equal(v.json.selfUpdate, false);
    assert.equal(typeof v.json.version, "string");
  });

  test("the token is never returned by any update endpoint", () => {
    for (const text of seen) assert.equal(text.includes(SECRET), false);
  });
});
