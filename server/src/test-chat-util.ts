// Test helper (S2): server child process + fake OpenAI-compatible backend recording request bodies.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { startServer, api, openWs, sleep, freePort, type TestServer } from "./test-server.js";

export { sleep, randomUUID };

export interface Backend { port: number; bodies: any[]; server: Server; slowMs: number; close(): void }

export async function startBackend(): Promise<Backend> {
  const port = await freePort();
  const be: Backend = { port, bodies: [], slowMs: 0, server: null as any, close() { be.server.closeAllConnections(); be.server.close(); } };
  be.server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) { res.writeHead(404).end(); return; } // adapter probes etc.
    be.bodies.push(body);
    const msgs: any[] = body.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const parts = [`R:${lastUser}`, "-end"];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    for (const p of parts) {
      send({ id: "x", choices: [{ index: 0, delta: { content: p } }] });
      if (be.slowMs) await sleep(be.slowMs);
      if (closed) return;
    }
    send({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ id: "x", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, timings: { predicted_ms: 1 } });
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1");
  return be;
}

export interface Ctx { s: TestServer; token: string; provId: string; be: Backend; call(method: string, path: string, body?: unknown, tok?: string): ReturnType<typeof api>; stop(): void }

export async function setup(env: Record<string, string> = {}): Promise<Ctx> {
  const s = await startServer(env);
  const be = await startBackend();
  const reg = await api(s.base, "POST", "/auth/register", { username: "tester", password: "password123" });
  const token = reg.json.token as string;
  const provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${be.port}/v1`, model: "fake-model" }, token);
  return {
    s, token, provId, be,
    call: (method, path, body, tok = token) => api(s.base, method, path, body, tok),
    stop() { s.stop(); be.close(); },
  };
}

export interface Client { ws: WebSocket; frames: any[]; msg(id: string): any; waitMsg(id: string, pred?: (m: any) => boolean, ms?: number): Promise<any>; waitFrame(pred: (f: any) => boolean, ms?: number): Promise<any>; send(o: unknown): void }

export async function connect(c: Ctx, token = c.token): Promise<Client> {
  const ws = await openWs(`ws://127.0.0.1:${c.s.port}/ws?token=${token}`);
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const msg = (id: string) => { let m: any; for (const f of frames) if (f.type === "upsert") for (const x of f.messages ?? []) if (x.id === id) m = x; return m; };
  const waitFrame = async (pred: (f: any) => boolean, ms = 5000) => {
    const t = Date.now();
    for (;;) {
      const f = frames.find(pred);
      if (f) return f;
      if (Date.now() - t > ms) throw new Error("timeout waiting for frame");
      await sleep(15);
    }
  };
  const waitMsg = async (id: string, pred: (m: any) => boolean = (m) => m.status !== "streaming", ms = 5000) => {
    const t = Date.now();
    for (;;) {
      const m = msg(id);
      if (m && pred(m)) return m;
      if (Date.now() - t > ms) throw new Error(`timeout waiting for message ${id}: ${JSON.stringify(m)}`);
      await sleep(15);
    }
  };
  await waitFrame((f) => f.type === "snapshot");
  return { ws, frames, msg, waitMsg, waitFrame, send: (o) => ws.send(JSON.stringify(o)) };
}

export async function newConv(c: Ctx, body: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const r = await c.call("PUT", `/conversations/${id}`, { providerId: c.provId, ...body });
  if (r.status !== 200) throw new Error("conv create failed " + r.text);
  return id;
}

/** Sends a user message and waits for the assistant reply to finish. */
export async function say(c: Ctx, cl: Client, conversationId: string, content: string, extra: Record<string, unknown> = {}) {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId, content, userMessageId, assistantMessageId, ...extra });
  const asst = await cl.waitMsg(assistantMessageId);
  return { userMessageId, assistantMessageId, asst };
}

export const syncAll = async (c: Ctx, since = 0) => (await c.call("GET", `/sync?since=${since}`)).json;
