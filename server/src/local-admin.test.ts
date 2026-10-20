import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startServer, api, type TestServer } from "./test-server.js";
import { connect, type Client } from "./test-chat-util.js";

let s: TestServer;
let tok = "";
const adm = (method: string, path: string, body?: unknown, token = tok) => api(s.base, method, path, body, "", { "x-local-admin": token });

before(async () => {
  // the product default: nobody can register the first account over HTTP
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" });
  tok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
});
after(() => s?.stop());

test("first account cannot be registered over HTTP when no administrator exists", async () => {
  const r = await api(s.base, "POST", "/auth/register", { username: "intruder", password: "password123" });
  assert.equal(r.status, 403);
  assert.match(r.text, /administrator/i);
});

test("local admin API: token required, create admin/user, login, list, role, disable, password reset, last-admin guard", async () => {
  assert.equal((await adm("GET", "/local-admin/status", undefined, "")).status, 401);
  assert.equal((await adm("GET", "/local-admin/status", undefined, "x".repeat(64))).status, 401);
  assert.equal((await api(s.base, "GET", "/local-admin/users", undefined, "", { "x-local-admin": tok, "x-forwarded-for": "1.2.3.4" })).status, 403, "proxied requests are refused");
  const st = await adm("GET", "/local-admin/status");
  assert.equal(st.status, 200);
  assert.equal(st.json.users, 0);

  assert.equal((await adm("POST", "/local-admin/users", { username: "boss", password: "short", role: "admin" })).status, 400);
  assert.equal((await adm("POST", "/local-admin/users", { username: "boss", password: "password123", role: "root" })).status, 400);
  const boss = await adm("POST", "/local-admin/users", { username: "boss", password: "password123", role: "admin" });
  assert.equal(boss.status, 200, boss.text);
  assert.equal((await adm("POST", "/local-admin/users", { username: "BOSS", password: "password123", role: "user" })).status, 409);
  const bob = (await adm("POST", "/local-admin/users", { username: "bob", password: "password123", role: "user" })).json;

  const login = await api(s.base, "POST", "/auth/login", { username: "boss", password: "password123" });
  assert.equal(login.status, 200);
  assert.equal(login.json.isAdmin, true);
  const bobLogin = await api(s.base, "POST", "/auth/login", { username: "bob", password: "password123" });
  assert.equal(bobLogin.json.isAdmin, false);
  // a regular user's token is not an admin credential and cannot use the local API
  assert.equal((await adm("GET", "/local-admin/users", undefined, bobLogin.json.token)).status, 401);

  const users = (await adm("GET", "/local-admin/users")).json.users as any[];
  assert.deepEqual(users.map((u) => [u.username, u.role]), [["boss", "admin"], ["bob", "user"]]);

  // disable: login refused, existing token dead, enable restores login
  assert.equal((await adm("PATCH", `/local-admin/users/${bob.id}`, { disabled: true })).status, 200);
  assert.equal((await api(s.base, "POST", "/auth/login", { username: "bob", password: "password123" })).status, 401);
  assert.equal((await api(s.base, "GET", "/devices", undefined, bobLogin.json.token)).status, 401);
  await adm("PATCH", `/local-admin/users/${bob.id}`, { disabled: false });
  assert.equal((await api(s.base, "POST", "/auth/login", { username: "bob", password: "password123" })).status, 200);

  // password reset signs the user out and the new password works
  const again = await api(s.base, "POST", "/auth/login", { username: "bob", password: "password123" });
  assert.equal((await adm("POST", `/local-admin/users/${bob.id}/password`, { password: "another-password" })).status, 200);
  assert.equal((await api(s.base, "GET", "/devices", undefined, again.json.token)).status, 401);
  assert.equal((await api(s.base, "POST", "/auth/login", { username: "bob", password: "password123" })).status, 401);
  assert.equal((await api(s.base, "POST", "/auth/login", { username: "bob", password: "another-password" })).status, 200);

  // roles and the last-admin guard
  assert.equal((await adm("PATCH", `/local-admin/users/${boss.json.id}`, { role: "user" })).status, 409);
  assert.equal((await adm("PATCH", `/local-admin/users/${boss.json.id}`, { disabled: true })).status, 409);
  assert.equal((await adm("PATCH", `/local-admin/users/${bob.id}`, { role: "admin" })).status, 200);
  assert.equal((await adm("PATCH", `/local-admin/users/${boss.json.id}`, { role: "user" })).status, 200);
  assert.equal((await adm("PATCH", "/local-admin/users/nope", { role: "user" })).status, 404);
});

test("admin CLI works on the same data directory", () => {
  const env = { ...process.env, DATA_DIR: s.tmp, DB_PATH: join(s.tmp, "t.db"), OMNICHAT_ADMIN_PASSWORD: "cli-password-1" };
  const run = (...a: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/admin-cli.ts", ...a], { cwd: join(import.meta.dirname, ".."), env, encoding: "utf8" });
  const c = run("create", "clidude", "--role", "user");
  assert.equal(c.status, 0, c.stderr);
  const l = run("list");
  assert.match(l.stdout, /clidude\tuser/);
  assert.equal(run("create", "clidude").status, 1, "duplicate name");
});

test("local admin overview and backups need the token and report live data", async () => {
  assert.equal((await adm("GET", "/local-admin/overview", undefined, "")).status, 401);
  const o = await adm("GET", "/local-admin/overview");
  assert.equal(o.status, 200);
  const j = JSON.parse(o.text);
  assert.equal(j.activeChats, 0);
  assert.equal(j.connections.sockets, 0);
  assert.ok(Array.isArray(j.bridges) && Array.isArray(j.localServers) && Array.isArray(j.providers));
  const b = JSON.parse((await adm("POST", "/local-admin/backups")).text);
  assert.match(b.name, /^omnichat-.*\.db$/);
  assert.equal(JSON.parse((await adm("GET", "/local-admin/backups")).text).backups.length, 1);
  assert.equal((await adm("DELETE", `/local-admin/backups/${b.name}`)).status, 200);
  assert.equal((await adm("DELETE", `/local-admin/backups/${b.name}`)).status, 404);
});

test("local admin can add and remove a provider for a user (visible to that user)", async () => {
  assert.equal((await adm("POST", "/local-admin/providers", { name: "X", baseUrl: "http://localhost:1234/v1" }, "")).status, 401);
  assert.equal((await adm("POST", "/local-admin/providers", { name: "X", baseUrl: "http://localhost:1234/v1", kind: "nope" })).status, 400);
  assert.equal((await adm("POST", "/local-admin/providers", { name: "", baseUrl: "http://localhost:1234/v1" })).status, 400);
  assert.equal((await adm("POST", "/local-admin/providers", { name: "X", baseUrl: "http://localhost:1234/v1", owner: "ghost" })).status, 404);
  const add = await adm("POST", "/local-admin/providers", { name: "My LLM", baseUrl: "http://localhost:1234/v1", model: "m1", apiKey: "sk-secret", owner: "bob" });
  assert.equal(add.status, 200, add.text);
  const id = add.json.id as string;
  const ov = (await adm("GET", "/local-admin/overview")).json.providers as any[];
  const mine = ov.find((p) => p.id === id);
  assert.deepEqual([mine.owner, mine.name, mine.kind, mine.model], ["bob", "My LLM", "openai-compatible", "m1"]);
  assert.ok(!JSON.stringify(ov).includes("sk-secret"), "the api key is never returned");
  const login = await api(s.base, "POST", "/auth/login", { username: "bob", password: "another-password" });
  const list = await api(s.base, "GET", "/sync?since=0", undefined, login.json.token);
  assert.ok((list.json.providers as any[]).some((p) => p.id === id), list.text.slice(0, 200));
  assert.equal((await adm("DELETE", `/local-admin/providers/${id}`)).status, 200);
  assert.equal((await adm("DELETE", `/local-admin/providers/${id}`)).status, 404);
  assert.equal(((await adm("GET", "/local-admin/overview")).json.providers as any[]).some((p) => p.id === id), false);
});

test("local admin maintenance mode: token required, validated, reflected publicly, broadcast to connected users", async () => {
  const M = (body?: unknown, t = tok) => api(s.base, "PUT", "/local-admin/maintenance", body, "", { "x-local-admin": t });
  const G = () => adm("GET", "/local-admin/maintenance");
  assert.equal((await adm("GET", "/local-admin/maintenance", undefined, "")).status, 401);
  assert.equal((await M({ enabled: true }, "")).status, 401);
  assert.equal((await api(s.base, "GET", "/local-admin/maintenance", undefined, "", { "x-local-admin": tok, "x-forwarded-for": "1.2.3.4" })).status, 403, "proxied requests are refused");

  const g0 = await G();
  assert.equal(g0.status, 200);
  assert.equal(g0.json.maintenance.enabled, false);

  // strict validation, same rules as PUT /admin/maintenance
  for (const bad of [{}, [], { enabled: "yes" }, { message: 5 }, { message: "x".repeat(501) }, { eta: -1 }, { eta: "soon" }, { eta: 1.5 }, { clearEta: 1 }, { nope: true }]) {
    assert.equal((await M(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await M({ message: "x".repeat(500) })).status, 200, "500 characters is allowed");
  assert.equal((await M({ message: "" })).status, 200, "empty message is allowed");
  assert.equal((await G()).json.maintenance.enabled, false, "rejected writes change nothing");

  // a regular user connected over WebSocket
  assert.equal((await adm("POST", "/local-admin/users", { username: "mtuser", password: "password123", role: "user" })).status, 200);
  const utok = (await api(s.base, "POST", "/auth/login", { username: "mtuser", password: "password123" })).json.token;
  const cl: Client = await connect({ s, token: utok } as any);

  const eta = Date.now() + 3_600_000;
  const on = await M({ enabled: true, message: "Upgrading the GPU cluster", eta });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.maintenance.enabled, true);
  assert.equal(on.json.maintenance.eta, eta);
  assert.deepEqual((await G()).json.maintenance, on.json.maintenance);
  assert.deepEqual((await api(s.base, "GET", "/maintenance")).json.maintenance, on.json.maintenance, "public endpoint reflects it");
  const f = await cl.waitFrame((x) => x.type === "maintenance" && x.maintenance?.enabled === true);
  assert.deepEqual(f.maintenance, on.json.maintenance);

  // clearEta removes the ETA; eta: null does the same
  const noEta = await M({ clearEta: true });
  assert.equal(noEta.status, 200);
  assert.equal(noEta.json.maintenance.eta, null);
  assert.equal(noEta.json.maintenance.message, "Upgrading the GPU cluster", "other fields untouched");
  assert.equal((await M({ eta: Date.now() + 1000 })).json.maintenance.eta !== null, true);
  assert.equal((await M({ eta: null })).json.maintenance.eta, null);

  const off = await M({ enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.maintenance.enabled, false);
  assert.equal((await api(s.base, "GET", "/maintenance")).json.maintenance.enabled, false);
  const f2 = await cl.waitFrame((x) => x.type === "maintenance" && x.maintenance?.enabled === false);
  assert.equal(f2.maintenance.enabled, false);
  cl.ws.close();
});

test("local admin shared providers: token required, admin-owned only, grants, default settings, broadcast, audit", async () => {
  const bossTok = (await api(s.base, "POST", "/auth/login", { username: "boss", password: "password123" })).json.token as string;
  const bobTok = (await api(s.base, "POST", "/auth/login", { username: "bob", password: "another-password" })).json.token as string;
  const allUsers = (await adm("GET", "/local-admin/users")).json.users as any[];
  const bobId = allUsers.find((u) => u.username === "bob").id as string;
  // the previous test promoted bob and demoted boss: restore boss as the admin, bob as an ordinary user
  assert.equal((await adm("PATCH", `/local-admin/users/${allUsers.find((u) => u.username === "boss").id}`, { role: "admin" })).status, 200);
  assert.equal((await adm("PATCH", `/local-admin/users/${bobId}`, { role: "user" })).status, 200);
  const bobCl: Client = await connect({ s, token: bobTok } as any);

  // token and loopback checks on every new route
  assert.equal((await adm("PUT", "/local-admin/providers/x/shared", { shared: true }, "")).status, 401);
  assert.equal((await adm("GET", "/local-admin/shared-providers", undefined, "")).status, 401);
  assert.equal((await adm("GET", `/local-admin/users/${bobId}/grants`, undefined, "")).status, 401);
  assert.equal((await adm("PUT", "/local-admin/shared-settings", { allowOwnProviders: true }, "")).status, 401);
  assert.equal((await api(s.base, "GET", "/local-admin/shared-settings", undefined, "", { "x-local-admin": tok, "x-forwarded-for": "1.2.3.4" })).status, 403, "proxied requests are refused");

  // an admin-owned provider and a provider that belongs to an ordinary user
  const home = await adm("POST", "/local-admin/providers", { name: "Home LLM", baseUrl: "http://localhost:1234/v1", model: "m1", apiKey: "sk-shared-secret", owner: "boss" });
  assert.equal(home.status, 200, home.text);
  const homeId = home.json.id as string;
  const bobsOwn = await adm("POST", "/local-admin/providers", { name: "Bob's", baseUrl: "http://localhost:1235/v1", owner: "bob" });
  const bobsId = bobsOwn.json.id as string;
  const bridge = await adm("POST", "/local-admin/providers", { name: "Bridge", kind: "dsh-bridge", baseUrl: "dsh://bridge", owner: "boss" });
  assert.equal(bridge.status, 200, bridge.text);

  // sharing: strict body, admin-owned only, dsh-bridge refused
  for (const bad of [{}, { shared: "yes" }, { shared: true, extra: 1 }, []]) {
    assert.equal((await adm("PUT", `/local-admin/providers/${homeId}/shared`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await adm("PUT", `/local-admin/providers/${bobsId}/shared`, { shared: true })).status, 404, "an ordinary user's provider cannot be shared");
  assert.equal((await adm("PUT", "/local-admin/providers/nope/shared", { shared: true })).status, 404);
  assert.equal((await adm("PUT", `/local-admin/providers/${bridge.json.id}/shared`, { shared: true })).status, 400);
  const on = await adm("PUT", `/local-admin/providers/${homeId}/shared`, { shared: true });
  assert.deepEqual(on.json, { id: homeId, shared: true });
  const f = await bobCl.waitFrame((x) => x.type === "providers-changed");
  assert.equal(f.type, "providers-changed");
  const listed = (await adm("GET", "/local-admin/shared-providers")).json.providers as any[];
  assert.ok(listed.some((p) => p.id === homeId && p.ownerUserId), JSON.stringify(listed));
  assert.ok(!JSON.stringify(listed).includes("sk-shared-secret"), "the api key is never returned");
  assert.ok(!JSON.stringify(listed).includes("localhost:1234"), "the URL is never returned");

  // grants: default is none, validation, PUT/GET/DELETE
  const g0 = await adm("GET", `/local-admin/users/${bobId}/grants`);
  assert.equal(g0.status, 200);
  assert.equal(g0.json.defaultSharedAccess, "none");
  assert.deepEqual(g0.json.grants, []);
  assert.equal((await adm("GET", "/local-admin/users/ghost/grants")).status, 404);
  const G = (uid: string, pid: string, body: unknown) => adm("PUT", `/local-admin/users/${uid}/grants/${pid}`, body);
  for (const bad of [{ mode: "some" }, { mode: "list" }, { mode: "list", models: [] }, { mode: "list", models: ["a", 5] }, { mode: "all", extra: 1 }]) {
    assert.equal((await G(bobId, homeId, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await G("ghost", homeId, { mode: "all" })).status, 404);
  assert.equal((await G(bobId, bobsId, { mode: "all" })).status, 404, "a provider that is not shared cannot be granted");
  const list = await G(bobId, homeId, { mode: "list", models: ["m1", "m2"] });
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.mode, "list");
  assert.deepEqual([...list.json.models].sort(), ["m1", "m2"]);
  const g1 = (await adm("GET", `/local-admin/users/${bobId}/grants`)).json.grants as any[];
  assert.ok(g1.some((g) => g.providerId === homeId && g.mode === "list"));
  assert.equal((await G(bobId, homeId, { mode: "all" })).json.mode, "all");
  assert.equal((await adm("DELETE", `/local-admin/users/${bobId}/grants/${homeId}`)).json.removed, true);
  assert.equal((await adm("DELETE", `/local-admin/users/${bobId}/grants/${homeId}`)).json.removed, false);

  // shared settings: defaults, strict validation, update, audit
  const s0 = await adm("GET", "/local-admin/shared-settings");
  assert.deepEqual(s0.json, { defaultSharedAccess: "none", allowOwnProviders: true });
  const S = (body: unknown) => adm("PUT", "/local-admin/shared-settings", body);
  for (const bad of [{}, { serverName: "x" }, { defaultSharedAccess: "maybe" }, { allowOwnProviders: "no" }, { defaultSharedAccess: "all", nope: 1 }]) {
    assert.equal((await S(bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual((await adm("GET", "/local-admin/shared-settings")).json, s0.json, "rejected writes change nothing");
  const s1 = await S({ defaultSharedAccess: "all", allowOwnProviders: false });
  assert.equal(s1.status, 200, s1.text);
  assert.deepEqual(s1.json, { defaultSharedAccess: "all", allowOwnProviders: false });
  assert.equal((await api(s.base, "GET", "/admin/settings", undefined, bossTok)).json.general.allowOwnProviders, false, "same store as the admin API");
  await S({ defaultSharedAccess: "none", allowOwnProviders: true });

  // the local model list of a provider (unreachable here, so an error is reported, not a crash)
  assert.equal((await adm("GET", "/local-admin/providers/nope/models")).status, 404);
  const models = await adm("GET", `/local-admin/providers/${homeId}/models`);
  assert.equal(models.status, 200, models.text);
  assert.ok(Array.isArray(models.json.models));

  // revoking sharing: broadcast again, then the admin audit has the new actions
  assert.equal((await adm("PUT", `/local-admin/providers/${homeId}/shared`, { shared: false })).json.shared, false);
  await bobCl.waitFrame((x) => x.type === "providers-changed");
  const audit = (await api(s.base, "GET", "/admin/audit", undefined, bossTok)).json.entries as any[];
  const actions = audit.map((e) => e.action);
  assert.ok(actions.includes("provider.shared"), actions.join(","));
  assert.ok(actions.includes("grant.update"));
  assert.ok(actions.includes("grant.delete"));
  assert.ok(actions.includes("settings.update"));
  assert.ok(audit.some((e) => e.actorId === "local-admin" || e.actor === "local-admin" || JSON.stringify(e).includes("local-admin")), "local actions name the local-admin actor");
  assert.ok(!JSON.stringify(audit).includes("sk-shared-secret"), "audit never holds the key");
  bobCl.ws.close();
});
