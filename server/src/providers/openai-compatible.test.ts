import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createProvider, providerKinds } from "./index.js";

let server: http.Server;
let base = "";
let lastAuth: string | undefined;
let lastBody: any;

const chunk = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    lastAuth = req.headers["authorization"];
    lastBody = raw ? JSON.parse(raw) : undefined;
    const path = req.url ?? "";
    if (path.startsWith("/lmstudio/") && lastBody?.response_format?.type === "json_object") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "'response_format.type' must be 'json_schema' or 'text'" }));
      return;
    }
    if (path.startsWith("/err/")) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("bad key " + "x".repeat(1000));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (path.startsWith("/split/")) {
      const full =
        ": comment\n\n" +
        chunk("Hel") +
        "data: not json\n\n" +
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n\n` +
        chunk("lo") +
        "data: [DONE]\n\n" +
        chunk("after");
      for (let i = 0; i < full.length; i += 7) {
        res.write(full.slice(i, i + 7));
        await sleep(2);
      }
      res.end();
    } else if (path.startsWith("/lmstudio/")) {
      res.write(chunk('{"ok":true}'));
      res.end("data: [DONE]\n\n");
    } else if (path.startsWith("/hang/")) {
      res.write(chunk("first"));
      req.on("close", () => res.end());
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const mk = (path: string, apiKey = "") =>
  createProvider({ kind: "openai-compatible", baseUrl: base + path, apiKey, model: "m" });

test("registered", () => {
  assert.ok(providerKinds().includes("openai-compatible"));
  assert.throws(() => createProvider({ kind: "nope", baseUrl: "", apiKey: "", model: "" }));
});

test("parses split chunks, ignores junk, yields reasoning on its own lane, stops at DONE", async () => {
  const p = mk("/split/", "sk-test");
  const out: unknown[] = [];
  for await (const d of p.stream({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-x",
    signal: new AbortController().signal,
  })) out.push(d);
  assert.deepEqual(out, ["Hel", { kind: "reasoning", text: "think" }, "lo"]);
  assert.equal(lastAuth, "Bearer sk-test");
  assert.equal(lastBody.model, "gpt-x");
  assert.equal(lastBody.stream, true);
});

test("no Authorization header without apiKey; trailing slash handled", async () => {
  const p = mk("/split//");
  for await (const _ of p.stream({ messages: [], model: "m", signal: new AbortController().signal }));
  assert.equal(lastAuth, undefined);
});

test("non-2xx throws with status and <=300 char snippet", async () => {
  const p = mk("/err/");
  await assert.rejects(
    async () => {
      for await (const _ of p.stream({ messages: [], model: "m", signal: new AbortController().signal }));
    },
    (e: Error) => {
      assert.match(e.message, /401/);
      assert.match(e.message, /bad key/);
      assert.ok(e.message.length < 400);
      return true;
    },
  );
});

test("abort stops the stream", async () => {
  const p = mk("/hang/");
  const ac = new AbortController();
  const out: unknown[] = [];
  await assert.rejects(async () => {
    for await (const d of p.stream({ messages: [], model: "m", signal: ac.signal })) {
      out.push(d);
      ac.abort();
    }
  });
  assert.deepEqual(out, ["first"]);
});

test("json_object: a server that only knows json_schema gets one retry with an any-object schema", async () => {
  const p = mk("/lmstudio/v1");
  let text = "";
  for await (const it of p.stream({ messages: [{ role: "user", content: "x" }], responseFormat: { type: "json_object" } } as any)) {
    if (typeof it === "string") text += it;
  }
  assert.equal(lastBody.response_format.type, "json_schema");
  assert.deepEqual(lastBody.response_format.json_schema.schema, { type: "object" });
  assert.equal(text, '{"ok":true}');
});
