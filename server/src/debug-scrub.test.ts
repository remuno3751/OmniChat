// Debug records of a borrower's message never show a shared provider owner's URL or key
// (the upstream error body is echoed back by the fake; GET /messages/:id/debug is the borrower's view).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { connect, newConv, type Ctx } from "./test-chat-util.js";

const PW = "password123";
const OWNER_KEY = "OWNER-KEY-DEBUG-SCRUB-7373";

let s: TestServer;
let fake: Server;
let fakeBase = "";
let localTok = "";
let tokA = "", tokAlice = "";
let pShared = "";

const local = (method: string, path: string, body?: unknown) =>
  api(s.base, method, path, body, "", { "x-local-admin": localTok });
const ctxFor = (tok: string, provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* shared server, stopped in after() */ },
});

before(async () => {
  // fake upstream: any request whose last user message is "boom" fails with a body that echoes the key and the URL
  const port = await freePort();
  fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const key = String(req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
    const body = JSON.parse(raw || "{}");
    const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
    if (key !== OWNER_KEY) { res.writeHead(401).end('{"error":"bad key"}'); return; }
    if (last === "boom") {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({
        error: `upstream failure for Authorization: Bearer ${key} at ${fakeBase}/chat/completions`,
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: `R:${last}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1");
  fakeBase = `http://127.0.0.1:${port}/v1`;

  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "0", ALLOW_REGISTRATION: "0" });
  localTok = readFileSync(join(s.tmp, "local-admin.token"), "utf8").trim();
  for (const [u, role] of [["adminA", "admin"], ["alice", "user"]] as const) {
    assert.equal((await local("POST", "/local-admin/users", { username: u, password: PW, role })).status, 200, u);
  }
  [tokA, tokAlice] = await Promise.all(["adminA", "alice"].map(async (u) =>
    (await api(s.base, "POST", "/auth/login", { username: u, password: PW })).json.token as string));

  pShared = randomUUID();
  assert.equal((await api(s.base, "PUT", `/providers/${pShared}`, {
    name: "Owner fake", kind: "openai-compatible", baseUrl: fakeBase, model: "m1", apiKey: OWNER_KEY,
  }, tokA)).status, 200);
  assert.equal((await api(s.base, "PUT", `/admin/providers/${pShared}/shared`, { shared: true }, tokA)).status, 200);
  // every user may borrow the shared provider by default
  assert.equal((await api(s.base, "PUT", "/admin/settings", { defaultSharedAccess: "all" }, tokA)).status, 200);
});
after(() => { s?.stop(); fake?.close(); });

test("a borrower's debug record shows neither the owner's URL nor key after an upstream error", async () => {
  const cl = await connect(ctxFor(tokAlice, pShared));
  const conv = await newConv(ctxFor(tokAlice, pShared), { providerId: pShared, model: "m1" });
  const assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId: conv, content: "boom", userMessageId: randomUUID(), assistantMessageId });
  const asst = await cl.waitMsg(assistantMessageId);
  assert.equal(asst.status, "error");
  assert.equal(asst.content.includes(OWNER_KEY), false);

  const dbg = await api(s.base, "GET", `/messages/${assistantMessageId}/debug`, undefined, tokAlice);
  assert.equal(dbg.status, 200);
  const text = dbg.text;
  assert.equal(text.includes(OWNER_KEY), false, "owner key in debug output");
  assert.equal(text.includes(fakeBase), false, "owner base URL in debug output");
  assert.equal(text.includes("127.0.0.1"), false, "owner host in debug output");
  assert.equal(dbg.json.response.status, 500);
  cl.ws.close();
});

test("an error thrown by fetch itself (no HTTP status) keeps the owner's base URL and key out of the message", async () => {
  // a base URL fetch cannot parse: its error message echoes the URL it was given
  const { createProvider } = await import("./providers/index.js");
  await import("./providers/openai-compatible.js");
  const OWNER_BASE = "owner-only-base-url.example-owner";
  const provider = createProvider({ kind: "openai-compatible", baseUrl: OWNER_BASE, apiKey: OWNER_KEY, model: "m1" });
  const sink: any = { response: {} };
  let thrown: unknown = null;
  try {
    const signal = new AbortController().signal;
    for await (const _ of provider.stream({ messages: [{ role: "user", content: "hi" }], model: "m1", debug: sink, signal })) { /* drain */ }
  } catch (e) { thrown = e; }
  assert.ok(thrown instanceof Error, "stream should fail");
  const msg = (thrown as Error).message;
  assert.equal(msg.includes(OWNER_BASE), false, msg);
  assert.equal(msg.includes(OWNER_KEY), false, msg);
  assert.equal(JSON.stringify(sink).includes(OWNER_BASE), false);
});
