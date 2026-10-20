import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api, type TestServer } from "./test-server.js";

let S: TestServer;
before(async () => { S = await startServer(); });
after(() => S?.stop());

test("a full sync carries the settings document even when the user never saved any", async () => {
  const tok = (await api(S.base, "POST", "/auth/register", { username: "freshuser", password: "password123" })).json.token;
  const full = await api(S.base, "GET", "/sync?since=0", undefined, tok);
  assert.equal(full.status, 200);
  assert.equal(full.json.settings?.contextOverflow, "summarize");
  // an incremental sync past the settings' seq does not repeat them
  const next = await api(S.base, "GET", `/sync?since=${full.json.seq + 5}`, undefined, tok);
  assert.equal(next.json.settings, undefined);
});
