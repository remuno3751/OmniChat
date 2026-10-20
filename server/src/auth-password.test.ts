import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api, type TestServer } from "./test-server.js";

let S: TestServer;
before(async () => { S = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1" }); });
after(() => S.stop());

test("a user changes their own password: needs the current one, keeps this device, signs out the others", async () => {
  const a = await api(S.base, "POST", "/auth/register", { username: "alice", password: "password123", deviceName: "Laptop" });
  const other = await api(S.base, "POST", "/auth/login", { username: "alice", password: "password123", deviceName: "Phone" });
  assert.equal(a.status, 200);
  assert.equal(other.status, 200);

  const bad = await api(S.base, "POST", "/auth/password", { currentPassword: "wrong-password", newPassword: "new-password-1" }, a.json.token);
  assert.equal(bad.status, 403);
  const short = await api(S.base, "POST", "/auth/password", { currentPassword: "password123", newPassword: "short" }, a.json.token);
  assert.equal(short.status, 400);
  const none = await api(S.base, "POST", "/auth/password", { currentPassword: "password123", newPassword: "new-password-1" });
  assert.equal(none.status, 401);

  const ok = await api(S.base, "POST", "/auth/password", { currentPassword: "password123", newPassword: "new-password-1" }, a.json.token);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revokedDevices, 1);

  assert.equal((await api(S.base, "GET", "/devices", undefined, a.json.token)).status, 200, "this device stays signed in");
  assert.equal((await api(S.base, "GET", "/devices", undefined, other.json.token)).status, 401, "the other device is signed out");
  assert.equal((await api(S.base, "POST", "/auth/login", { username: "alice", password: "password123" })).status, 401, "old password no longer works");
  assert.equal((await api(S.base, "POST", "/auth/login", { username: "alice", password: "new-password-1" })).status, 200);
});

test("wrong current passwords are rate limited like login failures", async () => {
  const l = await api(S.base, "POST", "/auth/login", { username: "alice", password: "new-password-1" });
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await api(S.base, "POST", "/auth/password", { currentPassword: `nope-${i}-xx`, newPassword: "another-pass-9" }, l.json.token)).status;
  assert.equal(last, 429);
});
