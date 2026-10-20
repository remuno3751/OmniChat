import type { Adapter, ApiKey, ModelState } from "./index.js";
import { authHeaders, getJson, NO_CAPS } from "./index.js";

/** GET /props -> n_ctx (new builds: default_generation_settings.n_ctx; old: top-level n_ctx). Throws when this is not llama.cpp. */
async function readProps(origin: string, apiKey?: ApiKey): Promise<{ nCtx: number; alias: string | null }> {
  const p = await getJson(`${origin}/props`, undefined, apiKey);
  const n = p?.default_generation_settings?.n_ctx ?? p?.n_ctx;
  if (typeof n !== "number" || !(n > 0)) throw new Error("not llama.cpp");
  const alias = typeof p.model_alias === "string" && p.model_alias ? p.model_alias
    : typeof p.model_path === "string" && p.model_path ? p.model_path.split(/[\/]/).pop() ?? null : null;
  return { nCtx: n, alias };
}

async function readStates(origin: string, apiKey?: ApiKey): Promise<Map<string, ModelState>> {
  const { nCtx, alias } = await readProps(origin, apiKey);
  const out = new Map<string, ModelState>();
  if (alias) out.set(alias, { loaded: true, contextLength: nCtx });
  return out;
}

/** llama.cpp server: one model per process, so no load/unload; used for the context window (/props) and the exact tokenizer (/tokenize). */
export const llamacppAdapter: Adapter = {
  kind: "llamacpp",
  async probe(origin, apiKey) {
    return { states: await readStates(origin, apiKey), capabilities: NO_CAPS };
  },
  states: readStates,
  // /v1/models of llama.cpp says nothing about images; /props does (modalities.vision is true when a multimodal projector is loaded)
  async vision(origin, apiKey) {
    const p = await getJson(`${origin}/props`, undefined, apiKey);
    const v = p?.modalities?.vision;
    return typeof v === "boolean" ? v : null;
  },
  async load() { throw new Error("unsupported"); },
  async unload() { throw new Error("unsupported"); },
  async contextLimit(origin, _model, apiKey) { return (await readProps(origin, apiKey)).nCtx; },
  async tokenize(origin, text, timeoutMs, apiKey) {
    const res = await fetch(`${origin}/tokenize`, {
      method: "POST", headers: { "content-type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(timeoutMs ?? 1500),
    });
    if (!res.ok) return null;
    const j: any = await res.json().catch(() => null);
    return Array.isArray(j?.tokens) ? j.tokens.length : null;
  },
};
