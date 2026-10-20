// Test helper (S4): configurable fake backend covering OpenAI-compatible streaming plus the adapter endpoints
// (llama.cpp /props + /tokenize, LM Studio /api/v0/models, Ollama /api/ps|tags|show) and reasoning/usage/timings/stats.
import { createServer, type Server } from "node:http";
import { freePort, sleep } from "./test-server.js";

export interface FakeCfg {
  reasoning?: string[];
  text?: string[];
  /** delay between chunks */
  delayMs?: number;
  /** delay between the last reasoning chunk and the first text chunk */
  reasonGapMs?: number;
  /** use the `reasoning` alias instead of `reasoning_content` */
  reasoningAlias?: boolean;
  usage?: any | null;
  timings?: any;
  stats?: any;
  /** answer text derives from the last user message (default) instead of cfg.text */
  echo?: boolean;
  /** llama.cpp n_ctx */
  props?: number | null;
  tokenize?: ((t: string) => number) | null;
  lm?: any[] | null;
  ollama?: { ps: any[]; tags: any[]; show?: any } | null;
  /** body of the non-streamed (summary) answer; null = HTTP 500 */
  summary?: string | null;
  /** per-token logprob entries (choices[0].logprobs.content) attached to the first text chunk */
  logprobs?: unknown[] | null;
}
export interface Fake {
  port: number;
  base: string;
  cfg: FakeCfg;
  /** bodies of POST .../chat/completions */
  bodies: any[];
  tokenizeCalls: string[];
  server: Server;
  close(): void;
}

export async function startFake(cfg: FakeCfg = {}): Promise<Fake> {
  const port = await freePort();
  const f: Fake = {
    port, base: `http://127.0.0.1:${port}/v1`, cfg, bodies: [], tokenizeCalls: [], server: null as any,
    close() { f.server.closeAllConnections(); f.server.close(); },
  };
  f.server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const url = String(req.url);
    const json = (o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const c = f.cfg;
    if (req.method === "GET" && url === "/props") return c.props ? json({ default_generation_settings: { n_ctx: c.props }, model_alias: "m" }) : json({}, 404);
    if (req.method === "POST" && url === "/tokenize") {
      if (!c.tokenize) return json({}, 404);
      f.tokenizeCalls.push(body.content);
      return json({ tokens: Array.from({ length: c.tokenize(String(body.content ?? "")) }, (_, i) => i) });
    }
    if (req.method === "POST" && url === "/detokenize") {
      if (!c.tokenize) return json({}, 404);
      return json({ content: `<${(body.tokens ?? [])[0]}>` });
    }
    if (req.method === "GET" && url === "/api/v0/models") return c.lm ? json({ data: c.lm }) : json({}, 404);
    if (req.method === "GET" && url === "/api/ps") return c.ollama ? json({ models: c.ollama.ps }) : json({}, 404);
    if (req.method === "GET" && url === "/api/tags") return c.ollama ? json({ models: c.ollama.tags }) : json({}, 404);
    if (req.method === "POST" && url === "/api/show") return c.ollama?.show ? json(c.ollama.show) : json({}, 404);
    if (req.method !== "POST" || !url.endsWith("/chat/completions")) return json({}, 404);

    f.bodies.push(body);
    if (body.stream === false) {
      if (c.summary === null || c.summary === undefined) return json({ error: "no" }, 500);
      return json({ choices: [{ message: { role: "assistant", content: c.summary } }] });
    }
    const msgs: any[] = body.messages ?? [];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    const text = c.echo === false ? c.text ?? [] : c.text ?? [`R:${lastUser}`, "-end"];
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    let closed = false;
    req.on("close", () => { closed = true; });
    const gap = async (ms: number) => { if (ms) await sleep(ms); };
    for (const r of c.reasoning ?? []) {
      send({ id: "x", choices: [{ index: 0, delta: { [c.reasoningAlias ? "reasoning" : "reasoning_content"]: r } }] });
      await gap(c.delayMs ?? 0);
      if (closed) return;
    }
    if (c.reasoning?.length) await gap(c.reasonGapMs ?? 0);
    for (const p of text) {
      const first = p === text[0];
      send({ id: "x", choices: [{ index: 0, delta: { content: p }, ...(first && c.logprobs ? { logprobs: { content: c.logprobs } } : {}) }] });
      await gap(c.delayMs ?? 0);
      if (closed) return;
    }
    send({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const tail: any = { id: "x", choices: [] };
    if (c.usage) tail.usage = c.usage;
    if (c.timings) tail.timings = c.timings;
    if (c.stats) tail.stats = c.stats;
    if (c.usage || c.timings || c.stats) send(tail);
    res.end("data: [DONE]\n\n");
  }).listen(port, "127.0.0.1");
  return f;
}
