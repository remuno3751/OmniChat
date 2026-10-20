/**
 * Code preview: server-side gate for reading files from the user's PC through the bridge (docs/design/CODE-PREVIEW.md, stage 2).
 * The bridge is the last gate; these checks are a second, earlier one.
 */
import { getConversationRow } from "./db.js";
import { getUsableProviderRow } from "./shared-providers.js";
import { bridgeState } from "./bridges.js";

export const PREVIEW_REASONS = ["not_code", "no_bridge", "bridge_offline", "fs_disabled"] as const;
export type PreviewReason = (typeof PREVIEW_REASONS)[number];

/** Largest file the preview route returns (the bridge reads at most 3 MB). */
export const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Checks a path relative to the bridge's working folder. Returns the normalized path ("" = the folder itself),
 * or null when the path must be refused. Nothing that could leave the folder, name a hidden or dependency file, or
 * use a Windows-only form gets through.
 */
export function safeRelPath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  if (p === "") return "";
  if (p.length > 500) return null;
  // control characters (NUL included), backslashes (Windows separators, UNC), a leading slash (absolute)
  // and a drive letter ("C:...") or any colon (NTFS alternate data streams) are refused outright.
  if (/[\u0000-\u001f\u007f\\:]/.test(p)) return null;
  if (p.startsWith("/")) return null;
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return null;
    if (s.startsWith(".")) return null;
    if (s === "node_modules") return null;
  }
  return segs.join("/");
}

export type ResolvedBridge =
  | { ok: true; bridgeName: string; cwd: string }
  | { ok: false; notFound: true }
  | { ok: false; reason: PreviewReason };

/**
 * Decides which of the user's bridges (and which working folder) a Code conversation previews.
 * Another user's or a missing conversation is "notFound" (404). Otherwise a reason explains why preview is unavailable.
 */
export function resolveConversationBridge(userId: string, conversationId: string): ResolvedBridge {
  const conv = getConversationRow(conversationId);
  if (!conv || conv.user_id !== userId || conv.deleted) return { ok: false, notFound: true };
  if (conv.mode !== "code") return { ok: false, reason: "not_code" };
  const prov = conv.provider_id ? getUsableProviderRow(userId, conv.provider_id) : undefined;
  if (!prov || prov.kind !== "dsh-bridge") return { ok: false, reason: "no_bridge" };
  const bridgeName = String(prov.base_url ?? "").trim();
  if (!bridgeName) return { ok: false, reason: "no_bridge" };
  const st = bridgeState(userId, bridgeName);
  if (!st.online) return { ok: false, reason: "bridge_offline" };
  if (!st.fs) return { ok: false, reason: "fs_disabled" };
  return { ok: true, bridgeName, cwd: st.cwd };
}

/** File extension -> Content-Type for previewed files. Anything else is served as application/octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
};
/** Allow list by media type (parameters such as charset ignored) -> the Content-Type to send. */
const ALLOWED_BY_TYPE = new Map(Object.values(MIME_BY_EXT).map((v) => [v.split(";")[0].trim(), v] as const));

/** Content-Type: from the extension; the bridge's mime is used only when its media type is on the allow list; otherwise octet-stream. */
export function previewContentType(path: string, bridgeMime?: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  const base = (bridgeMime ?? "").split(";")[0].trim().toLowerCase();
  return ALLOWED_BY_TYPE.get(base) ?? "application/octet-stream";
}

/** Per-user token bucket: 20 requests per second (capacity 20, refilled 20 per second). Memory only. */
const RATE_CAPACITY = 20;
const RATE_PER_MS = 20 / 1000;
const buckets = new Map<string, { tokens: number; at: number }>();
export function takePreviewToken(userId: string, now = Date.now()): boolean {
  const b = buckets.get(userId) ?? { tokens: RATE_CAPACITY, at: now };
  b.tokens = Math.min(RATE_CAPACITY, b.tokens + (now - b.at) * RATE_PER_MS);
  b.at = now;
  buckets.set(userId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Base64 decoded size, without decoding. */
export function b64DecodedLength(s: string): number {
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - pad;
}
