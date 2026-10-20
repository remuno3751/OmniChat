import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setup, type Ctx } from "./test-chat-util.js";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret.js";

let c: Ctx;
before(async () => { c = await setup({ OMNICHAT_SECRET_KEY: "a-test-master-key-123456" }); });
after(() => c?.stop());

test("encryptSecret round-trips, is non-deterministic and leaves legacy/empty values alone", () => {
  const e = encryptSecret("sk-secret");
  assert.ok(isEncrypted(e) && !e.includes("sk-secret"));
  assert.equal(decryptSecret(e), "sk-secret");
  assert.notEqual(encryptSecret("sk-secret"), e);
  assert.equal(decryptSecret("legacy-plain"), "legacy-plain");
  assert.equal(encryptSecret(""), "");
  assert.equal(decryptSecret(e.slice(0, -3) + "AAA"), "", "tampered ciphertext is rejected");
});

test("a provider API key is stored encrypted, still reported as hasKey, and survives an update without apiKey", async () => {
  const id = randomUUID();
  const r = await c.call("PUT", `/providers/${id}`, { name: "k", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "sk-plain-123" });
  assert.equal(r.json.hasKey, true);
  const db = new DatabaseSync(join(c.s.tmp, "t.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  const stored = (db.prepare("SELECT api_key FROM providers WHERE id = ?").get(id) as any).api_key as string;
  assert.ok(isEncrypted(stored) && !stored.includes("sk-plain-123"));
  await c.call("PUT", `/providers/${id}`, { name: "k2", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "m" });
  assert.equal((db.prepare("SELECT api_key FROM providers WHERE id = ?").get(id) as any).api_key, stored);
  db.close();
});
