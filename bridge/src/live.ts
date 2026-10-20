import net from "node:net";
import YAML from "yaml";

/** One llm-pi-ai provider's upstream. Lives in memory only: never logged, never sent anywhere but the model poll. */
export interface Upstream {
  provider: string;
  baseURL: string;
  headers: Record<string, string>;
  api: string;
}

export const NON_CHAT_RE = /embed|embedding|rerank|whisper|tts|moderation/i;
export const looksLikeChatModel = (id: string): boolean => !NON_CHAT_RE.test(id);
export const isOpenAiish = (api: string): boolean => /openai/i.test(api);

/** Reads baseURL/headers/api of each llm-pi-ai provider. The result must stay in memory. */
export function parseUpstreams(yamlText: string): Upstream[] {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const out: Upstream[] = [];
  for (const entry of doc) {
    if (!entry || typeof entry !== "object" || (entry as any).id !== "llm-pi-ai") continue;
    const providers = (entry as any).config?.providers;
    if (!providers || typeof providers !== "object") continue;
    for (const [provider, p] of Object.entries(providers as Record<string, any>)) {
      const baseURL = typeof p?.baseURL === "string" ? p.baseURL.trim() : "";
      if (!baseURL) continue;
      const headers: Record<string, string> = {};
      if (p.headers && typeof p.headers === "object") {
        for (const [k, v] of Object.entries(p.headers as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number") headers[k] = String(v);
        }
      }
      if (typeof p.apiKey === "string" && p.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
        headers.Authorization = `Bearer ${p.apiKey}`;
      }
      out.push({ provider, baseURL, headers, api: typeof p?.api === "string" ? p.api : "" });
    }
  }
  return out;
}

/** True only for loopback (localhost, 127.0.0.0/8, ::1) or RFC1918 (10/8, 172.16/12, 192.168/16) hosts, http(s) only. */
export function isAllowedUpstream(baseURL: string): boolean {
  let u: URL;
  try {
    u = new URL(baseURL);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost") return true;
  if (net.isIPv6(host)) return host === "::1";
  if (!net.isIPv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Removes every secret (baseURL, host, header values) from a text. */
export function redact(text: string, up?: Upstream | null): string {
  let t = String(text);
  if (up) {
    const secrets = new Set<string>([up.baseURL, up.baseURL.replace(/\/+$/, ""), ...Object.values(up.headers)]);
    try {
      const u = new URL(up.baseURL);
      secrets.add(u.host);
      secrets.add(u.hostname);
    } catch { /* ignore */ }
    for (const s of [...secrets].sort((x, y) => y.length - x.length)) {
      if (s.length >= 3) t = t.split(s).join("[redacted]");
    }
  }
  return t
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bhttps?:\/\/\S+/gi, "[url]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .slice(0, 200);
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual" },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PollResult {
  ids: string[] | null;
  /** Redacted error text, when ids is null. */
  error?: string;
}

/**
 * GET {baseURL}/models. Returns ids, or null (+ redacted error) on any problem, including a disallowed host.
 * Redirects are never followed, so headers cannot leak to another host.
 */
export async function fetchUpstreamModels(up: Upstream, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 3000): Promise<PollResult> {
  if (!isAllowedUpstream(up.baseURL)) return { ids: null, error: "upstream host is not loopback/private; not contacted" };
  try {
    const res = await fetchImpl(up.baseURL.replace(/\/+$/, "") + "/models", {
      headers: { accept: "application/json", ...up.headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (!res.ok) return { ids: null, error: `HTTP ${res.status}` };
    const body: any = await res.json();
    const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const ids: string[] = [];
    for (const m of list.slice(0, 2000)) {
      const id = typeof m === "string" ? m : typeof m?.id === "string" ? m.id : "";
      if (id && id.length <= 300 && !ids.includes(id)) ids.push(id);
    }
    return { ids };
  } catch (e) {
    return { ids: null, error: redact((e as Error)?.message ?? String(e), up) };
  }
}
