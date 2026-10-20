import type { FastifyInstance, FastifyReply } from "fastify";
import { forbiddenOutboundUrl } from "./url-guard.js";
import { authFromRequest } from "./auth.js";
import { broadcast } from "./hub.js";
import { getNotifyUrl, getSettings } from "./projects.js";
import { isEphemeralId } from "./ephemeral.js";

export type NotifyKind = "done" | "approval" | "error";

const TITLE_MAX = 200;
const BODY_MAX = 1000;
const TIMEOUT_MS = 5000;

const PRIORITY: Record<NotifyKind, string> = { done: "default", approval: "high", error: "high" };
const TAGS: Record<NotifyKind, string> = { done: "white_check_mark", approval: "lock", error: "warning" };

/** Clips by code points so a surrogate pair is never split. */
const clipChars = (s: string, n: number): string => Array.from(s).slice(0, n).join("");

/** Returns the URL when it parses and uses http: or https:, else null. Never logs the URL. */
function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return forbiddenOutboundUrl(raw) ? null : raw;
  } catch {
    return null;
  }
}

/** Header values must be ASCII-safe: non-ASCII titles become an RFC 2047 UTF-8 base64 encoded word. */
function encodeHeaderTitle(title: string): string {
  const clean = title.replace(/[\r\n\t]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/** POSTs a plain-text message to an ntfy-compatible URL. Never throws; never includes the URL in its result. */
export async function postNtfy(
  url: string,
  title: string,
  body: string,
  priority: string,
  tags: string,
): Promise<{ ok: boolean; status?: number }> {
  const target = safeHttpUrl(url);
  if (!target) return { ok: false };
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { Title: encodeHeaderTitle(title), Priority: priority, Tags: tags },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

/**
 * Notifies the user's devices (WS broadcast) and, when configured, the ntfy URL.
 * Only acts when settings.notify[kind] is enabled. Never throws, never blocks; returns void.
 */
export function notify(userId: string, kind: NotifyKind, conversationId: string, title: string, body: string): void {
  try {
    if (!getSettings(userId).notify[kind]) return;
    // ephemeral chats: generic text only, the ntfy URL receives it too (docs/EPHEMERAL.md)
    if (isEphemeralId(conversationId)) {
      title = "Ephemeral chat";
      body = kind === "done" ? "Ephemeral chat finished" : kind === "approval" ? "Ephemeral chat needs approval" : "Ephemeral chat failed";
    }
    const t = clipChars(title, TITLE_MAX);
    const b = clipChars(body, BODY_MAX);
    try {
      broadcast(userId, { type: "notify", kind, conversationId, title: t, body: b, at: Date.now() });
    } catch {
      console.warn("notify: broadcast failed");
    }
    const url = safeHttpUrl(getNotifyUrl(userId));
    if (!url) return;
    void postNtfy(url, t, b, PRIORITY[kind], TAGS[kind])
      .then((r) => {
        if (!r.ok) console.warn(`notify: ntfy POST failed${r.status !== undefined ? ` (HTTP ${r.status})` : ""}`);
      })
      .catch(() => { console.warn("notify: ntfy POST failed"); });
  } catch {
    console.warn("notify: failed");
  }
}

export function registerNotifyRoutes(app: FastifyInstance): void {
  // Owner-only by construction: the caller tests their own notify settings.
  app.post("/notify/test", async (req, reply: FastifyReply) => {
    const userId = authFromRequest(req).userId;
    const url = safeHttpUrl(getNotifyUrl(userId));
    if (!url) return reply.code(400).send({ error: "notifyUrl is not set" });
    try {
      broadcast(userId, { type: "notify", kind: "done", conversationId: "", title: "OmniChat", body: "Test notification", at: Date.now() });
    } catch {
      console.warn("notify: broadcast failed");
    }
    const r = await postNtfy(url, "OmniChat", "Test notification", "default", "bell");
    if (r.ok) return { ok: true };
    return reply.code(502).send({ error: "request failed" });
  });
}
