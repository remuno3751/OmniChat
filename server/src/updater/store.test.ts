import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// In-process DB on a temp file. Set the env BEFORE importing anything that loads config.ts / db.ts.
const tmp = mkdtempSync(join(tmpdir(), "omni-upd-store-"));
process.env.DATA_DIR = tmp;
process.env.DB_PATH = join(tmp, "t.db");
process.env.OMNICHAT_SECRET_KEY = "store-test-master-key-123";
delete process.env.OMNICHAT_UPDATE_TOKEN;
delete process.env.OMNICHAT_UPDATE_CHANNEL;
delete process.env.OMNICHAT_UPDATE_CHECK_HOURS;

const store = await import("./store.js");
const { rawDb } = await import("../db.js");

before(() => { /* DB opened by the import above */ });
after(() => {
  rawDb.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  rawDb.exec("DELETE FROM server_settings WHERE key IN ('update', 'update_state')");
  delete process.env.OMNICHAT_UPDATE_TOKEN;
  delete process.env.OMNICHAT_UPDATE_CHANNEL;
  delete process.env.OMNICHAT_UPDATE_CHECK_HOURS;
});

const rawRow = (key: string): string => {
  const r = rawDb.prepare("SELECT value FROM server_settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? "";
};

test("defaults: stable channel, 12 hours, nothing skipped, no token", () => {
  const s = store.getUpdateSettings();
  assert.deepEqual(s, { channel: "stable", checkHours: 12, skipped: [], tokenSet: false });
});

test("env defaults apply until the DB holds a value", () => {
  process.env.OMNICHAT_UPDATE_CHANNEL = "prerelease";
  process.env.OMNICHAT_UPDATE_CHECK_HOURS = "5";
  assert.equal(store.getUpdateSettings().channel, "prerelease");
  assert.equal(store.getUpdateSettings().checkHours, 5);
  store.setUpdateSettings({ channel: "stable", checkHours: 0 });
  assert.equal(store.getUpdateSettings().channel, "stable");
  assert.equal(store.getUpdateSettings().checkHours, 0);
});

test("env with junk values falls back to the built-in defaults", () => {
  process.env.OMNICHAT_UPDATE_CHANNEL = "nightly";
  process.env.OMNICHAT_UPDATE_CHECK_HOURS = "soon";
  const s = store.getUpdateSettings();
  assert.equal(s.channel, "stable");
  assert.equal(s.checkHours, 12);
});

test("checkHours is clamped to 0..720 and truncated", () => {
  assert.equal(store.setUpdateSettings({ checkHours: 1000 }).checkHours, 720);
  assert.equal(store.setUpdateSettings({ checkHours: -5 }).checkHours, 0);
  assert.equal(store.setUpdateSettings({ checkHours: 2.7 }).checkHours, 2);
  assert.equal(store.clampCheckHours("abc", 12), 12);
  assert.equal(store.clampCheckHours("30", 12), 30);
  assert.throws(() => store.setUpdateSettings({ checkHours: Number.NaN }));
});

test("invalid channel is rejected and not stored", () => {
  assert.throws(() => store.setUpdateSettings({ channel: "nightly" as any }), /channel/);
  assert.equal(store.getUpdateSettings().channel, "stable");
});

test("skip / unskip / isSkipped normalise a leading v and never duplicate", () => {
  store.skipVersion("v1.2.3");
  store.skipVersion("1.2.3");
  assert.deepEqual(store.getUpdateSettings().skipped, ["1.2.3"]);
  assert.equal(store.isSkipped("v1.2.3"), true);
  assert.equal(store.isSkipped("1.2.4"), false);
  assert.equal(store.isSkipped("../evil"), false);
  store.unskipVersion("V1.2.3");
  assert.deepEqual(store.getUpdateSettings().skipped, []);
  assert.throws(() => store.skipVersion("bad version!"));
});

test("GitHub token is stored encrypted, returned decrypted only via getUpdateToken, cleared with null", () => {
  const plain = "ghp_TESTTOKEN1234567890";
  const s = store.setUpdateSettings({ githubToken: plain });
  assert.equal(s.tokenSet, true);
  const raw = rawRow("update");
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes(plain), "plaintext token must not be in the row");
  assert.ok(raw.includes("enc1:"), "token must carry the encryption prefix");
  assert.equal(store.getUpdateToken(), plain);
  assert.ok(!JSON.stringify(store.getUpdateSettings()).includes(plain), "settings never expose the token");

  // a later patch without githubToken keeps it
  store.setUpdateSettings({ channel: "prerelease" });
  assert.equal(store.getUpdateToken(), plain);

  assert.equal(store.setUpdateSettings({ githubToken: null }).tokenSet, false);
  assert.equal(store.getUpdateToken(), "");
});

test("token from the env is used when the DB holds none; the DB value wins over the env", () => {
  process.env.OMNICHAT_UPDATE_TOKEN = "  env-token-value-1  ";
  assert.equal(store.getUpdateToken(), "env-token-value-1");
  assert.equal(store.getUpdateSettings().tokenSet, true);
  store.setUpdateSettings({ githubToken: "db-token-value-2" });
  assert.equal(store.getUpdateToken(), "db-token-value-2");
});

test("invalid token is rejected", () => {
  assert.throws(() => store.setUpdateSettings({ githubToken: "has space in it" }), /githubToken/);
  assert.throws(() => store.setUpdateSettings({ githubToken: "short" }), /githubToken/);
});

test("runtime cache round-trips and merges patches", () => {
  assert.deepEqual(store.getRuntime(), { lastCheckedAt: null, lastError: null, etag: null, releases: null });
  store.setRuntime({ lastCheckedAt: 1234, etag: 'W/"abc"' });
  store.setRuntime({ lastError: { code: "network", message: "offline", at: 5 } });
  const r = store.getRuntime();
  assert.equal(r.lastCheckedAt, 1234);
  assert.equal(r.etag, 'W/"abc"');
  assert.deepEqual(r.lastError, { code: "network", message: "offline", at: 5 });
  store.setRuntime({ lastError: null });
  assert.equal(store.getRuntime().lastError, null);
  assert.equal(store.getRuntime().lastCheckedAt, 1234);
});

test("corrupt stored JSON reads as defaults", () => {
  rawDb.prepare("INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)").run("update", "{broken", Date.now());
  const s = store.getUpdateSettings();
  assert.equal(s.channel, "stable");
  assert.equal(s.checkHours, 12);
});
