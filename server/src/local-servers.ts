import { db } from "./db.js";
import { filterChat, parseModels } from "./models.js";

export interface LocalProbe { name: string; baseUrl: string }
export interface LocalServer { name: string; kind: "openai-compatible"; baseUrl: string; models: number; modelIds: string[] }

const DEFAULT_PROBES: LocalProbe[] = [
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "llama.cpp server", baseUrl: "http://localhost:8080/v1" },
  { name: "vLLM", baseUrl: "http://localhost:8000/v1" },
];

/** Probe list; env OMNICHAT_LOCAL_PROBES (JSON [{name,baseUrl}]) overrides it (tests). */
export function probeList(): LocalProbe[] {
  const raw = process.env.OMNICHAT_LOCAL_PROBES;
  if (raw) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.filter((p) => p && typeof p.name === "string" && typeof p.baseUrl === "string");
    } catch { /* fall through */ }
  }
  return DEFAULT_PROBES;
}

/** Comparable form: lowercase, no trailing slash, 127.0.0.1 / ::1 / 0.0.0.0 == localhost. */
export function normalizeBaseUrl(u: string): string {
  const s = String(u).trim();
  try {
    const x = new URL(s);
    let host = x.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "[::1]" || host === "::1" || host === "0.0.0.0") host = "localhost";
    return `${x.protocol}//${host}${x.port ? ":" + x.port : ""}${x.pathname.replace(/\/+$/, "")}`;
  } catch {
    return s.replace(/\/+$/, "").toLowerCase();
  }
}

const TTL = 5_000;
let cache: { at: number; key: string; servers: LocalServer[] } | null = null;

async function probe(p: LocalProbe, timeoutMs: number): Promise<LocalServer | null> {
  try {
    const res = await fetch(p.baseUrl.replace(/\/+$/, "") + "/models", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const models = filterChat(parseModels(await res.json()), false);
    return { name: p.name, kind: "openai-compatible", baseUrl: p.baseUrl.replace(/\/+$/, ""), models: models.length, modelIds: models.slice(0, 50).map((m) => m.id) };
  } catch {
    return null;
  }
}

export async function probeAll(): Promise<LocalServer[]> {
  const probes = probeList();
  const key = JSON.stringify(probes);
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.servers;
  const timeoutMs = Number(process.env.OMNICHAT_PROBE_TIMEOUT_MS ?? 800);
  const servers = (await Promise.all(probes.map((p) => probe(p, timeoutMs)))).filter((s): s is LocalServer => !!s);
  cache = { at: Date.now(), key, servers };
  return servers;
}

/** Local servers answering right now, minus those the user already has as a non-deleted provider. */
export async function localServers(userId: string): Promise<{ servers: LocalServer[] }> {
  const rows = db.prepare("SELECT base_url FROM providers WHERE user_id = ? AND deleted = 0").all(userId) as any[];
  const have = new Set(rows.map((r) => normalizeBaseUrl(r.base_url)));
  return { servers: (await probeAll()).filter((s) => !have.has(normalizeBaseUrl(s.baseUrl))) };
}
