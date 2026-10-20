// Test helper (phase 3, server A): scriptable fake OpenAI-compatible LLM (streamed tool_calls, tool rejection, non-streamed title)
// and a fake SearXNG, both on random ports.
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, sleep } from "./test-server.js";
import type { Client } from "./test-chat-util.js";

export interface Step {
  text?: string[];
  reasoning?: string[];
  calls?: { id?: string; name: string; args: unknown }[];
  /** HTTP error instead of a stream */
  status?: number;
  /** wait before answering (ms) */
  delayMs?: number;
}
export interface Llm {
  port: number; base: string;
  /** streamed chat/completions bodies */
  bodies: any[];
  /** non-streamed (title) bodies */
  titleBodies: any[];
  /** decides the answer for the n-th streamed request; default echoes the last user message */
  script: (body: any, n: number) => Step;
  /** false: any request carrying `tools` is rejected with HTTP 400 */
  toolSupport: boolean;
  /** non-streamed answer; null = HTTP 500 */
  titleReply: string | null;
  close(): void;
}

export async function startLlm(): Promise<Llm> {
  const port = await freePort();
  const llm: Llm = {
    port, base: `http://127.0.0.1:${port}/v1`, bodies: [], titleBodies: [], toolSupport: true, titleReply: null,
    script: (body) => ({ text: [`R:${[...body.messages].reverse().find((m: any) => m.role === "user")?.content ?? ""}`] }),
    close() { server.closeAllConnections(); server.close(); },
  };
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    if (req.method !== "POST" || !String(req.url).endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    if (body.stream === false) {
      llm.titleBodies.push(body);
      if (llm.titleReply === null) { res.writeHead(500, { "content-type": "application/json" }).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { role: "assistant", content: llm.titleReply } }] }));
      return;
    }
    llm.bodies.push(body);
    if (body.tools && !llm.toolSupport) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "this model does not support tools" } }));
      return;
    }
    const step = llm.script(body, llm.bodies.length - 1);
    if (step.delayMs) await sleep(step.delayMs);
    if (step.status) { res.writeHead(step.status, { "content-type": "application/json" }).end(JSON.stringify({ error: "scripted failure" })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    for (const r of step.reasoning ?? []) send({ id: "x", choices: [{ index: 0, delta: { reasoning_content: r } }] });
    for (const t of step.text ?? []) {
      send({ id: "x", choices: [{ index: 0, delta: { content: t } }] });
      await sleep(5);
      if (closed) return;
    }
    (step.calls ?? []).forEach((c, i) => {
      const args = typeof c.args === "string" ? c.args : JSON.stringify(c.args);
      const half = Math.floor(args.length / 2);
      send({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id ?? `call_${i}`, type: "function", function: { name: c.name, arguments: "" } }] } }] });
      send({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, half) } }] } }] });
      send({ id: "x", choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] } }] });
    });
    send({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: step.calls?.length ? "tool_calls" : "stop" }] });
    send({ id: "x", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1");
  return llm;
}

export interface Searx {
  port: number; url: string; queries: string[];
  mode: "json" | "html" | "403" | "down";
  results: { title: string; url: string; content?: string }[];
  close(): void;
}

export async function startSearx(): Promise<Searx> {
  const port = await freePort();
  const sx: Searx = {
    port, url: `http://127.0.0.1:${port}`, queries: [], mode: "json",
    results: Array.from({ length: 8 }, (_, i) => ({ title: `Result ${i + 1}`, url: `https://example.com/r${i + 1}`, content: `Snippet number ${i + 1}` })),
    close() { server.closeAllConnections(); server.close(); },
  };
  const server = createServer((req, res) => {
    const u = new URL(String(req.url), "http://x");
    if (u.pathname !== "/search") { res.writeHead(404).end(); return; }
    sx.queries.push(u.searchParams.get("q") ?? "");
    if (sx.mode === "down") { req.socket.destroy(); return; }
    if (sx.mode === "html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><html><body>results</body></html>"); return; }
    if (sx.mode === "403") { res.writeHead(403, { "content-type": "text/html" }).end("Forbidden"); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ query: u.searchParams.get("q"), results: sx.results }));
  }).listen(port, "127.0.0.1");
  return sx;
}

/** Writes a plugin directory under `<dataDir>/plugins/<id>/`. */
export function writePlugin(dataDir: string, id: string, files: Record<string, string>): void {
  const dir = join(dataDir, "plugins", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
}

const responders = new WeakMap<Client, (raw: any) => void>();
/** Answers every `tool_approval` frame with decide(frame) (null = stay silent); replaces this client's previous responder. Returns the received approval frames. */
export function answerApprovals(cl: Client, decide: (f: any) => "once" | "always" | "deny" | null): any[] {
  const prev = responders.get(cl);
  if (prev) cl.ws.off("message", prev);
  const seen: any[] = [];
  const h = (raw: any) => {
    const f = JSON.parse(raw.toString());
    if (f.type !== "tool_approval") return;
    seen.push(f);
    const d = decide(f);
    if (d) cl.send({ type: "tool_approval_reply", approvalId: f.approvalId, decision: d });
  };
  responders.set(cl, h);
  cl.ws.on("message", h);
  return seen;
}

/** All `tool` frames for a message: status sequence per call id. */
export function toolStatuses(cl: Client, messageId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of cl.frames) if (f.type === "tool" && f.messageId === messageId) (out[f.call.id] ??= []).push(f.call.status);
  return out;
}
