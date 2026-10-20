import type { FastifyInstance, FastifyReply } from "fastify";
import { authFromRequest } from "./auth.js";
import { requestFs, type FsResult } from "./bridges.js";
import {
  PREVIEW_MAX_BYTES,
  b64DecodedLength,
  previewContentType,
  resolveConversationBridge,
  safeRelPath,
  takePreviewToken,
  type ResolvedBridge,
} from "./code-preview.js";

type Query = Record<string, string | undefined>;

const REASON_TEXT: Record<string, string> = {
  not_code: "This conversation is not a Code conversation.",
  no_bridge: "This conversation is not connected to a bridge.",
  bridge_offline: "The bridge on your PC is offline.",
  fs_disabled: "File preview is turned off on this bridge.",
};

/** Maps a resolution failure to the reply body (404 or 409). Returns true when a reply was sent. */
function refuseUnresolved(reply: FastifyReply, r: ResolvedBridge): boolean {
  if (r.ok) return false;
  if ("notFound" in r) {
    reply.code(404).send({ error: "Conversation not found" });
    return true;
  }
  reply.code(409).send({ error: REASON_TEXT[r.reason] ?? "Preview is unavailable.", code: "preview_unavailable", reason: r.reason });
  return true;
}

/** Maps a failed bridge request to an HTTP reply. */
function sendFsFailure(reply: FastifyReply, res: FsResult): void {
  const error = res.error ?? "bridge failed";
  switch (res.code) {
    case "bridge_offline":
      reply.code(409).send({ error, code: "preview_unavailable", reason: "bridge_offline" });
      return;
    case "preview_unavailable":
      reply.code(409).send({ error, code: "preview_unavailable", reason: "fs_disabled" });
      return;
    case "timeout":
      reply.code(504).send({ error, code: "timeout" });
      return;
    case "too_large":
      reply.code(413).send({ error, code: "too_large" });
      return;
    default:
      reply.code(502).send({ error, code: "bridge_error" });
  }
}

/** Shared entry: authenticates, applies the per-user rate limit and resolves the conversation. Sends the reply itself on failure. */
function gate(req: { headers: Record<string, any>; query: unknown }, reply: FastifyReply): { userId: string; bridgeName: string; cwd: string } | null {
  const userId = authFromRequest(req).userId;
  if (!takePreviewToken(userId)) {
    reply.code(429).header("Retry-After", "1").send({ error: "Too many preview requests", code: "rate_limited" });
    return null;
  }
  const r = resolveConversationBridge(userId, String((req.query as Query).conversationId ?? ""));
  if (!r.ok) {
    refuseUnresolved(reply, r);
    return null;
  }
  return { userId, bridgeName: r.bridgeName, cwd: r.cwd };
}

/** Hidden or dependency entries never leave the server, even if the bridge lists them (second gate). */
const visibleName = (name: string): boolean => !name.startsWith(".") && name !== "node_modules" && !name.includes("/") && !name.includes("\\");

export function registerCodePreviewRoutes(app: FastifyInstance): void {
  // Is preview usable for this conversation right now? Cheap; for the UI's button state.
  app.get("/code/preview/status", async (req, reply) => {
    const userId = authFromRequest(req).userId;
    const conversationId = String((req.query as Query).conversationId ?? "");
    const r = resolveConversationBridge(userId, conversationId);
    if (r.ok) return { available: true };
    if ("notFound" in r) return reply.code(404).send({ error: "Conversation not found" });
    return { available: false, reason: r.reason };
  });

  // A directory listing under the bridge's working folder. Omitted path = the folder itself.
  app.get("/code/preview/tree", async (req, reply) => {
    const g = gate(req, reply);
    if (!g) return reply;
    const path = safeRelPath((req.query as Query).path ?? "");
    if (path === null) return reply.code(400).send({ error: "Invalid path", code: "bad_path" });
    const res = await requestFs(g.userId, g.bridgeName, { cwd: g.cwd, op: "list", path });
    if (!res.ok) { sendFsFailure(reply, res); return reply; }
    const entries = (res.entries ?? []).filter((e) => visibleName(e.name)).map((e) => ({ name: e.name, kind: e.kind, size: e.size }));
    return { entries };
  });

  // The bytes of one file. The client reads them with fetch(); the response is sandboxed and never cached.
  app.get("/code/preview/file", async (req, reply) => {
    const g = gate(req, reply);
    if (!g) return reply;
    const q = req.query as Query;
    const path = safeRelPath(q.path ?? "");
    if (path === null || path === "") return reply.code(400).send({ error: "Invalid path", code: "bad_path" });
    let maxBytes = PREVIEW_MAX_BYTES;
    if (q.maxBytes !== undefined) {
      const n = Number(q.maxBytes);
      if (!Number.isInteger(n) || n <= 0) return reply.code(400).send({ error: "Invalid maxBytes", code: "bad_max_bytes" });
      maxBytes = Math.min(n, PREVIEW_MAX_BYTES);
    }
    const res = await requestFs(g.userId, g.bridgeName, { cwd: g.cwd, op: "read", path, maxBytes });
    if (!res.ok || typeof res.content !== "string") {
      if (!res.ok) { sendFsFailure(reply, res); return reply; }
      return reply.code(502).send({ error: "bridge returned no content", code: "bridge_error" });
    }
    if (b64DecodedLength(res.content) > PREVIEW_MAX_BYTES) return reply.code(413).send({ error: "file too large for preview", code: "too_large" });
    const body = Buffer.from(res.content, "base64");
    reply
      .header("Content-Type", previewContentType(path, res.mime))
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox")
      .header("Cache-Control", "no-store");
    if (res.truncated) reply.header("X-Truncated", "1");
    return reply.send(body);
  });
}
