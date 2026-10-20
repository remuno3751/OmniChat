// Attachments on a llama.cpp provider: /v1/models carries no modalities, /props does (modalities.vision).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { startServer, api, freePort, type TestServer } from "./test-server.js";
import { connect, newConv, type Client, type Ctx } from "./test-chat-util.js";

const PW = "password123";
const MODEL = "qwen-vl-llamacpp";

let s: TestServer;
let vlm: Server, textOnly: Server, small: Server;
const seen = { vlm: [] as any[], textOnly: [] as any[], small: [] as any[] };
let tok = "", pVlm = "", pText = "", pSmall = "";

/** A llama.cpp server: a plain model list, /props with n_ctx and modalities, OpenAI chat completions that record the body. */
function llama(rec: any[], opts: { vision: boolean | undefined; nCtx: number }): Server {
  return createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.method === "GET" && req.url?.startsWith("/props")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        default_generation_settings: { n_ctx: opts.nCtx }, model_alias: MODEL, total_slots: 1,
        ...(opts.vision === undefined ? {} : { modalities: { vision: opts.vision } }),
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }] }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      rec.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "OK" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(404).end();
  });
}
const listen = (srv: Server) => new Promise<string>((ok) => { const p = 20000 + Math.floor(Math.random() * 20000); srv.listen(p, "127.0.0.1", () => ok(`http://127.0.0.1:${p}`)); });

const ctxFor = (provId: string): Ctx => ({
  s, token: tok, provId, be: undefined as any,
  call: (m, p, b, t = tok) => api(s.base, m, p, b, t),
  stop() { /* shared */ },
});
async function upload(name: string, body: Buffer | string, mime: string) {
  const r = await fetch(s.base + "/attachments", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": mime, "x-file-name": encodeURIComponent(name) },
    body: new Uint8Array(typeof body === "string" ? Buffer.from(body) : body),
  });
  const json: any = await r.json();
  assert.equal(r.status, 200, JSON.stringify(json));
  return json.attachment as { id: string };
}
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
async function sendOk(cl: Client, conv: string, content: string, ids: string[]) {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId: conv, content, userMessageId, assistantMessageId, attachmentIds: ids });
  const asst = await cl.waitMsg(assistantMessageId);
  assert.equal(asst.status, "done", JSON.stringify(asst));
}
const lastUser = (body: any) => [...body.messages].reverse().find((m: any) => m.role === "user");

before(async () => {
  vlm = llama(seen.vlm, { vision: true, nCtx: 32768 });
  textOnly = llama(seen.textOnly, { vision: false, nCtx: 32768 });
  small = llama(seen.small, { vision: undefined, nCtx: 4096 });
  const [bVlm, bText, bSmall] = [await listen(vlm), await listen(textOnly), await listen(small)];
  s = await startServer({ OMNICHAT_OPEN_FIRST_REGISTRATION: "1", ALLOW_REGISTRATION: "1" });
  tok = (await api(s.base, "POST", "/auth/register", { username: "boss", password: PW, deviceName: "t", platform: "test" })).json.token;
  const mk = async (base: string) => {
    const id = randomUUID();
    assert.equal((await api(s.base, "PUT", `/providers/${id}`, { name: "llama.cpp", kind: "openai-compatible", baseUrl: `${base}/v1`, model: MODEL }, tok)).status, 200);
    return id;
  };
  pVlm = await mk(bVlm); pText = await mk(bText); pSmall = await mk(bSmall);
});
after(() => { s?.stop(); vlm?.close(); textOnly?.close(); small?.close(); });

test("the model list reports vision from /props", async () => {
  const get = async (p: string) => (await api(s.base, "GET", `/providers/${p}/models`, undefined, tok)).json.models.find((m: any) => m.id === MODEL);
  assert.equal((await get(pVlm)).vision, "yes");
  assert.equal((await get(pText)).vision, "no");
  assert.equal((await get(pSmall)).vision, undefined, "/props without modalities says nothing");
});

test("an image reaches a llama.cpp model whose /props says vision", async () => {
  const cl = await connect(ctxFor(pVlm));
  const conv = await newConv(ctxFor(pVlm), { providerId: pVlm, model: MODEL });
  const a = await upload("shot.png", png, "image/png");
  await sendOk(cl, conv, "what is this", [a.id]);
  const u = lastUser(seen.vlm[seen.vlm.length - 1]);
  assert.ok(Array.isArray(u.content), "sent as content parts");
  assert.ok(u.content.some((p: any) => p.type === "image_url"), JSON.stringify(u.content).slice(0, 200));
  cl.ws.close();
});

test("a text-only llama.cpp model gets a note instead of the image", async () => {
  const cl = await connect(ctxFor(pText));
  const conv = await newConv(ctxFor(pText), { providerId: pText, model: MODEL });
  const a = await upload("shot.png", png, "image/png");
  await sendOk(cl, conv, "what is this", [a.id]);
  const u = lastUser(seen.textOnly[seen.textOnly.length - 1]);
  assert.equal(typeof u.content, "string");
  assert.match(u.content, /読めません/);
  cl.ws.close();
});

test("a document reaches a llama.cpp model (small context): the text is in the prompt", async () => {
  const cl = await connect(ctxFor(pSmall));
  const conv = await newConv(ctxFor(pSmall), { providerId: pSmall, model: MODEL });
  const doc = "DOC-LINE alpha beta gamma\n".repeat(60); // ~1.5k chars
  const a = await upload("report.txt", doc, "text/plain");
  await sendOk(cl, conv, "summarize", [a.id]);
  const u = lastUser(seen.small[seen.small.length - 1]);
  assert.equal(typeof u.content, "string");
  assert.ok(u.content.includes("[添付: report.txt]") && u.content.includes("DOC-LINE alpha beta gamma"), String(u.content).slice(0, 200));
  cl.ws.close();
});

