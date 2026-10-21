import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, api, type TestServer } from "./test-server.js";

let s: TestServer;
let tok = "";
const adm = (method: string, path: string, body?: unknown, token = tok) => api(s.base, method, path, body, "", { "x-local-admin": token });

before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" });
  tok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
});
after(() => s?.stop());

test("local-admin mirrors: token + loopback required, no admin yet = 409", async () => {
  for (const p of ["/local-admin/attachments", "/local-admin/plugins", "/local-admin/quotas", "/local-admin/quotas/users"]) {
    assert.equal((await adm("GET", p, undefined, "")).status, 401, p);
    assert.equal((await api(s.base, "GET", p, undefined, "", { "x-local-admin": tok, "x-forwarded-for": "1.2.3.4" })).status, 403, p);
  }
  assert.equal((await adm("GET", "/local-admin/quotas")).status, 409);
});

test("local-admin mirrors reach attachments, quotas and plugins as the first administrator", async () => {
  assert.equal((await adm("POST", "/local-admin/users", { username: "boss", password: "password123", role: "admin" })).status, 200);
  const q = await adm("GET", "/local-admin/quotas");
  assert.equal(q.status, 200, q.text);
  const put = await adm("PUT", "/local-admin/quotas", { enabled: true, dailyTokens: 1000 });
  assert.equal(put.status, 200, put.text);
  assert.equal((await adm("GET", "/local-admin/quotas")).json.dailyTokens ?? (await adm("GET", "/local-admin/quotas")).json.quotas?.dailyTokens, 1000);
  assert.equal((await adm("PUT", "/local-admin/quotas", { dailyTokens: -5 })).status, 400, "validation of the real route applies");
  const users = await adm("GET", "/local-admin/quotas/users");
  assert.equal(users.status, 200, users.text);
  const uu = await adm("GET", "/local-admin/usage/users?days=7&tz=540");
  assert.equal(uu.status, 200, uu.text);
  assert.ok(Array.isArray(uu.json.users) && uu.json.totals);
  const dd = await adm("GET", "/local-admin/usage/daily?scope=all&days=7&tz=540");
  assert.equal(dd.status, 200, dd.text);
  assert.equal(dd.json.days.length, 7);
  const noUser = await adm("GET", "/local-admin/usage/daily?scope=all&days=7&user=nobody");
  assert.equal(noUser.status, 404);
  const att = await adm("GET", "/local-admin/attachments");
  assert.equal(att.status, 200, att.text);
  const pl = await adm("GET", "/local-admin/plugins");
  assert.equal(pl.status, 200, pl.text);
  assert.ok(Array.isArray(pl.json.plugins));
  const bad = await adm("POST", "/local-admin/plugins/inspect", { source: "gitlab", repo: "a/b" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "bad_source");
  // repeated use keeps working (cached internal device)
  assert.equal((await adm("GET", "/local-admin/plugins")).status, 200);
});
