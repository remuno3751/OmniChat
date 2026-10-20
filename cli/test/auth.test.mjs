import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startFakeServer, PASSWORD, USERNAME } from "./helpers/fake-server.mjs";
import { makeHome, runCli, writeConfig, readConfig, runInProcess } from "./helpers/cli.mjs";

describe("login / logout / whoami", () => {
  let srv;
  let h;
  before(async () => { srv = await startFakeServer(); });
  after(async () => { await srv.close(); });
  test.beforeEach(() => { h = makeHome(); });

  test("login stores server, token and device; output never shows the password or token", async () => {
    const r = await runCli(["login", "--server", srv.url, "--username", USERNAME, "--debug"], {
      env: { OMNICHAT_PASSWORD: PASSWORD }, configPath: h.configPath, home: h.home,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Logged in to/);
    const cfg = readConfig(h.configPath);
    assert.equal(cfg.server, srv.url);
    assert.match(cfg.token, /^tok_/);
    assert.ok(cfg.deviceId);
    for (const text of [r.stdout, r.stderr]) {
      assert.ok(!text.includes(PASSWORD), "password must not be printed");
      assert.ok(!text.includes(cfg.token), "token must not be printed, even with --debug");
    }
    if (process.platform !== "win32") assert.equal(fs.statSync(h.configPath).mode & 0o777, 0o600);
  });

  test("login reads the password from stdin when it is not a TTY", async () => {
    const r = await runCli(["login", "--server", srv.url, "--username", USERNAME], { input: PASSWORD + "\n", configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(readConfig(h.configPath).token);
  });

  test("wrong password is a clear error with exit code 1 and nothing saved", async () => {
    const r = await runCli(["login", "--server", srv.url, "--username", USERNAME], { env: { OMNICHAT_PASSWORD: "wrong" }, configPath: h.configPath, home: h.home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /invalid username or password/);
    assert.equal(fs.existsSync(h.configPath), false);
  });

  test("login without --server is a usage error (exit 2)", async () => {
    const r = await runCli(["login", "--username", USERNAME], { env: { OMNICHAT_PASSWORD: PASSWORD }, configPath: h.configPath, home: h.home });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--server URL is required/);
  });

  test("unreachable server gives a helpful message", async () => {
    const r = await runCli(["login", "--server", "http://127.0.0.1:9", "--username", USERNAME], { env: { OMNICHAT_PASSWORD: PASSWORD }, configPath: h.configPath, home: h.home, timeoutMs: 15000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot reach server http:\/\/127\.0\.0\.1:9/);
    assert.match(r.stderr, /OMNICHAT_SERVER/);
  });

  test("registration disabled is explained", async () => {
    const off = await startFakeServer({ registration: false });
    try {
      const r = await runCli(["login", "--register", "--server", off.url, "--username", "bob"], { env: { OMNICHAT_PASSWORD: "x-password" }, configPath: h.configPath, home: h.home });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /registration is disabled on this server/);
    } finally {
      await off.close();
    }
  });

  test("whoami shows user, server and current device", async () => {
    writeConfig(h.configPath, { server: srv.url, username: USERNAME, token: srv.seededToken, deviceId: srv.seededDeviceId });
    const r = await runCli(["whoami"], { configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${USERNAME} @ ${srv.url.replace(/[.]/g, "\\.")}`));
    assert.match(r.stdout, /device: seed/);
    const j = await runCli(["whoami", "--json"], { configPath: h.configPath, home: h.home });
    assert.equal(JSON.parse(j.stdout).device.name, "seed");
  });

  test("a revoked or invalid token says to run omnichat login (401)", async () => {
    writeConfig(h.configPath, { server: srv.url, token: "tok_revoked" });
    const r = await runCli(["models"], { configPath: h.configPath, home: h.home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /401[\s\S]*omnichat login/i);
  });

  test("OMNICHAT_TOKEN and OMNICHAT_SERVER override the saved config", async () => {
    writeConfig(h.configPath, { server: "http://127.0.0.1:9", token: "tok_saved_bad" });
    const r = await runCli(["whoami"], { env: { OMNICHAT_SERVER: srv.url, OMNICHAT_TOKEN: srv.seededToken }, configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`@ ${srv.url}`), r.stdout);
  });

  test("a saved token is never sent to a different server", async () => {
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    const before = srv.state.log.length;
    const r = await runCli(["whoami", "--server", "http://127.0.0.1:9"], { configPath: h.configPath, home: h.home, timeoutMs: 15000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not logged in/);
    const sent = srv.state.log.slice(before).filter((e) => e.auth === srv.seededToken);
    assert.equal(sent.length, 0);
  });

  test("logout revokes the device on the server and removes the token locally", async () => {
    const dev = await runCli(["login", "--server", srv.url, "--username", USERNAME], { env: { OMNICHAT_PASSWORD: PASSWORD }, configPath: h.configPath, home: h.home });
    assert.equal(dev.code, 0);
    const token = readConfig(h.configPath).token;
    assert.ok(srv.state.tokens.has(token));
    const r = await runCli(["logout"], { configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(srv.state.tokens.has(token), false, "server must revoke the token");
    const cfg = readConfig(h.configPath);
    assert.equal(cfg.token, undefined);
    assert.equal(cfg.server, srv.url, "server URL is kept");
  });

  test("logout when not logged in is a no-op", async () => {
    const r = await runCli(["logout"], { configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /not logged in/);
  });
});

test("in-process login prompts for the username when missing on a TTY", async () => {
  const srv = await startFakeServer();
  const h = makeHome();
  try {
    const asked = [];
    const r = await runInProcess(["login", "--server", srv.url], {
      env: { OMNICHAT_PASSWORD: PASSWORD }, configPath: h.configPath, home: h.home, isTTY: true,
      ask: async (q) => { asked.push(q); return USERNAME; },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(asked, ["Username: "]);
    assert.equal(readConfig(h.configPath).username, USERNAME);
  } finally {
    await srv.close();
  }
});

test("token redaction: --debug output for a request carries no token", async () => {
  const srv = await startFakeServer();
  const h = makeHome();
  try {
    writeConfig(h.configPath, { server: srv.url, token: srv.seededToken });
    const r = await runCli(["models", "--debug"], { configPath: h.configPath, home: h.home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\[debug\] --> GET \/models/);
    assert.ok(!r.stderr.includes(srv.seededToken));
    assert.ok(!r.stdout.includes(srv.seededToken));
  } finally {
    await srv.close();
  }
});
