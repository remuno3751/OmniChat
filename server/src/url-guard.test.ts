import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenOutboundUrl } from "./url-guard.js";

test("link-local and metadata targets are refused, LAN/loopback/public stay allowed", () => {
  for (const u of [
    "http://169.254.169.254/latest/meta-data", "http://169.254.0.1:8080", "http://[fe80::1]/", "http://[fd00:ec2::254]/",
    "http://[::ffff:169.254.169.254]/", "http://0xA9FEA9FE/", "http://2852039166/", "http://metadata.google.internal/", "http://0.0.0.0:80/",
    "ftp://example.com/", "file:///etc/passwd", "not a url",
  ]) assert.ok(forbiddenOutboundUrl(u), u);
  for (const u of [
    "http://localhost:1234/v1", "http://127.0.0.1:11434", "http://192.168.0.10:8080", "http://10.0.0.5", "https://ntfy.sh/topic",
    "https://user:pass@ntfy.example.com/t", "http://[::1]:8080/",
  ]) assert.equal(forbiddenOutboundUrl(u), null, u);
});

import { before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { setup, type Ctx } from "./test-chat-util.js";

let c: Ctx;
before(async () => { c = await setup(); });
after(() => c?.stop());

test("PUT /providers and notifyUrl refuse link-local targets; LAN URLs and dsh-bridge names still work", async () => {
  const mk = (baseUrl: string, kind = "openai") => c.call("PUT", `/providers/${randomUUID()}`, { name: "p", kind, baseUrl, model: "m" });
  assert.equal((await mk("http://169.254.169.254/v1")).status, 400);
  assert.equal((await mk("http://192.168.0.5:1234/v1")).status, 200);
  assert.equal((await mk("pc-mode", "dsh-bridge")).status, 200);
  assert.equal((await c.call("PUT", "/settings", { notifyUrl: "http://169.254.169.254/x" })).status, 400);
  assert.equal((await c.call("PUT", "/settings", { notifyUrl: "https://ntfy.sh/topic" })).status, 200);
});
