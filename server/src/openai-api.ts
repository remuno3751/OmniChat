import type { FastifyInstance, FastifyRequest } from "fastify";
import { decryptSecret } from "./secret.js";
import { db } from "./db.js";
import { userFromApiKey } from "./apikeys.js";
import { modelsForProvider, modelsForUser } from "./models.js";
import { sharedRowsFor, modelDenied, scrubForUser } from "./shared-providers.js";
import { maintenanceBlocking, maintenanceText, maintenanceRetryAfter } from "./maintenance.js";
import { quotaRefusal, recordQuotaUsage } from "./quota.js";
import { prepareModel } from "./model-load.js";
import { getSettings } from "./projects.js";
import { estimateTokens, MSG_OVERHEAD } from "./tokens.js";

class ApiError extends Error {
  constructor(public status: number, message: string, public type = "invalid_request_error", public code?: string) {
    super(message);
  }
}

export const providerSlug = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");

function keyUser(req: FastifyRequest): string {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  const u = userFromApiKey(m?.[1]?.trim());
  if (!u) throw new ApiError(401, "Invalid API key", "authentication_error", "invalid_api_key");
  return u.userId;
}

/** The user's own openai-compatible providers, then the shared ones they may use. A shared provider the user may not use is absent (404, not 403). */
function providers(userId: string): any[] {
  const own = db.prepare("SELECT * FROM providers WHERE user_id = ? AND deleted = 0 AND kind = 'openai-compatible' ORDER BY created_at, seq").all(userId) as any[];
  return [...own, ...sharedRowsFor(userId).filter((r) => r.kind === "openai-compatible")];
}

/** 403 for a model the user may not use on a shared provider (the model exists, so the answer is not a 404). */
function assertModelAllowed(userId: string, row: any, modelId: string): void {
  if (modelDenied(userId, row, modelId)) throw new ApiError(403, `The model '${modelId}' is not allowed for your account`, "forbidden", "model_not_allowed");
  // shared providers: the daily and monthly token limits (docs/PROTOCOL-v7-quotas.md), before anything is sent upstream
  const quota = quotaRefusal(userId, row);
  if (quota) throw new ApiError(429, quota.message, "rate_limit", quota.code);
}

/** Tokens to count for one answer: the upstream usage when it sent one, else an estimate (as the metrics do). */
function tokensOf(usage: any, messages: unknown, outputText: string): number {
  const p = Number(usage?.prompt_tokens);
  const c = Number(usage?.completion_tokens);
  if (Number.isFinite(p) && Number.isFinite(c)) return Math.round(p + c);
  const list = Array.isArray(messages) ? messages : [];
  const prompt = list.reduce((a: number, m: any) => a + estimateTokens(typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "")) + MSG_OVERHEAD, 0);
  return Math.round(prompt + estimateTokens(outputText));
}

async function resolveModel(userId: string, model: string): Promise<{ row: any; modelId: string }> {
  const rows = providers(userId);
  const i = model.indexOf("/");
  if (i > 0) {
    const slug = model.slice(0, i);
    const row = rows.find((r) => providerSlug(r.name) === slug);
    if (row) {
      const modelId = model.slice(i + 1);
      assertModelAllowed(userId, row, modelId);
      return { row, modelId };
    }
  }
  for (const row of rows) {
    const res = await modelsForProvider(row, false, true);
    if (res.models.some((m) => m.id === model)) {
      assertModelAllowed(userId, row, model);
      return { row, modelId: model };
    }
  }
  throw new ApiError(404, `The model '${model}' does not exist`, "invalid_request_error", "model_not_found");
}

const errBody = (message: string, type: string, code?: string) => ({ error: { message, type, ...(code ? { code } : {}) } });

export function registerOpenAi(app: FastifyInstance): void {
  app.register(async (v1) => {
    v1.setErrorHandler((err: any, _req, reply) => {
      const status = err instanceof ApiError ? err.status : err.statusCode ?? 500;
      const type = err instanceof ApiError ? err.type : status === 500 ? "server_error" : "invalid_request_error";
      reply.status(status).send(errBody(err.message ?? "Internal error", type, err.code));
    });
    v1.setNotFoundHandler((_req, reply) => reply.status(404).send(errBody("Unknown endpoint", "invalid_request_error", "not_found")));

    v1.get("/models", async (req) => {
      const userId = keyUser(req);
      const data: any[] = [];
      await Promise.all(providers(userId).map(async (row) => {
        const slug = providerSlug(row.name);
        const res = await modelsForUser(userId, row, false, false);
        for (const m of res.models) data.push({ id: `${slug}/${m.id}`, object: "model", created: Math.floor((row.created_at ?? Date.now()) / 1000), owned_by: slug });
      }));
      data.sort((a, b) => a.id.localeCompare(b.id));
      return { object: "list", data };
    });

    v1.post("/chat/completions", async (req, reply) => {
      const userId = keyUser(req);
      const blocked = maintenanceBlocking(userId);
      if (blocked) {
        const retry = maintenanceRetryAfter(blocked);
        if (retry !== null) reply.header("Retry-After", String(retry));
        return reply.code(503).send({ error: { type: "service_unavailable", code: "maintenance", message: maintenanceText(blocked) } });
      }
      const body = (req.body ?? {}) as Record<string, any>;
      if (typeof body.model !== "string" || !body.model) throw new ApiError(400, "'model' is required");
      if (!Array.isArray(body.messages)) throw new ApiError(400, "'messages' must be an array");
      const { row, modelId } = await resolveModel(userId, body.model);
      const upstreamBody = { ...body, model: modelId };
      const stream = body.stream === true;
      // Agent clients (dsh) send ~9k-token prompts; an LM Studio JIT load would use its small default context. Preload with the user's default (else 32k).
      if (row.user_id === userId && row.kind === "openai-compatible") {
        try {
          await prepareModel({
            prov: row, model: modelId, conversationId: "", messageId: "", policy: "load_both",
            contextLength: getSettings(userId).defaultContextLength ?? 32768, progress: () => {},
          });
        } catch { /* best effort: the upstream request below still runs */ }
      }

      const ac = new AbortController();
      reply.raw.on("close", () => { if (!reply.raw.writableFinished) ac.abort(); });
      const headers: Record<string, string> = { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" };
      if (row.api_key) headers.authorization = `Bearer ${decryptSecret(row.api_key)}`;
      const scrubFor = (t: string) => (row.user_id !== userId ? scrubForUser(t, row) : t);
      let up: Response;
      try {
        up = await fetch(`${String(row.base_url).trim().replace(/\/+$/, "")}/chat/completions`, {
          method: "POST", headers, body: JSON.stringify(upstreamBody), signal: ac.signal,
        });
      } catch (e: any) {
        if (ac.signal.aborted) return reply.hijack();
        throw new ApiError(502, `Upstream request failed: ${scrubFor(String(e?.message ?? e).slice(0, 200))}`, "api_connection_error");
      }

      if (!up.ok) {
        const text = await up.text().catch(() => "");
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        if (parsed?.error && typeof parsed.error === "object") {
          if (row.user_id !== userId) { const m = scrubFor(String(parsed.error.message ?? "")); return reply.status(up.status).send({ error: { ...parsed.error, message: m || `Upstream HTTP ${up.status}` } }); }
          return reply.status(up.status).send(parsed);
        }
        const msg = scrubFor((typeof parsed?.error === "string" ? parsed.error : text).slice(0, 500)) || `Upstream HTTP ${up.status}`;
        return reply.status(up.status).send(errBody(msg, "upstream_error"));
      }

      if (!stream) {
        const text = await up.text();
        try {
          const j = JSON.parse(text);
          recordQuotaUsage(userId, row, tokensOf(j?.usage, body.messages, String(j?.choices?.[0]?.message?.content ?? "")));
        } catch { /* not a JSON answer: nothing to count */ }
        return reply.status(200).type("application/json").send(text);
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        ...reply.getHeaders() as any,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // stream: the usage chunk (when the upstream sends one) and the text, for counting when the stream ends
      let streamUsage: any = null;
      let streamText = "";
      let carry = "";
      const dec = new TextDecoder();
      const scan = (chunk: string) => {
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (!d || d === "[DONE]") continue;
          try {
            const j = JSON.parse(d);
            if (j?.usage) streamUsage = j.usage;
            const delta = j?.choices?.[0]?.delta;
            if (delta) streamText += String(delta.content ?? "") + String(delta.reasoning_content ?? "");
          } catch { /* not a JSON event */ }
        }
      };
      try {
        const reader = up.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          scan(dec.decode(value, { stream: true }));
          if (!raw.write(value)) await new Promise<void>((r) => { raw.once("drain", r); raw.once("close", r); });
        }
      } catch (e: any) {
        if (!ac.signal.aborted) {
          raw.write(`data: ${JSON.stringify(errBody(String(e?.message ?? e).slice(0, 200), "api_connection_error"))}\n\n`);
        }
      }
      try { recordQuotaUsage(userId, row, tokensOf(streamUsage, body.messages, streamText)); } catch (e) { console.error("quota accounting failed", e); }
      raw.end();
    });
  }, { prefix: "/v1" });
}
