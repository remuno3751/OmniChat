import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, api, openWs, type TestServer } from "./test-server.js";

let S: TestServer;
let tok = "";
let devId = "";

before(async () => { S = await startServer(); });
after(() => S.stop());

test("first user is admin, later registration is disabled", async () => {
  const a = await api(S.base, "POST", "/auth/register", { username: "alice", password: "password123", deviceName: "Laptop", platform: "windows" });
  assert.equal(a.status, 200);
  assert.equal(a.json.isAdmin, true);
  assert.ok(a.json.deviceId && a.json.token);
  tok = a.json.token; devId = a.json.deviceId;
  const b = await api(S.base, "POST", "/auth/register", { username: "bobby", password: "password123" });
  assert.equal(b.status, 403);
  assert.equal(b.json.error, "registration is disabled");
});

test("ALLOW_REGISTRATION=1 allows more users (non-admin)", async () => {
  const s2 = await startServer({ ALLOW_REGISTRATION: "1" });
  try {
    const a = await api(s2.base, "POST", "/auth/register", { username: "alice", password: "password123" });
    const b = await api(s2.base, "POST", "/auth/register", { username: "bobby", password: "password123" });
    assert.equal(a.json.isAdmin, true);
    assert.equal(b.status, 200);
    assert.equal(b.json.isAdmin, false);
  } finally { s2.stop(); }
});

test("login without deviceName works; devices list and revocation", async () => {
  const l = await api(S.base, "POST", "/auth/login", { username: "alice", password: "password123" });
  assert.equal(l.status, 200);
  assert.equal(l.json.isAdmin, true);
  const tok2 = l.json.token, dev2 = l.json.deviceId;
  const list = await api(S.base, "GET", "/devices", undefined, tok);
  assert.equal(list.status, 200);
  const names = list.json.devices.map((d: any) => d.name);
  assert.ok(names.includes("Laptop") && names.includes("Unknown device"));
  assert.equal(list.json.devices.find((d: any) => d.id === devId).current, true);
  assert.equal(list.json.devices.find((d: any) => d.id === dev2).current, false);

  const ws = await openWs(`ws://127.0.0.1:${S.port}/ws?token=${tok2}`);
  const closed = new Promise<number>((res) => ws.once("close", (code) => res(code)));
  const del = await api(S.base, "DELETE", `/devices/${dev2}`, undefined, tok);
  assert.equal(del.status, 200);
  assert.equal(await closed, 4001);
  assert.equal((await api(S.base, "GET", "/devices", undefined, tok2)).status, 401);
  await assert.rejects(openWs(`ws://127.0.0.1:${S.port}/ws?token=${tok2}`));
  assert.equal((await api(S.base, "DELETE", `/devices/${dev2}`, undefined, tok)).status, 404);
});

test("logout revokes own device", async () => {
  const l = await api(S.base, "POST", "/auth/login", { username: "alice", password: "password123", deviceName: "Phone" });
  assert.equal((await api(S.base, "POST", "/auth/logout", {}, l.json.token)).status, 200);
  assert.equal((await api(S.base, "GET", "/devices", undefined, l.json.token)).status, 401);
  assert.equal((await api(S.base, "GET", "/devices", undefined, tok)).status, 200);
});

test("ping / version / healthz", async () => {
  const p = await api(S.base, "GET", "/ping");
  assert.ok(Math.abs(p.json.t - Date.now()) < 5000);
  const v = await api(S.base, "GET", "/version");
  assert.equal(v.json.name, "omnichat-server");
  assert.match(v.json.version, /^\d+\./);
  assert.equal(v.json.webUi, false);
  assert.equal(v.json.searxng, false);
  const h = await api(S.base, "GET", "/healthz");
  assert.equal(h.status, 200);
  assert.equal(h.text, "ok");
});

test("api keys: lifecycle and isolation from device auth", async () => {
  const k = await api(S.base, "POST", "/apikeys", { name: "dev" }, tok);
  assert.equal(k.status, 200);
  assert.match(k.json.key, /^ocsk-/);
  assert.ok(k.json.key.startsWith(k.json.prefix));
  const list = await api(S.base, "GET", "/apikeys", undefined, tok);
  assert.equal(list.json.keys.length, 1);
  assert.equal(list.json.keys[0].key, undefined);
  assert.equal(list.json.keys[0].lastUsedAt, null);
  assert.equal((await api(S.base, "GET", "/devices", undefined, k.json.key)).status, 401);
  assert.equal((await api(S.base, "GET", "/v1/models", undefined, tok)).status, 401);
  const m = await api(S.base, "GET", "/v1/models", undefined, k.json.key);
  assert.equal(m.status, 200);
  assert.equal(m.json.object, "list");
  assert.ok((await api(S.base, "GET", "/apikeys", undefined, tok)).json.keys[0].lastUsedAt > 0);
  assert.equal((await api(S.base, "DELETE", `/apikeys/${k.json.id}`, undefined, tok)).status, 200);
  assert.equal((await api(S.base, "GET", "/v1/models", undefined, k.json.key)).status, 401);
});

test("login rate limit: 10 failures -> 429", async () => {
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await api(S.base, "POST", "/auth/login", { username: "alice", password: "wrongpass" + i })).status;
  assert.equal(last, 401);
  assert.equal((await api(S.base, "POST", "/auth/login", { username: "alice", password: "password123" })).status, 429);
  assert.equal((await api(S.base, "POST", "/auth/login", { username: "nobody", password: "x" })).status, 401);
});

test("legacy session tokens migrate into Legacy devices", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omni-legacy-"));
  const old = new DatabaseSync(join(tmp, "t.db"));
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT INTO users VALUES ('u1','olduser','s','h',1);
INSERT INTO sessions VALUES ('legacytoken123','u1',1);`);
  old.close();
  const s = await startServer({}, tmp);
  try {
    const d = await api(s.base, "GET", "/devices", undefined, "legacytoken123");
    assert.equal(d.status, 200);
    assert.equal(d.json.devices[0].name, "Legacy");
    assert.equal((await api(s.base, "GET", "/devices", undefined, "nope")).status, 401);
  } finally { s.stop(); }
});

test("static web serving with SPA fallback that never shadows API", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omni-web-"));
  const web = join(tmp, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<html>SPA</html>");
  writeFileSync(join(web, "assets", "app-abc.js"), "console.log(1)");
  const s = await startServer({ WEB_DIR: web }, tmp);
  try {
    assert.equal((await api(s.base, "GET", "/version")).json.webUi, true);
    const root = await api(s.base, "GET", "/");
    assert.equal(root.text, "<html>SPA</html>");
    assert.match(root.headers.get("cache-control") ?? "", /no-cache/);
    const deep = await api(s.base, "GET", "/some/client/route");
    assert.equal(deep.status, 200);
    assert.equal(deep.text, "<html>SPA</html>");
    assert.match(deep.headers.get("cache-control") ?? "", /no-cache/);
    const asset = await api(s.base, "GET", "/assets/app-abc.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await api(s.base, "GET", "/assets/missing.js")).status, 404);
    assert.equal((await api(s.base, "GET", "/sync")).status, 401);
    assert.equal((await api(s.base, "GET", "/v1/models")).status, 401);
    const v1 = await api(s.base, "GET", "/v1/nonexistent");
    assert.equal(v1.status, 404);
    assert.ok(v1.json?.error?.message);
    assert.equal((await api(s.base, "GET", "/devices")).status, 401);
    assert.equal((await api(s.base, "GET", "/healthz")).text, "ok");
  } finally { s.stop(); }
});
