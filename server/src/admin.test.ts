import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startServer, api, sleep, type TestServer } from "./test-server.js";

// Protocol v7 admin routes (docs/PROTOCOL-v7-admin.md). Tests are written against the contract.
// Shared server (`s`) for most tests; a separate server for the single-admin scenario (test 5),
// the persistence test (11) and the supervised restart test (12).
const PW = "password123";
const LEAK_PW = "PW-LEAK-CHECK-5555";
const SECRET_BRAVE = "SECRET-KEY-123";
const SECRET_GH = "ghp_SECRETTOKEN1234567890";

let s: TestServer;
let localTok = "";
let matrixTok = "", settingsTok = "", usersTok = "", deleteTok = "", bobTok = "";

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const login = (username: string, password = PW) => api(s.base, "POST", "/auth/login", { username, password });
const tokenOf = async (username: string) => (await login(username)).json.token as string;
const readLocalToken = (tmp: string) => readFileSync(join(tmp, "local-admin.token"), "utf8").trim();

function waitExit(child: ChildProcess, ms: number): Promise<number | null | "timeout"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise<number | null>((res) => child.once("exit", (c) => res(c))),
    sleep(ms).then(() => "timeout" as const),
  ]);
}

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readLocalToken(s.tmp);
  const mk = (username: string, role: "admin" | "user") =>
    local("POST", "/local-admin/users", { username, password: PW, role });
  assert.equal((await mk("matrixadmin", "admin")).status, 200);
  for (const u of ["settingsadmin", "usersadmin", "deleteadmin"]) assert.equal((await mk(u, "admin")).status, 200);
  assert.equal((await mk("bob", "user")).status, 200);
  matrixTok = await tokenOf("matrixadmin");
  settingsTok = await tokenOf("settingsadmin");
  usersTok = await tokenOf("usersadmin");
  deleteTok = await tokenOf("deleteadmin");
  bobTok = await tokenOf("bob");
  assert.ok(matrixTok && settingsTok && usersTok && deleteTok && bobTok, "logins failed");
});
after(() => s?.stop());

test("1. access matrix: 401 without token, 403 for a normal user, not 401/403 for an admin", async () => {
  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/admin/overview"],
    ["GET", "/admin/settings"],
    ["PUT", "/admin/settings", {}],
    ["GET", "/admin/users"],
    ["POST", "/admin/users", {}],
    ["PATCH", "/admin/users/nope", {}],
    ["POST", "/admin/users/nope/password", {}],
    ["POST", "/admin/users/nope/revoke", {}],
    ["DELETE", "/admin/users/nope", {}],
    ["GET", "/admin/network"],
    ["POST", "/admin/restart", {}],
    ["GET", "/admin/logs"],
    ["GET", "/admin/audit"],
  ];
  // admin probes use bodies that are invalid on purpose: they cannot change state (restart needs confirm:true)
  for (const [m, p, b] of routes) {
    assert.equal((await api(s.base, m, p, b)).status, 401, `${m} ${p} without token`);
    assert.equal((await api(s.base, m, p, b, "x".repeat(64))).status, 401, `${m} ${p} bad token`);
    assert.equal((await api(s.base, m, p, b, bobTok)).status, 403, `${m} ${p} normal user`);
    const adm = await api(s.base, m, p, b, matrixTok);
    assert.ok(![401, 403].includes(adm.status), `${m} ${p} admin got ${adm.status}`);
  }
  // reused routes: admin-only for writes too
  for (const [m, p, b] of [
    ["PUT", "/search/config", {}],
    ["PUT", "/update/config", {}],
    ["POST", "/admin/backup", undefined],
    ["GET", "/admin/diagnostics", undefined],
  ] as Array<[string, string, unknown]>) {
    assert.equal((await api(s.base, m, p, b)).status, 401, `${m} ${p} without token`);
    assert.equal((await api(s.base, m, p, b, bobTok)).status, 403, `${m} ${p} normal user`);
  }
});

test("2. /version capability and PUT /admin/settings name/description, with validation", async () => {
  const v = await api(s.base, "GET", "/version");
  assert.equal(v.json.adminSettings, true);
  assert.equal(typeof v.json.serverName, "string");
  assert.equal(typeof v.json.serverDescription, "string");

  const ok = await api(s.base, "PUT", "/admin/settings", { serverName: "Test Server X", serverDescription: "desc here" }, settingsTok);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.general.serverName, "Test Server X");
  const v2 = (await api(s.base, "GET", "/version")).json;
  assert.equal(v2.serverName, "Test Server X");
  assert.equal(v2.serverDescription, "desc here");

  assert.equal((await api(s.base, "PUT", "/admin/settings", { serverName: "x".repeat(61) }, settingsTok)).status, 400, "name > 60");
  assert.equal((await api(s.base, "PUT", "/admin/settings", { bogusKey: 1 }, settingsTok)).status, 400, "unknown key");
  assert.equal((await api(s.base, "PUT", "/admin/settings", {}, settingsTok)).status, 400, "empty body");
  assert.equal((await api(s.base, "PUT", "/admin/settings", undefined, settingsTok)).status, 400, "no body");
  assert.equal((await api(s.base, "PUT", "/admin/settings", { serverName: 5 }, settingsTok)).status, 400, "wrong type");
  assert.equal((await api(s.base, "GET", "/admin/settings", undefined, settingsTok)).json.general.serverName, "Test Server X", "rejected writes change nothing");
});

test("3. registration toggle: env default off, DB value wins, source reported", async () => {
  const before0 = await api(s.base, "GET", "/admin/settings", undefined, settingsTok);
  assert.equal(before0.json.general.allowRegistration, false);
  assert.equal(before0.json.general.allowRegistrationSource, "env");
  assert.equal((await api(s.base, "POST", "/auth/register", { username: "newbie", password: PW })).status, 403);

  assert.equal((await api(s.base, "PUT", "/admin/settings", { allowRegistration: true }, settingsTok)).status, 200);
  const g = await api(s.base, "GET", "/admin/settings", undefined, settingsTok);
  assert.equal(g.json.general.allowRegistration, true);
  assert.equal(g.json.general.allowRegistrationSource, "db");
  assert.equal((await api(s.base, "POST", "/auth/register", { username: "newbie", password: PW })).status, 200);

  assert.equal((await api(s.base, "PUT", "/admin/settings", { allowRegistration: false }, settingsTok)).status, 200);
  assert.equal((await api(s.base, "POST", "/auth/register", { username: "newbie2", password: PW })).status, 403);
});

test("4. users: create validation, list fields, disable/enable, promote/demote, password reset, revoke", async () => {
  const c = await api(s.base, "POST", "/admin/users", { username: "carla", password: PW, role: "user" }, usersTok);
  assert.equal(c.status, 201, c.text);
  assert.deepEqual(Object.keys(c.json).sort(), ["id", "role", "username"].sort());
  assert.equal(c.json.role, "user");
  const carla = c.json.id as string;
  assert.equal((await api(s.base, "POST", "/admin/users", { username: "shortpw", password: "short" }, usersTok)).status, 400);
  assert.equal((await api(s.base, "POST", "/admin/users", { username: "ab", password: PW }, usersTok)).status, 400);
  assert.equal((await api(s.base, "POST", "/admin/users", { username: "CARLA", password: PW }, usersTok)).status, 409);

  const list = await api(s.base, "GET", "/admin/users", undefined, usersTok);
  assert.equal(list.status, 200);
  const row = list.json.users.find((u: any) => u.id === carla);
  assert.ok(row, "carla listed");
  assert.equal(row.role, "user");
  assert.equal(row.disabled, false);
  assert.equal(typeof row.createdAt, "number");
  assert.ok(row.lastSeenAt === null || typeof row.lastSeenAt === "number");
  assert.equal(typeof row.devices, "number");
  assert.equal(typeof row.tokens30d, "number");
  assert.ok(row.tokens30d >= 0);
  const you = list.json.users.find((u: any) => u.username === "usersadmin");
  assert.equal(list.json.you, you.id, "`you` is the caller id");

  const t1 = (await login("carla")).json.token as string;
  assert.ok(t1);
  assert.equal((await api(s.base, "PATCH", `/admin/users/${carla}`, { disabled: true }, usersTok)).status, 200);
  assert.equal((await login("carla")).status, 401, "disabled login refused");
  assert.equal((await api(s.base, "GET", "/devices", undefined, t1)).status, 401, "old token dead after disable");
  assert.equal((await api(s.base, "PATCH", `/admin/users/${carla}`, { disabled: false }, usersTok)).status, 200);
  const t2 = (await login("carla")).json.token as string;
  assert.ok(t2, "enable restores login");

  assert.equal((await api(s.base, "PATCH", `/admin/users/${carla}`, { role: "admin" }, usersTok)).status, 200);
  const promoted = (await api(s.base, "GET", "/admin/users", undefined, usersTok)).json.users.find((u: any) => u.id === carla);
  assert.equal(promoted.role, "admin");
  assert.equal((await api(s.base, "PATCH", `/admin/users/${carla}`, { role: "user" }, usersTok)).status, 200);

  const pr = await api(s.base, "POST", `/admin/users/${carla}/password`, { password: "brandnew-pass" }, usersTok);
  assert.equal(pr.status, 200, pr.text);
  assert.equal(typeof pr.json.revokedDevices, "number");
  assert.ok(pr.json.revokedDevices >= 1);
  assert.equal((await api(s.base, "GET", "/devices", undefined, t2)).status, 401, "old token revoked by password reset");
  assert.equal((await login("carla")).status, 401, "old password refused");
  const t3 = (await login("carla", "brandnew-pass")).json.token as string;
  assert.ok(t3, "new password logs in");

  const rv = await api(s.base, "POST", `/admin/users/${carla}/revoke`, {}, usersTok);
  assert.equal(rv.status, 200, rv.text);
  assert.equal(rv.json.ok, true);
  assert.equal(typeof rv.json.revokedDevices, "number");
  assert.equal(typeof rv.json.revokedKeys, "number");
  assert.equal((await api(s.base, "GET", "/devices", undefined, t3)).status, 401, "revoke kills the token");
});

test("5. last-admin and self protection (dedicated server with a single admin)", async () => {
  const b = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" });
  try {
    const lt = readLocalToken(b.tmp);
    const ladd = (u: string, role: string) => api(b.base, "POST", "/local-admin/users", { username: u, password: PW, role }, "", { "x-local-admin": lt });
    assert.equal((await ladd("solo", "admin")).status, 200);
    const tokenOf_ = async (u: string) => (await api(b.base, "POST", "/auth/login", { username: u, password: PW })).json.token as string;
    const soloTok = await tokenOf_("solo");
    assert.ok(soloTok, "solo login");
    const me = (await api(b.base, "GET", "/admin/users", undefined, soloTok)).json;
    const soloId = me.you as string;
    assert.equal((await api(b.base, "PATCH", `/admin/users/${soloId}`, { role: "user" }, soloTok)).status, 409, "last admin cannot demote self");
    assert.equal((await api(b.base, "PATCH", `/admin/users/${soloId}`, { disabled: true }, soloTok)).status, 409, "cannot disable self");
    assert.equal((await api(b.base, "DELETE", `/admin/users/${soloId}`, { confirm: "solo" }, soloTok)).status, 409, "cannot delete self");

    assert.equal((await api(b.base, "POST", "/admin/users", { username: "second", password: PW, role: "admin" }, soloTok)).status, 201);
    const secondTok = await tokenOf_("second");
    const secondId = (await api(b.base, "GET", "/admin/users", undefined, soloTok)).json.users.find((u: any) => u.username === "second").id;
    assert.equal((await api(b.base, "PATCH", `/admin/users/${secondId}`, { role: "user" }, soloTok)).status, 200, "two admins: demoting one works");
    assert.equal((await api(b.base, "GET", "/admin/users", undefined, secondTok)).status, 403, "demoted admin lost access");
    assert.equal((await api(b.base, "PATCH", `/admin/users/${soloId}`, { role: "user" }, soloTok)).status, 409, "remaining admin is protected");

    const users = await api(b.base, "GET", "/admin/users", undefined, soloTok);
    const overview = await api(b.base, "GET", "/admin/overview", undefined, soloTok);
    const settings = await api(b.base, "GET", "/admin/settings", undefined, soloTok);
    for (const r of [users, overview, settings]) {
      assert.ok(!r.text.includes(PW), "password value not in response");
      const bad = keysOf(r.json).filter((k) => /hash|salt|password|secret/i.test(k));
      assert.deepEqual(bad, [], "no hash/password/secret keys");
    }
  } finally {
    b.stop();
  }
});

test("6. delete: wrong confirm, soft delete, hard delete removes user and data", async () => {
  const mk = async (u: string) => {
    const r = await api(s.base, "POST", "/admin/users", { username: u, password: PW, role: "user" }, deleteTok);
    assert.equal(r.status, 201, r.text);
    return r.json.id as string;
  };
  const victim = await mk("victim");
  const victimTok = await tokenOf("victim");
  const convId = randomUUID();
  const convCreated = (await api(s.base, "PUT", `/conversations/${convId}`, { title: "victim chat" }, victimTok)).status === 200;

  assert.equal((await api(s.base, "DELETE", `/admin/users/${victim}`, { confirm: "wrong" }, deleteTok)).status, 400, "wrong confirm");
  assert.equal((await api(s.base, "DELETE", `/admin/users/${victim}`, {}, deleteTok)).status, 400, "missing confirm");

  const soft = await api(s.base, "DELETE", `/admin/users/${victim}`, { confirm: "victim" }, deleteTok);
  assert.equal(soft.status, 200, soft.text);
  assert.deepEqual(soft.json, { ok: true, mode: "disabled" });
  const row = (await api(s.base, "GET", "/admin/users", undefined, deleteTok)).json.users.find((u: any) => u.id === victim);
  assert.ok(row, "soft-deleted user still listed");
  assert.equal(row.disabled, true);
  assert.equal((await login("victim")).status, 401);

  const hardUser = await mk("victim2");
  const hardTok = await tokenOf("victim2");
  const hconv = randomUUID();
  const hconvCreated = (await api(s.base, "PUT", `/conversations/${hconv}`, { title: "victim2 chat" }, hardTok)).status === 200;
  const db = new DatabaseSync(join(s.tmp, "t.db"), { readOnly: true });
  const countConvs = (uid: string) => (db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?").get(uid) as { n: number }).n;
  try {
    const hard = await api(s.base, "DELETE", `/admin/users/${hardUser}`, { confirm: "victim2", hard: true }, deleteTok);
    assert.equal(hard.status, 200, hard.text);
    assert.deepEqual(hard.json, { ok: true, mode: "deleted" });
    const list = (await api(s.base, "GET", "/admin/users", undefined, deleteTok)).json.users;
    assert.equal(list.find((u: any) => u.id === hardUser), undefined, "hard-deleted user removed from list");
    assert.notEqual((await login("victim2")).status, 200, "login fails after hard delete");
    if (hconvCreated) assert.equal(countConvs(hardUser), 0, "hard delete removed conversations");
    else console.log("note: could not create a conversation for victim2; conversation sub-assert skipped");
  } finally {
    db.close();
  }
  if (!convCreated) console.log("note: could not create a conversation for victim; not asserted");
});

test("7. secret masking: keys never appear in audit, overview, settings, network or logs", async () => {
  const sr = await api(s.base, "PUT", "/search/config", { braveApiKey: SECRET_BRAVE }, deleteTok);
  assert.equal(sr.status, 200, sr.text);
  const ur = await api(s.base, "PUT", "/update/config", { githubToken: SECRET_GH }, deleteTok);
  assert.equal(ur.status, 200, ur.text);
  const leak = await api(s.base, "POST", "/admin/users", { username: "pwleak", password: LEAK_PW, role: "user" }, usersTok);
  assert.equal(leak.status, 201, leak.text);

  const audit = await api(s.base, "GET", "/admin/audit?limit=200", undefined, matrixTok);
  assert.equal(audit.status, 200);
  assert.ok(!audit.text.includes(SECRET_BRAVE), "brave key in audit");
  assert.ok(!audit.text.includes("ghp_SECRETTOKEN"), "github token in audit");
  assert.ok(!audit.text.includes(LEAK_PW), "password in audit");
  assert.ok(audit.json.entries.some((e: any) => e.action === "search.config"), "search.config row");
  assert.ok(audit.json.entries.some((e: any) => e.action === "update.config"), "update.config row");

  for (const p of ["/admin/overview", "/admin/settings", "/admin/network", "/admin/logs"]) {
    const r = await api(s.base, "GET", p, undefined, matrixTok);
    assert.equal(r.status, 200, p);
    for (const sec of [SECRET_BRAVE, "ghp_SECRETTOKEN", LEAK_PW]) assert.ok(!r.text.includes(sec), `${sec} in ${p}`);
  }
});

test("8. audit: newest first, actor/action/key/old/new, limit validation", async () => {
  const a = await api(s.base, "GET", "/admin/audit", undefined, settingsTok);
  assert.equal(a.status, 200);
  const e = a.json.entries as any[];
  assert.ok(e.length >= 2 && e.length <= 50, "default limit 50");
  for (let i = 1; i < e.length; i++) assert.ok(e[i - 1].id > e[i].id, "newest first");
  const sn = e.find((x) => x.action === "settings.update" && x.key === "serverName");
  assert.ok(sn, "settings.update row for serverName");
  assert.equal(sn.actor, "settingsadmin");
  assert.equal(typeof sn.actorId, "string");
  assert.equal(sn.newValue, "Test Server X");
  const uc = e.find((x) => x.action === "user.create" && x.key === "carla");
  assert.ok(uc, "user.create row");
  assert.equal(uc.actor, "usersadmin");
  assert.ok("oldValue" in uc && "newValue" in uc);

  assert.equal((await api(s.base, "GET", "/admin/audit?limit=0", undefined, settingsTok)).status, 400);
  assert.equal((await api(s.base, "GET", "/admin/audit?limit=201", undefined, settingsTok)).status, 400);
  assert.equal((await api(s.base, "GET", "/admin/audit?limit=2", undefined, settingsTok)).json.entries.length, 2);
});

test("9. network: loopback exposure, read-only, no secrets", async () => {
  const r = await api(s.base, "GET", "/admin/network", undefined, matrixTok);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.host, "127.0.0.1");
  assert.equal(r.json.exposure, "loopback");
  assert.equal(r.json.editable, false);
  assert.ok(Array.isArray(r.json.corsOrigins));
  assert.equal(typeof r.json.tlsHint, "string");
  assert.deepEqual(keysOf(r.json).filter((k) => /key$|token|secret|hash|password/i.test(k)), []);
  const w = await api(s.base, "PUT", "/admin/network", { host: "0.0.0.0" }, matrixTok);
  assert.ok(![200, 201, 202, 204].includes(w.status), `host/port must not be writable here (got ${w.status})`);
});

test("10. logs: level and lines validation, lines cap", async () => {
  assert.equal((await api(s.base, "GET", "/admin/logs?level=bad", undefined, matrixTok)).status, 400);
  assert.equal((await api(s.base, "GET", "/admin/logs?lines=0", undefined, matrixTok)).status, 400);
  assert.equal((await api(s.base, "GET", "/admin/logs?lines=201", undefined, matrixTok)).status, 400);
  const r = await api(s.base, "GET", "/admin/logs?lines=5&level=info", undefined, matrixTok);
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json.lines));
  assert.ok(r.json.lines.length <= 5);
  assert.ok(r.json.lines.every((l: unknown) => typeof l === "string"));
});

test("11. persistence: settings and audit survive a restart on the same data dir", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "omni-persist-"));
  let s2: TestServer | undefined;
  const s1 = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" }, tmp);
  try {
    const lt = readLocalToken(tmp);
    assert.equal((await api(s1.base, "POST", "/local-admin/users", { username: "persistadmin", password: PW, role: "admin" }, "", { "x-local-admin": lt })).status, 200);
    const t1 = (await api(s1.base, "POST", "/auth/login", { username: "persistadmin", password: PW })).json.token as string;
    assert.equal((await api(s1.base, "PUT", "/admin/settings", { serverName: "Persisted Server", serverDescription: "survives restart" }, t1)).status, 200);
    s1.child.kill();
    assert.notEqual(await waitExit(s1.child, 10000), "timeout", "first server exited");

    s2 = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" }, tmp);
    const t2 = (await api(s2.base, "POST", "/auth/login", { username: "persistadmin", password: PW }, "", {})).json.token as string;
    assert.ok(t2, "login after restart");
    const g = await api(s2.base, "GET", "/admin/settings", undefined, t2);
    assert.equal(g.json.general.serverName, "Persisted Server");
    assert.equal(g.json.general.serverDescription, "survives restart");
    const a = await api(s2.base, "GET", "/admin/audit", undefined, t2);
    assert.ok(a.json.entries.some((x: any) => x.action === "settings.update" && x.key === "serverName"), "audit rows persisted");
  } finally {
    s1.child.kill();
    s2?.child.kill();
    await sleep(300);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("12. supervised restart: 400 without confirm, 202 with confirm, exit code 75, audit row", async () => {
  const sup = await startServer({ OMNICHAT_SUPERVISED: "1", OMNICHAT_OPEN_FIRST_REGISTRATION: "0" });
  try {
    const lt = readLocalToken(sup.tmp);
    assert.equal((await api(sup.base, "POST", "/local-admin/users", { username: "restarter", password: PW, role: "admin" }, "", { "x-local-admin": lt })).status, 200);
    const t = (await api(sup.base, "POST", "/auth/login", { username: "restarter", password: PW })).json.token as string;
    assert.equal((await api(sup.base, "POST", "/admin/restart", {}, t)).status, 400, "no confirm");
    assert.equal((await api(sup.base, "POST", "/admin/restart", { confirm: false }, t)).status, 400, "confirm false");

    const exited = waitExit(sup.child, 5000);
    const r = await api(sup.base, "POST", "/admin/restart", { confirm: true }, t);
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json, { ok: true, mode: "supervised" });
    assert.equal(await exited, 75, "exit code 75 within ~5 s");

    const db = new DatabaseSync(join(sup.tmp, "t.db"), { readOnly: true });
    try {
      const n = (db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'server.restart'").get() as { n: number }).n;
      assert.ok(n >= 1, "server.restart audit row");
    } finally {
      db.close();
    }
  } finally {
    sup.child.kill();
    await sleep(300);
    try { rmSync(sup.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
