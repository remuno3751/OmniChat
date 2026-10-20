import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { startServer, api, type TestServer } from "./test-server.js";

// Shared providers and per-user model grants (docs/PROTOCOL-v7-shared-providers.md).
// The admin API is exercised over HTTP. The modelAllowed / providerUsableBy / listSharedProvidersFor branches are
// called in-process against the same SQLite file the test server writes (this process only reads, plus the grant helpers).
const PW = "password123";
const BASE_URL = "https://shared-test.example.com/v1";
const SECRET = "SECRET-KEY-SHARED-789";

let s: TestServer;
let localTok = "";
let sp: typeof import("./shared-providers.js");
let dbm: typeof import("./db.js");
let tokA = "", tokB = "", tokC = "", tokAlice = "", tokCarol = "", tokBob = "", tokDave = "";

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const login = async (u: string) => (await api(s.base, "POST", "/auth/login", { username: u, password: PW })).json.token as string;
const uid = (u: string) => (dbm.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: string }).id;
const prow = (id: string) => dbm.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as any;
const settings = () => api(s.base, "GET", "/admin/settings", undefined, tokC);

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  for (const [u, role] of [["adminA", "admin"], ["adminB", "admin"], ["adminC", "admin"], ["alice", "user"], ["carol", "user"], ["bob", "user"], ["dave", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username: u, password: PW, role })).status, 200, u);
  }
  [tokA, tokB, tokC, tokAlice, tokCarol, tokBob, tokDave] = await Promise.all(
    ["adminA", "adminB", "adminC", "alice", "carol", "bob", "dave"].map(login),
  );
  // in-process reads on the test server's database (same file)
  process.env.DATA_DIR = s.tmp;
  process.env.DB_PATH = join(s.tmp, "t.db");
  dbm = await import("./db.js");
  sp = await import("./shared-providers.js");
  // providers: adminA's future shared one, adminA's private one, adminA's dsh-bridge, carol's private one, adminA's dead one
  const mk = (tok: string, id: string, kind = "openai-compatible", baseUrl = BASE_URL) =>
    api(s.base, "PUT", `/providers/${id}`, { name: id, kind, baseUrl, model: "m-default", apiKey: SECRET }, tok);
  assert.equal((await mk(tokA, "p-shared")).status, 200);
  assert.equal((await mk(tokA, "p-private")).status, 200);
  assert.equal((await mk(tokA, "p-bridge", "dsh-bridge", "pc-bridge")).status, 200);
  assert.equal((await mk(tokCarol, "p-carol")).status, 200);
  assert.equal((await mk(tokA, "p-dead")).status, 200);
});
after(() => s?.stop());

const share = (tok: string, id: string, shared: unknown) => api(s.base, "PUT", `/admin/providers/${id}/shared`, { shared }, tok);

test("a. only the admin owner can share; dsh-bridge is 400; bad body 400; other/unknown/deleted 404", async () => {
  assert.equal((await share(tokAlice, "p-shared", true)).status, 403, "normal user");
  assert.equal((await share(tokB, "p-shared", true)).status, 404, "another admin's provider");
  assert.equal((await share(tokA, "p-carol", true)).status, 404, "another user's provider");
  assert.equal((await share(tokA, "nope", true)).status, 404, "unknown");
  assert.equal((await share(tokA, "p-bridge", true)).status, 400, "dsh-bridge");
  assert.equal((await share(tokA, "p-shared", "yes")).status, 400, "non-boolean");
  assert.equal((await api(s.base, "PUT", "/admin/providers/p-shared/shared", { shared: true, x: 1 }, tokA)).status, 400, "unknown field");
  assert.equal((await api(s.base, "DELETE", "/providers/p-dead", undefined, tokA)).status, 200);
  assert.equal((await share(tokA, "p-dead", true)).status, 404, "deleted");
  const ok = await share(tokA, "p-shared", true);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { id: "p-shared", shared: true });
  assert.equal(prow("p-shared").shared, 1);
  assert.equal(prow("p-private").shared, 0, "private provider unchanged");
});

test("b. modelAllowed and providerUsableBy branches", async () => {
  const shared = prow("p-shared");
  const priv = prow("p-private");
  const carolP = prow("p-carol");
  const alice = uid("alice"), carol = uid("carol"), dave = uid("dave"), bob = uid("bob"), adminA = uid("adminA"), adminB = uid("adminB");
  assert.equal((await api(s.base, "PUT", `/admin/users/${alice}/grants/p-shared`, { mode: "list", models: ["m1", "m2"] }, tokB)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/users/${carol}/grants/p-shared`, { mode: "all" }, tokB)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/users/${bob}/grants/p-shared`, { mode: "none" }, tokB)).status, 200);
  assert.equal(sp.modelAllowed(adminB, shared, "anything"), true, "admin always");
  assert.equal(sp.modelAllowed(adminA, priv, "anything"), true, "owner, private");
  assert.equal(sp.modelAllowed(alice, shared, "m1"), true, "list hit");
  assert.equal(sp.modelAllowed(alice, shared, "m3"), false, "list miss");
  assert.equal(sp.modelAllowed(carol, shared, "whatever"), true, "row all");
  assert.equal(sp.modelAllowed(bob, shared, "m1"), false, "row none");
  assert.equal(sp.providerUsableBy(bob, shared), false, "row none: not usable");
  assert.equal(sp.providerUsableBy(alice, shared), true, "list: usable");
  assert.equal(sp.modelAllowed(dave, shared, "m1"), false, "no row, default none");
  assert.equal(sp.providerUsableBy(dave, shared), false, "no row, default none: not usable");
  assert.equal((await settings()).json.general.defaultSharedAccess, "none");
  assert.equal((await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "all" }, tokC)).status, 200);
  assert.equal(sp.modelAllowed(dave, shared, "m1"), true, "no row, default all");
  assert.equal(sp.modelAllowed(bob, shared, "m1"), false, "row none beats default all");
  assert.equal((await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "none" }, tokC)).status, 200);
  assert.equal(sp.modelAllowed(alice, priv, "m1"), false, "another user's private provider");
  assert.equal(sp.modelAllowed(alice, carolP, "m1"), false, "carol's private provider");
  assert.equal(sp.modelAllowed(alice, { ...shared, deleted: 1 }, "m1"), false, "deleted shared provider");
  assert.equal(sp.modelAllowed(alice, { ...shared, shared: 0 }, "m1"), false, "unshared provider");
});

test("c. grants PUT/GET/DELETE and validation", async () => {
  const alice = uid("alice");
  const put = (u: string, p: string, body: unknown, tok = tokB) => api(s.base, "PUT", `/admin/users/${u}/grants/${p}`, body, tok);
  const r = await put(alice, "p-shared", { mode: "list", models: ["m1", "m1", "m2"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, ["m1", "m2"], "deduplicated");
  assert.equal((await put(alice, "p-shared", { mode: "bogus" })).status, 400);
  assert.equal((await put(alice, "p-shared", { mode: "list" })).status, 400, "list without models");
  assert.equal((await put(alice, "p-shared", { mode: "list", models: [] })).status, 400, "list with no models");
  assert.equal((await put(alice, "p-shared", { mode: "list", models: "m1" })).status, 400, "models not an array");
  assert.equal((await put(alice, "p-shared", { mode: "list", models: [""] })).status, 400, "empty model id");
  assert.equal((await put(alice, "p-shared", { mode: "list", models: ["x".repeat(301)] })).status, 400, "model too long");
  const many = Array.from({ length: 501 }, (_, i) => `m${i}`);
  assert.equal((await put(alice, "p-shared", { mode: "list", models: many })).status, 400, "more than 500");
  assert.equal((await put(alice, "p-shared", { mode: "all", extra: 1 })).status, 400, "unknown field");
  assert.equal((await put("nobody-id", "p-shared", { mode: "all" })).status, 404, "unknown user");
  assert.equal((await put(alice, "p-private", { mode: "all" })).status, 404, "not shared");
  assert.equal((await put(alice, "nope", { mode: "all" })).status, 404, "unknown provider");
  assert.equal((await put(alice, "p-shared", { mode: "all" }, tokAlice)).status, 403, "normal user");
  const g = await api(s.base, "GET", `/admin/users/${alice}/grants`, undefined, tokB);
  assert.equal(g.status, 200);
  assert.equal(g.json.defaultSharedAccess, "none");
  assert.deepEqual(g.json.grants, [{ providerId: "p-shared", mode: "list", models: ["m1", "m2"] }]);
  assert.equal((await api(s.base, "GET", `/admin/users/${alice}/grants`, undefined, tokAlice)).status, 403);
  assert.equal((await api(s.base, "GET", "/admin/users/nobody-id/grants", undefined, tokB)).status, 404);
  assert.deepEqual((await api(s.base, "DELETE", `/admin/users/${alice}/grants/p-shared`, undefined, tokB)).json, { ok: true, removed: true });
  assert.deepEqual((await api(s.base, "DELETE", `/admin/users/${alice}/grants/p-shared`, undefined, tokB)).json, { ok: true, removed: false });
  assert.equal((await api(s.base, "DELETE", `/admin/users/${alice}/grants/p-shared`, undefined, tokAlice)).status, 403);
});

test("d. listSharedProvidersFor never includes URL, key, or a default model that is not allowed", async () => {
  const alice = uid("alice"), carol = uid("carol"), bob = uid("bob"), adminB = uid("adminB");
  assert.equal((await api(s.base, "PUT", `/admin/users/${alice}/grants/p-shared`, { mode: "list", models: ["m1"] }, tokB)).status, 200);
  const list = sp.listSharedProvidersFor(alice);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: "p-shared", name: "p-shared", kind: "openai-compatible", shared: true, readOnly: true, allowedModels: ["m1"], model: "" });
  assert.equal(sp.listSharedProvidersFor(carol)[0].allowedModels, "all");
  const text = JSON.stringify(sp.listSharedProvidersFor(carol)) + JSON.stringify(list);
  assert.equal(sp.listSharedProvidersFor(carol)[0].model, "m-default", "all: the default model is shown");
  assert.ok(!text.includes(BASE_URL) && !text.includes(SECRET), "no url or key");
  assert.equal(list[0].model, "", "list: the default model is hidden when not allowed");
  assert.ok(!/baseUrl|apiKey|base_url|api_key/.test(text));
  assert.equal(sp.listSharedProvidersFor(bob).length, 0, "row none");
  assert.equal(sp.listSharedProvidersFor(adminB).length, 0, "admin gets no list");
});

test("e. defaultSharedAccess / allowOwnProviders: update and invalid values", async () => {
  const bad = (b: unknown) => api(s.base, "PUT", "/admin/settings", b, tokC);
  assert.equal((await bad({ defaultSharedAccess: "some" })).status, 400);
  assert.equal((await bad({ allowOwnProviders: "no" })).status, 400);
  assert.equal((await bad({ defaultSharedAccess: "all", allowOwnProviders: 1 })).status, 400);
  assert.equal((await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "all" }, tokAlice)).status, 403);
  const ok = await bad({ defaultSharedAccess: "all", allowOwnProviders: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.general.defaultSharedAccess, "all");
  assert.equal(ok.json.general.allowOwnProviders, true);
  await bad({ defaultSharedAccess: "none" });
  const g = (await settings()).json.general;
  assert.equal(g.defaultSharedAccess, "none");
  assert.equal(g.allowOwnProviders, true, "allowOwnProviders defaults to true");
});

test("f. allowOwnProviders=false: ordinary users cannot add, can edit and delete; admins can add", async () => {
  const own = { name: "a", kind: "openai-compatible", baseUrl: BASE_URL, model: "m" };
  assert.equal((await api(s.base, "PUT", "/providers/alice-own", own, tokAlice)).status, 200);
  assert.equal((await api(s.base, "PUT", "/admin/settings", { allowOwnProviders: false }, tokC)).status, 200);
  const added = await api(s.base, "PUT", "/providers/alice-new", own, tokAlice);
  assert.equal(added.status, 403);
  assert.equal(added.json.error, "Adding your own providers is disabled on this server");
  assert.equal((await api(s.base, "PUT", "/providers/alice-own", { ...own, name: "renamed" }, tokAlice)).status, 200, "edit allowed");
  assert.equal((await api(s.base, "PUT", "/providers/adm-new", own, tokA)).status, 200, "admin can add");
  assert.equal((await api(s.base, "DELETE", "/providers/alice-own", undefined, tokAlice)).status, 200, "delete allowed");
  await api(s.base, "PUT", "/admin/settings", { allowOwnProviders: true }, tokC);
  assert.equal((await api(s.base, "PUT", "/providers/alice-new", own, tokAlice)).status, 200, "allowed again");
});

test("g. provider deletion and user deletion remove grants; disabling keeps them", async () => {
  const alice = uid("alice"), carol = uid("carol"), bob = uid("bob"), dave = uid("dave");
  assert.equal((await api(s.base, "PUT", `/admin/users/${carol}/grants/p-shared`, { mode: "all" }, tokB)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/users/${bob}/grants/p-shared`, { mode: "all" }, tokB)).status, 200);
  assert.equal((await api(s.base, "PATCH", `/admin/users/${bob}`, { disabled: true }, tokC)).status, 200);
  assert.ok(sp.getGrant(bob, "p-shared"), "disabling keeps grants");
  await api(s.base, "PATCH", `/admin/users/${bob}`, { disabled: false }, tokC);
  assert.equal((await api(s.base, "DELETE", `/admin/users/${carol}`, { confirm: "carol", hard: true }, tokC)).status, 200);
  assert.equal(sp.getGrant(carol, "p-shared"), null, "user deletion removes grants");
  assert.equal((await api(s.base, "PUT", `/admin/users/${dave}/grants/p-shared`, { mode: "all" }, tokB)).status, 200);
  assert.equal((await api(s.base, "DELETE", "/providers/p-shared", undefined, tokA)).status, 200);
  assert.equal(sp.getGrant(dave, "p-shared"), null, "provider deletion removes grants");
  assert.equal(sp.getGrant(alice, "p-shared"), null);
});

test("h. audit rows exist for the changes and never contain the key", async () => {
  const entries = (await api(s.base, "GET", "/admin/audit?limit=200", undefined, tokC)).json.entries as any[];
  const actions = new Set(entries.map((e) => e.action));
  for (const a of ["provider.shared", "grant.update", "grant.delete", "settings.update"]) assert.ok(actions.has(a), a);
  assert.ok(!JSON.stringify(entries).includes(SECRET));
});
