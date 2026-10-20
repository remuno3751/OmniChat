import { lmstudioAdapter } from "./lmstudio.js";
import { ollamaAdapter } from "./ollama.js";
import { llamacppAdapter } from "./llamacpp.js";
import { genericAdapter } from "./generic.js";

export interface ModelState { loaded?: boolean; vramBytes?: number; sizeBytes?: number; quantization?: string; contextLength?: number; loadedContextLength?: number; publisher?: string; /** image input as this backend reports it per model (LM Studio: type vlm) */ vision?: boolean }
export interface Capabilities { load: boolean; unload: boolean; vram: boolean }

/** Optional Bearer key sent with every request to the backend. Never logged, never put into cache keys or error messages. */
export type ApiKey = string | undefined;

export interface Adapter {
  kind: "lmstudio" | "ollama" | "llamacpp" | "generic";
  /** Returns the per-model state and capabilities, or null when this server is not of this kind. Throws on network errors. */
  probe(origin: string, apiKey?: ApiKey): Promise<{ states: Map<string, ModelState>; capabilities: Capabilities } | null>;
  states(origin: string, apiKey?: ApiKey): Promise<Map<string, ModelState>>;
  /** Whether the served model reads images (the server's own report, e.g. llama.cpp /props modalities.vision), or null when it does not say. May throw. */
  vision?(origin: string, apiKey?: ApiKey): Promise<boolean | null>;
  /** opts.contextLength: load with this context window (tokens). Backends that cannot do it ignore it. */
  load(origin: string, model: string, opts?: { contextLength?: number }, apiKey?: ApiKey): Promise<void>;
  unload(origin: string, model: string, apiKey?: ApiKey): Promise<void>;
  /** Context window (tokens) of the model as currently loaded / configured, or null when unknown. May throw. */
  contextLimit?(origin: string, model: string, apiKey?: ApiKey): Promise<number | null>;
  /** Exact token count of a text through the backend tokenizer, or null. May throw. */
  tokenize?(origin: string, text: string, timeoutMs?: number, apiKey?: ApiKey): Promise<number | null>;
}

export const NO_CAPS: Capabilities = { load: false, unload: false, vram: false };
export const PROBE_TIMEOUT = () => Number(process.env.OMNICHAT_ADAPTER_TIMEOUT_MS ?? 1500);
export const ACTION_TIMEOUT = () => Number(process.env.OMNICHAT_MODEL_ACTION_TIMEOUT_MS ?? 120_000);

/** Authorization header for a key, or nothing when there is no key. */
export function authHeaders(apiKey: ApiKey): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export async function getJson(url: string, timeoutMs = PROBE_TIMEOUT(), apiKey?: ApiKey): Promise<any> {
  const res = await fetch(url, { headers: { accept: "application/json", ...authHeaders(apiKey) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function postJson(url: string, body: unknown, timeoutMs = ACTION_TIMEOUT(), apiKey?: ApiKey): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`);
  try { return JSON.parse(text); } catch { return null; }
}

// generic last: the specific kinds (lmstudio / ollama / llamacpp) win when several match.
const ADAPTERS: Adapter[] = [lmstudioAdapter, ollamaAdapter, llamacppAdapter, genericAdapter];
const DETECT_TTL = 60_000;
const DETECT_MISS_TTL = 10_000;
type Detected = { adapter: Adapter | null; capabilities: Capabilities };
const detected = new Map<string, Detected & { at: number }>();

export function originOf(baseUrl: string): string | null {
  try {
    const u = new URL(String(baseUrl).trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

/** Cache key: origin plus whether a key was sent (the key itself is never stored). */
export const authScope = (origin: string, apiKey: ApiKey): string => origin + (apiKey ? "\u0000withKey" : "\u0000noKey");

/** Probes each adapter once per origin (and per key presence) and caches the verdict (60 s; misses 10 s). Never throws. */
export async function detectAdapter(baseUrl: string, force = false, apiKey?: ApiKey): Promise<Detected> {
  const origin = originOf(baseUrl);
  if (!origin) return { adapter: null, capabilities: NO_CAPS };
  const scope = authScope(origin, apiKey);
  const hit = detected.get(scope);
  if (!force && hit && Date.now() - hit.at < (hit.adapter ? DETECT_TTL : DETECT_MISS_TTL)) return hit;
  let out: Detected = { adapter: null, capabilities: NO_CAPS };
  const results = await Promise.all(ADAPTERS.map((a) => a.probe(origin, apiKey || undefined).catch(() => null)));
  const i = results.findIndex((r) => r);
  if (i >= 0) out = { adapter: ADAPTERS[i], capabilities: results[i]!.capabilities };
  detected.set(scope, { at: Date.now(), ...out });
  return out;
}
