// PROTOCOL v7 (docs/PROTOCOL-v7-dshmodels.md): dsh model catalog in the Code picker (1.1, 1.2) and the omni_* import frames (2.1).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { startServer, api, openWs, sleep, type TestServer } from "./test-server.js";

let S: TestServer;
let upstream: Server;
let tok = "";
const sockets: WebSocket[] = [];

/** Polls f until it returns a truthy value (or throws after ms). */
async function poll<T>(f: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> {
  const t = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error("timeout");
    await sleep(25);
  }
}

/** Opens a fake bridge connection (authenticated with the test user's token) and records every frame it receives. */
async function bridge(name: string): Promise<{ ws: WebSocket; got: any[] }> {
  const ws = await openWs(`ws://127.0.0.1:${S.port}/bridge?token=${tok}&name=${name}`);
  sockets.push(ws);
  const got: any[] = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  return { ws, got };
}

const replyFor = (got: any[], requestId: string) => poll(async () => got.find((m) => m.requestId === requestId));

before(async () => {
  // Fake OpenAI-compatible upstream: one chat model and one embedding model (the latter must be filtered out).
  upstream = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3-8b" }, { id: "text-embedding-x" }] }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;

  S = await startServer();
  tok = (await api(S.base, "POST", "/auth/register", { username: "dshuser", password: "password123" })).json.token;
  await api(S.base, "PUT", `/providers/${randomUUID()}`, { name: "LM Studio", kind: "openai-compatible", baseUrl: upstreamBase, model: "x" }, tok);
});

after(() => {
  for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
  S?.stop();
  upstream?.close();
});

test("ready frame: providerName/imported/defaultModel reach GET /models groups; old-style entries unchanged", async () => {
  const { ws } = await bridge("pc");
  const prov = randomUUID();
  await api(S.base, "PUT", `/providers/${prov}`, { name: "PC", kind: "dsh-bridge", baseUrl: "pc", model: "x" }, tok);
  ws.send(JSON.stringify({
    type: "ready", name: "pc", cwd: "C:/work", defaultModel: "lmstudio::qwen3-8b",
    models: [
      { provider: "lmstudio", id: "qwen3-8b", name: "Qwen3 8B", providerName: "LM Studio", imported: true },
      { provider: "lmstudio", id: "old-one", name: "Old" },
    ],
  }));

  const g = await poll(async () => (await api(S.base, "GET", "/models", undefined, tok)).json.groups.find((x: any) => x.providerId === prov && x.models.length === 2));
  assert.equal(g.defaultModel, "lmstudio::qwen3-8b");
  const byId = new Map<string, any>(g.models.map((m: any) => [m.id, m]));

  const q = byId.get("lmstudio::qwen3-8b");
  assert.equal(q.name, "Qwen3 8B");
  assert.equal(q.group, "LM Studio");
  assert.equal(q.current, true);
  assert.equal(q.imported, true);

  const old = byId.get("lmstudio::old-one");
  assert.equal(old.name, "old-one (lmstudio)");
  assert.equal(old.group, "lmstudio");
  assert.equal("current" in old, false);
  assert.equal("imported" in old, false);
});

test("omni_models_request: chat models of openai-compatible providers, baseUrl ends with /v1", async () => {
  const { ws, got } = await bridge("pc-models");
  ws.send(JSON.stringify({ type: "omni_models_request", requestId: "req-models-1" }));
  const r = await replyFor(got, "req-models-1");
  assert.equal(r.type, "omni_models");
  assert.equal(r.ok, true);
  assert.ok(r.baseUrl.startsWith("http://127.0.0.1:"));
  assert.ok(r.baseUrl.endsWith("/v1"));
  assert.deepEqual(r.models, [{ id: "lm-studio/qwen3-8b", name: "qwen3-8b", providerName: "LM Studio" }]);
});

test("omni_key_request: ocsk- key works on /v1/models, is listed as DSH import, and revoke only takes DSH keys", async () => {
  const { ws, got } = await bridge("pc-key");
  ws.send(JSON.stringify({ type: "omni_key_request", requestId: "k1" }));
  const k = await replyFor(got, "k1");
  assert.equal(k.type, "omni_key");
  assert.equal(k.ok, true);
  assert.equal(typeof k.keyId, "string");
  assert.ok(k.apiKey.startsWith("ocsk-"));

  assert.equal((await api(S.base, "GET", "/v1/models", undefined, k.apiKey)).status, 200);
  const keys = (await api(S.base, "GET", "/apikeys", undefined, tok)).json.keys;
  const mine = keys.find((x: any) => x.id === k.keyId);
  assert.ok(mine);
  assert.equal(mine.name, "DSH import (pc-key)");
  assert.equal(JSON.stringify(keys).includes(k.apiKey), false, "the plain key is never listed");

  // A key that is not a DSH import key must not be revoked through the bridge.
  const other = (await api(S.base, "POST", "/apikeys", { name: "laptop" }, tok)).json;
  ws.send(JSON.stringify({ type: "omni_key_revoke", requestId: "r-other", keyId: other.id }));
  const ro = await replyFor(got, "r-other");
  assert.equal(ro.type, "omni_key_revoked");
  assert.equal(ro.ok, false);
  assert.equal((await api(S.base, "GET", "/v1/models", undefined, other.key)).status, 200);

  ws.send(JSON.stringify({ type: "omni_key_revoke", requestId: "r-mine", keyId: k.keyId }));
  const rm = await replyFor(got, "r-mine");
  assert.equal(rm.ok, true);
  assert.equal((await api(S.base, "GET", "/v1/models", undefined, k.apiKey)).status, 401);

  ws.send(JSON.stringify({ type: "omni_key_revoke", requestId: "r-unknown", keyId: randomUUID() }));
  assert.equal((await replyFor(got, "r-unknown")).ok, false);
});

test("omni_key_request is rate limited to 5 per minute per bridge connection", async () => {
  const { ws, got } = await bridge("pc-rate");
  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({ type: "omni_key_request", requestId: `rl-${i}` }));
    assert.equal((await replyFor(got, `rl-${i}`)).ok, true);
  }
  ws.send(JSON.stringify({ type: "omni_key_request", requestId: "rl-5" }));
  const r6 = await replyFor(got, "rl-5");
  assert.equal(r6.type, "omni_key");
  assert.equal(r6.ok, false);
  assert.equal(r6.error, "rate limited");
});

test("malformed omni frames are ignored (no reply) and do not crash the server", async () => {
  const { ws, got } = await bridge("pc-bad");
  ws.send(JSON.stringify({ type: "omni_key_request" })); // no requestId
  ws.send(JSON.stringify({ type: "omni_models_request", requestId: 42 })); // requestId not a string
  ws.send(JSON.stringify({ type: "omni_key_revoke", requestId: null }));
  ws.send("not json {");
  ws.send(JSON.stringify({ type: "omni_key_revoke", requestId: "no-key" })); // keyId missing: answered with ok:false
  ws.send(JSON.stringify({ type: "omni_models_request", requestId: "after-bad" }));

  assert.equal((await replyFor(got, "after-bad")).ok, true);
  assert.deepEqual(got.map((m) => m.requestId), ["no-key", "after-bad"]);
  assert.equal(got[0].ok, false);
  assert.equal((await api(S.base, "GET", "/models", undefined, tok)).status, 200);
});
