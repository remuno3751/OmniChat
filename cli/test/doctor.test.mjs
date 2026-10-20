import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHome, runCli, writeConfig } from "./helpers/cli.mjs";

const TOKEN = "tok-secret-123";
const DIAG = "# Diagnostics\n\n- uptime: 42 s\n- providers: 3\n";

/** A small server with /healthz and /admin/diagnostics. `forbidden` answers 403 for the admin route. */
function startDoctorServer({ forbidden = false } = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    const auth = req.headers.authorization ?? "";
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    if (req.url === "/admin/diagnostics") {
      if (auth !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (forbidden) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "admin only" }));
      }
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      return res.end(DIAG);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** A port that nothing listens on (bound, then released). */
function closedPortUrl() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}

let srv;
let forbiddenSrv;
let h;
before(async () => {
  srv = await startDoctorServer();
  forbiddenSrv = await startDoctorServer({ forbidden: true });
  h = makeHome();
});
after(async () => {
  await srv.close();
  await forbiddenSrv.close();
});

test("doctor: all checks OK against a server with a valid admin token", async () => {
  const cfg = path.join(h.home, "ok", "config.json");
  writeConfig(cfg, { server: srv.url, token: TOKEN });
  const r = await runCli(["doctor"], { configPath: cfg, home: h.home });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^# omnichat doctor\n\n## Local checks\n/);
  assert.match(r.stdout, /- \[OK\] node: v\d+/);
  assert.match(r.stdout, /- \[OK\] port: /);
  assert.match(r.stdout, /- \[OK\] healthz: /);
  assert.match(r.stdout, /- \[OK\] token: /);
  assert.match(r.stdout, /- \[OK\] server diagnostics: /);
  assert.ok(r.stdout.includes("\n## Server diagnostics\n" + DIAG), r.stdout);
  assert.ok(!r.stdout.includes("[FAIL]"), r.stdout);
  assert.ok(!r.stdout.includes(TOKEN), "token must not be printed");
});

test("doctor: unreachable server reports it and exits 1", async () => {
  const dead = await closedPortUrl();
  const cfg = path.join(h.home, "dead", "config.json");
  writeConfig(cfg, { server: dead, token: TOKEN });
  const r = await runCli(["doctor"], { configPath: cfg, home: h.home });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /- \[FAIL\] port: .*not reachable \(/);
  assert.ok(!r.stdout.includes("- [OK] healthz"), "healthz is skipped when the port is closed");
  assert.match(r.stdout, /server unreachable or request failed: /);
  assert.ok(!r.stdout.includes(TOKEN));
});

test("doctor: no token exits 1 and does not call the diagnostics route", async () => {
  const cfg = path.join(h.home, "notoken", "config.json");
  writeConfig(cfg, { server: srv.url });
  const r = await runCli(["doctor"], { configPath: cfg, home: h.home });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /- \[FAIL\] token: no token: run `omnichat login` or set OMNICHAT_TOKEN/);
  assert.ok(!r.stdout.includes("server diagnostics"), r.stdout);
  assert.match(r.stdout, /skipped: no token/);
});

test("doctor: a non-admin token gets the admin message and exits 1", async () => {
  const cfg = path.join(h.home, "forbidden", "config.json");
  writeConfig(cfg, { server: forbiddenSrv.url, token: TOKEN });
  const r = await runCli(["doctor"], { configPath: cfg, home: h.home });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /- \[FAIL\] server diagnostics: forbidden: the account must be an admin/);
  assert.match(r.stdout, /server unreachable or request failed: forbidden \(403\)/);
});

test("doctor: --data-dir pointing at a writable directory is OK", async () => {
  const cfg = path.join(h.home, "data-ok", "config.json");
  writeConfig(cfg, { server: srv.url, token: TOKEN });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnichat-doctor-data-"));
  try {
    const r = await runCli(["doctor", "--data-dir", dir], { configPath: cfg, home: h.home });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /- \[OK\] data dir: /);
    assert.deepEqual(fs.readdirSync(dir), [], "the probe file is removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: --data-dir that does not exist is FAIL and exits 1", async () => {
  const cfg = path.join(h.home, "data-missing", "config.json");
  writeConfig(cfg, { server: srv.url, token: TOKEN });
  const missing = path.join(h.home, "no-such-dir");
  const r = await runCli(["doctor", "--data-dir", missing], { configPath: cfg, home: h.home });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /- \[FAIL\] data dir: does not exist: /);
});

test("doctor: a missing config is FAIL without --server, WARN with --server", async () => {
  const cfg = path.join(h.home, "absent", "config.json");
  const bad = await runCli(["doctor"], { configPath: cfg, home: h.home });
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /- \[FAIL\] config file: not found at .*run `omnichat login`/);

  const warn = await runCli(["doctor", "--server", srv.url], { configPath: cfg, home: h.home, env: { OMNICHAT_TOKEN: TOKEN } });
  assert.equal(warn.code, 0, warn.stdout + warn.stderr);
  assert.match(warn.stdout, /- \[WARN\] config file: not found/);
  assert.match(warn.stdout, /- \[OK\] server diagnostics: /);
});
