// Server -> Aria REST/WS client helpers. The Aria URL and tokens never leave this module's callers: errors carry a fixed code and message only.
import { readVoiceConfig, voiceSecrets } from "./voice-store.js";

export class VoiceError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}

/** 409 voice_off when mode is off; otherwise the Aria base URL and tokens. */
export function requireVoiceOn(): { baseUrl: string; chatToken: string; adminToken: string } {
  if (readVoiceConfig().mode === "off") throw new VoiceError(409, "voice_off", "Voice call is turned off on this server");
  const s = voiceSecrets();
  if (!s.baseUrl) throw new VoiceError(502, "aria_unreachable", "Voice server is not configured");
  return s;
}

/** A short message from Aria that is safe to show: no URLs, no tokens, at most 200 characters. null when empty. */
export function safeMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/https?:\/\/\S+/gi, "[url]").replace(/(bearer\s+|token=|key=)\S+/gi, "[redacted]").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, 200) : null;
}

export interface AriaCall { method?: string; admin?: boolean; json?: unknown; bytes?: Buffer; query?: Record<string, string>; timeoutMs?: number; binary?: boolean }
/** `bytes` / `contentType` are set only for `binary` calls (the body is then not decoded). */
export interface AriaResult { status: number; json: any; text: string; bytes?: Buffer; contentType?: string }

/** Calls Aria's REST. Network failure / timeout -> 502 aria_unreachable. A non-2xx answer is returned (not thrown); callers map it. */
export async function ariaFetch(path: string, o: AriaCall = {}): Promise<AriaResult> {
  const s = requireVoiceOn();
  const token = o.admin ? s.adminToken : s.chatToken || s.adminToken;
  const q = o.query ? "?" + new URLSearchParams(o.query).toString() : "";
  try {
    const r = await fetch(s.baseUrl + path + q, {
      method: o.method ?? "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(o.json !== undefined ? { "content-type": "application/json" } : o.bytes ? { "content-type": "application/octet-stream" } : {}),
      },
      body: o.json !== undefined ? JSON.stringify(o.json) : o.bytes ? new Uint8Array(o.bytes) : undefined,
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
    if (o.binary) {
      const bytes = Buffer.from(await r.arrayBuffer());
      return { status: r.status, json: null, text: "", bytes, contentType: r.headers.get("content-type") ?? undefined };
    }
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  } catch {
    throw new VoiceError(502, "aria_unreachable", "Could not reach the voice server");
  }
}

/** ariaFetch with the raw body (e.g. audio). Same errors. */
export function ariaFetchBinary(path: string, o: AriaCall = {}): Promise<AriaResult> {
  return ariaFetch(path, { ...o, binary: true });
}

/** Maps a non-2xx Aria answer: 400 / 404 / 413 pass through as aria_rejected (with Aria's `available`), anything else is 502 aria_error. */
export function ariaFailure(r: AriaResult): VoiceError {
  if (r.status === 400 || r.status === 404 || r.status === 413) {
    const msg = safeMessage(r.json?.error) ?? safeMessage(r.json?.message) ?? "The voice server rejected the request";
    return new VoiceError(r.status, "aria_rejected", msg, r.json?.available ? { available: r.json.available } : {});
  }
  return new VoiceError(502, "aria_error", `The voice server answered ${r.status}`);
}

/** Like ariaFetch but a non-2xx answer becomes a VoiceError (see ariaFailure). */
export async function ariaOk(path: string, o: AriaCall = {}): Promise<any> {
  const r = await ariaFetch(path, o);
  if (r.status >= 200 && r.status < 300) return r.json ?? {};
  throw ariaFailure(r);
}

/** ws(s)://host/live/ws?user=&token= from the configured base URL. */
export function ariaLiveUrl(userId: string): string {
  const s = requireVoiceOn();
  const u = new URL(s.baseUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + "/live/ws");
  u.searchParams.set("user", userId);
  if (s.chatToken || s.adminToken) u.searchParams.set("token", s.chatToken || s.adminToken);
  return u.toString();
}
