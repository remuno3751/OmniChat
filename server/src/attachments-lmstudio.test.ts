// Attachments on an LM Studio provider: /v1/models says nothing about images, /api/v0/models gives type "vlm" per model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { startServer, api, type TestServer } from "./test-server.js";
import { connect, newConv, type Client, type Ctx } from "./test-chat-util.js";

const PW = "password123";
let s: TestServer, lm: Server;
const seen: any[] = [];
let tok = "", prov = "";

const MODELS = [
  { id: "google/gemma-4-e4b", object: "model", type: "vlm", state: "loaded", max_context_length: 131072, loaded_context_length: 8192 },
  { id: "plain/text-model", object: "model", type: "llm", state: "not-loaded", max_context_length: 32768 },
];

function fakeLmStudio(): Server {
  return createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    if (req.method === "GET" && req.url === "/v1/models") return json({ object: "list", data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "organization_owner" })) });
    if (req.method === "GET" && req.url === "/api/v0/models") return json({ object: "list", data: MODELS });
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      seen.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
}

const ctxFor = (): Ctx => ({ s, token: tok, provId: prov, be: undefined as any, call: (m, p, b, t = tok) => api(s.base, m, p, b, t), stop() { /* shared */ } });
async function upload(name: string, body: Buffer, mime: string) {
  const r = await fetch(s.base + "/attachments", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": mime, "x-file-name": encodeURIComponent(name) }, body: new Uint8Array(body) });
  const json: any = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json.attachment as { id: string };
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
async function sendOk(cl: Client, conv: string, ids: string[]) {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId: conv, content: "what is this", userMessageId, assistantMessageId, attachmentIds: ids });
  const asst = await cl.waitMsg(assistantMessageId);
  assert.equal(asst.status, "done", JSON.stringify(asst));
}
const lastUser = (body: any) => [...body.messages].reverse().find((m: any) => m.role === "user");

before(async () => {
  lm = fakeLmStudio();
  const port = 20000 + Math.floor(Math.random() * 20000);
  await new Promise<void>((ok) => lm.listen(port, "127.0.0.1", ok));
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1" });
  tok = (await api(s.base, "POST", "/auth/register", { username: "boss", password: PW, deviceName: "t", platform: "test" })).json.token;
  prov = randomUUID();
  assert.equal((await api(s.base, "PUT", `/providers/${prov}`, { name: "LM Studio", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${port}/v1`, model: MODELS[0].id }, tok)).status, 200);
});
after(() => { s?.stop(); lm?.close(); });

test("the model list reports vision per model from LM Studio's type", async () => {
  const list = (await api(s.base, "GET", `/providers/${prov}/models`, undefined, tok)).json.models;
  assert.equal(list.find((m: any) => m.id === "google/gemma-4-e4b").vision, "yes");
  assert.equal(list.find((m: any) => m.id === "plain/text-model").vision, "no");
});

test("an image reaches an LM Studio vlm model", async () => {
  const cl = await connect(ctxFor());
  const conv = await newConv(ctxFor(), { providerId: prov, model: "google/gemma-4-e4b" });
  await sendOk(cl, conv, [(await upload("shot.png", png, "image/png")).id]);
  const u = lastUser(seen[seen.length - 1]);
  assert.ok(Array.isArray(u.content) && u.content.some((p: any) => p.type === "image_url"), JSON.stringify(u.content).slice(0, 200));
  cl.ws.close();
});
