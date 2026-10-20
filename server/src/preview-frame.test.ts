// Code preview frame page: its own sandboxing CSP, strict by default, external only on request.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPreviewFrameRoute } from "./routes-preview-frame.js";

async function get(url: string) {
  const app = Fastify();
  registerPreviewFrameRoute(app);
  const res = await app.inject({ method: "GET", url });
  await app.close();
  return res;
}

test("preview frame: sandboxing CSP, no network in strict mode", async () => {
  const res = await get("/preview-frame");
  assert.equal(res.statusCode, 200);
  const csp = String(res.headers["content-security-policy"]);
  assert.match(csp, /^sandbox allow-scripts;/);
  assert.ok(!csp.includes("allow-same-origin"));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.ok(!/connect-src/.test(csp) && !/https:/.test(csp));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.body, /omnichat-preview-ready/);
  assert.match(res.body, /document\.cookie/); // refuses to run when not sandboxed
});

test("preview frame: external mode allows https only", async () => {
  const csp = String((await get("/preview-frame?mode=external")).headers["content-security-policy"]);
  assert.match(csp, /script-src 'unsafe-inline' https:/);
  assert.match(csp, /connect-src https:/);
  assert.ok(!/http:(?!s)/.test(csp.replace(/https:/g, "")));
});
