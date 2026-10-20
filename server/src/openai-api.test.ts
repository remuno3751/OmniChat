import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startServer, api, sleep, type TestServer } from "./test-server.js";

let S: TestServer;
let backend: Server;
let backendBase = "";
let tok = "";
let key = "";
const seen: { body: any; auth: string | undefined }[] = [];
let slowClosed = false;

before(async () => {
  backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model" }, { id: "slow-model" }, { id: "text-embedding-x" }] }));
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        seen.push({ body, auth: req.headers.authorization });
        if (body.model === "boom") {
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          return void res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
        }
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (body.model === "slow-model") {
            res.on("close", () => { slowClosed = true; });
            const t = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`), 30);
            res.on("close", () => clearInterval(t));
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          return void res.end();
        }
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { total_tokens: 3 } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  backendBase = `http://127.0.0.1:${(backend.address() as any).port}/v1`;

  S = await startServer();
  tok = (await api(S.base, "POST", "/auth/register", { username: "alice", password: "password123" })).json.token;
  key = (await api(S.base, "POST", "/apikeys", { name: "t" }, tok)).json.key;
  await api(S.base, "PUT", "/providers/p1", { name: "My Local", kind: "openai-compatible", baseUrl: backendBase, model: "fake-model", apiKey: "backend-secret" }, tok);
  await api(S.base, "PUT", "/providers/p2", { name: "Bridge", kind: "dsh-bridge", baseUrl: "pc", model: "x" }, tok);
});
after(() => { S.stop(); backend.close(); });

test("auth: missing/invalid key and device token give OpenAI-shaped 401", async () => {
  for (const t of ["", "ocsk-nope", tok]) {
    const r = await api(S.base, "GET", "/v1/models", undefined, t);
    assert.equal(r.status, 401);
    assert.ok(r.json.error.message && r.json.error.type);
  }
});

test("GET /v1/models: slugged ids, chat models only, no dsh-bridge", async () => {
  const r = await api(S.base, "GET", "/v1/models", undefined, key);
  assert.equal(r.status, 200);
  assert.equal(r.json.object, "list");
  const ids = r.json.data.map((m: any) => m.id);
  assert.deepEqual(ids, ["my-local/fake-model", "my-local/slow-model"]);
  assert.equal(r.json.data[0].object, "model");
});

test("non-stream: forwards params + provider key, bare and slug model ids", async () => {
  seen.length = 0;
  const body = {
    model: "my-local/fake-model", messages: [{ role: "user", content: "hi" }],
    temperature: 0.3, top_p: 0.9, top_k: 40, min_p: 0.05, repeat_penalty: 1.1, seed: 7, stop: ["x"], max_tokens: 50, reasoning_effort: "high",
  };
  const r = await api(S.base, "POST", "/v1/chat/completions", body, key);
  assert.equal(r.status, 200);
  assert.equal(r.json.choices[0].message.content, "Hello");
  assert.equal(seen[0].auth, "Bearer backend-secret");
  assert.equal(seen[0].body.model, "fake-model");
  for (const k of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "seed", "stop", "max_tokens", "reasoning_effort"]) {
    assert.deepEqual(seen[0].body[k], (body as any)[k], k);
  }
  const bare = await api(S.base, "POST", "/v1/chat/completions", { model: "fake-model", messages: [] }, key);
  assert.equal(bare.status, 200);
  assert.equal(seen[1].body.model, "fake-model");
});

test("stateless: nothing stored in chat history", async () => {
  const s = await api(S.base, "GET", "/sync?since=0", undefined, tok);
  assert.equal(s.json.conversations.length, 0);
  assert.equal(s.json.messages.length, 0);
});

test("stream: SSE passthrough", async () => {
  const r = await fetch(S.base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "my-local/fake-model", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /"content":"Hel"/);
  assert.match(text, /"content":"lo"/);
  assert.match(text, /data: \[DONE\]/);
});

test("errors in OpenAI shape: unknown model, bad body, upstream error", async () => {
  const a = await api(S.base, "POST", "/v1/chat/completions", { model: "nope/none", messages: [] }, key);
  assert.equal(a.status, 404);
  assert.equal(a.json.error.code, "model_not_found");
  const b = await api(S.base, "POST", "/v1/chat/completions", { messages: [] }, key);
  assert.equal(b.status, 400);
  assert.ok(b.json.error.message);
  const c = await api(S.base, "POST", "/v1/chat/completions", { model: "my-local/boom", messages: [] }, key);
  assert.equal(c.status, 429);
  assert.equal(c.json.error.type, "rate_limit_error");
});

test("client disconnect aborts the upstream request", async () => {
  slowClosed = false;
  const ac = new AbortController();
  const r = await fetch(S.base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "my-local/slow-model", messages: [], stream: true }),
    signal: ac.signal,
  });
  const reader = r.body!.getReader();
  await reader.read();
  ac.abort();
  const t = Date.now();
  while (!slowClosed && Date.now() - t < 5000) await sleep(25);
  assert.equal(slowClosed, true);
});
