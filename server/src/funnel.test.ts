// Tailscale Funnel hardening: a request from 127.0.0.1 that carries forwarding headers is a remote user, never the server machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startServer, api, type TestServer } from "./test-server.js";
import { classifyRoute, hasForwardingHeaders } from "./route.js";
import { exposureWarnings, type ExposureInput } from "./diagnostics.js";

let s: TestServer;
let p: TestServer;
let tok = "";
before(async () => {
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0" });
  tok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  p = await startServer({ TRUST_PROXY: "1" });
});
after(() => { s?.stop(); p?.stop(); });

test("hasForwardingHeaders recognises proxy and Tailscale headers", () => {
  for (const h of ["x-forwarded-for", "X-Forwarded-Proto", "x-forwarded-host", "forwarded", "x-real-ip", "via", "tailscale-user-login", "Tailscale-Funnel-Request"]) {
    assert.equal(hasForwardingHeaders({ [h]: "x" }), true, h);
  }
  assert.equal(hasForwardingHeaders({ host: "a", "x-local-admin": "t", "user-agent": "u" }), false);
});

test("classifyRoute: loopback peer behind a proxy is never loopback", () => {
  assert.equal(classifyRoute("127.0.0.1", undefined, false, true), "external");
  assert.equal(classifyRoute("127.0.0.1", "8.8.8.8", false), "external");
  assert.equal(classifyRoute("127.0.0.1", "127.0.0.1", true), "external", "a spoofed loopback client address");
  assert.equal(classifyRoute("127.0.0.1", "::1", true), "external");
  assert.equal(classifyRoute("127.0.0.1", undefined, false, false), "loopback", "direct local use is unchanged");
  assert.equal(classifyRoute("127.0.0.1", "100.64.0.9", true), "vpn");
});

test("requireLocal refuses every forwarding header, even with a valid token", async () => {
  assert.equal((await api(s.base, "GET", "/local-admin/users", undefined, "", { "x-local-admin": tok })).status, 200);
  for (const h of ["x-forwarded-proto", "x-forwarded-host", "x-real-ip", "via", "tailscale-user-login", "tailscale-funnel-request", "forwarded", "x-forwarded-for"]) {
    const r = await api(s.base, "GET", "/local-admin/users", undefined, "", { "x-local-admin": tok, [h]: "https" });
    assert.equal(r.status, 403, h);
  }
});

test("login limiter: with TRUST_PROXY=1 remote users get separate buckets and cannot dodge the limit by spoofing", async () => {
  await api(p.base, "POST", "/auth/register", { username: "victim", password: "password123" });
  const bad = (xff: string) => api(p.base, "POST", "/auth/login", { username: "victim", password: "wrong-password" }, "", { "x-forwarded-for": xff });
  for (let i = 0; i < 10; i++) assert.equal((await bad("203.0.113.5")).status, 401);
  assert.equal((await bad("203.0.113.5")).status, 429, "client A is locked out");
  assert.equal((await bad("198.51.100.7")).status, 401, "client B is not locked out by A");
  // the proxy appends the real peer on the right; a client-chosen left entry must not open a fresh bucket
  assert.equal((await bad("1.2.3.4, 203.0.113.5")).status, 429);
  assert.equal((await bad("5.6.7.8, 203.0.113.5")).status, 429);
});

test("exposure warnings", () => {
  const base: ExposureInput = { allowRegistration: false, trustProxy: true, host: "127.0.0.1", publicUrl: "", forwardedSeen: false, tailscaleSeen: false, httpsSeen: false };
  assert.deepEqual(exposureWarnings(base), []);
  const has = (i: Partial<ExposureInput>, re: RegExp) => exposureWarnings({ ...base, ...i }).some((w) => re.test(w));
  assert.ok(has({ allowRegistration: true }, /ALLOW_REGISTRATION.*新規登録/s));
  assert.ok(has({ forwardedSeen: true, trustProxy: false, httpsSeen: true }, /TRUST_PROXY.*TRUST_PROXY/s));
  assert.ok(!has({ forwardedSeen: true, trustProxy: true, httpsSeen: true }, /TRUST_PROXY/));
  assert.ok(has({ forwardedSeen: true, httpsSeen: true }, /8 characters.*8 文字/s));
  assert.ok(has({ tailscaleSeen: true, forwardedSeen: true, httpsSeen: true, host: "0.0.0.0" }, /HOST=127\.0\.0\.1/));
  assert.ok(!has({ tailscaleSeen: true, forwardedSeen: true, httpsSeen: true }, /HOST=127/));
  assert.ok(has({ forwardedSeen: true }, /HTTPS/));
  assert.ok(!has({ forwardedSeen: true, publicUrl: "https://pc.tail1234.ts.net" }, /no sign of HTTPS/));
  assert.ok(!has({ forwardedSeen: true, httpsSeen: true }, /no sign of HTTPS/));
});
