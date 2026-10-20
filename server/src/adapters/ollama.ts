import type { Adapter, ApiKey, ModelState } from "./index.js";
import { getJson, postJson, ACTION_TIMEOUT, PROBE_TIMEOUT } from "./index.js";

async function readStates(origin: string, apiKey?: ApiKey): Promise<Map<string, ModelState>> {
  const [ps, tags] = await Promise.all([getJson(`${origin}/api/ps`, undefined, apiKey), getJson(`${origin}/api/tags`, undefined, apiKey)]);
  if (!Array.isArray(ps?.models) || !Array.isArray(tags?.models)) throw new Error("not Ollama");
  const out = new Map<string, ModelState>();
  for (const m of tags.models) {
    const id = m?.name ?? m?.model;
    if (typeof id !== "string") continue;
    const st: ModelState = { loaded: false };
    if (typeof m.size === "number") st.sizeBytes = m.size;
    if (typeof m.details?.quantization_level === "string" && m.details.quantization_level) st.quantization = m.details.quantization_level;
    if (typeof m.details?.context_length === "number") st.contextLength = m.details.context_length;
    out.set(id, st);
  }
  for (const m of ps.models) {
    const id = m?.name ?? m?.model;
    if (typeof id !== "string") continue;
    const st: ModelState = out.get(id) ?? {};
    st.loaded = true;
    if (typeof m.size_vram === "number") st.vramBytes = m.size_vram;
    if (typeof m.size === "number" && st.sizeBytes === undefined) st.sizeBytes = m.size;
    if (typeof m.context_length === "number") st.contextLength = m.context_length;
    out.set(id, st);
  }
  return out;
}

export const ollamaAdapter: Adapter = {
  kind: "ollama",
  async probe(origin, apiKey) {
    return { states: await readStates(origin, apiKey), capabilities: { load: true, unload: true, vram: true } };
  },
  states: readStates,
  async contextLimit(origin, model, apiKey) {
    const st = (await readStates(origin, apiKey)).get(model);
    if (st?.loaded && st.contextLength) return st.contextLength; // /api/ps context_length = num_ctx actually in use
    try {
      const info = await postJson(`${origin}/api/show`, { model }, PROBE_TIMEOUT(), apiKey);
      const mi = info?.model_info;
      if (mi && typeof mi === "object") {
        for (const [k, v] of Object.entries(mi)) if (k.endsWith(".context_length") && typeof v === "number") return v;
      }
    } catch { /* fall through */ }
    return st?.contextLength ?? null;
  },
  async load(origin, model, opts, apiKey) { await postJson(`${origin}/api/generate`, { model, keep_alive: -1, ...(opts?.contextLength ? { options: { num_ctx: opts.contextLength } } : {}) }, ACTION_TIMEOUT(), apiKey); },
  async unload(origin, model, apiKey) { await postJson(`${origin}/api/generate`, { model, keep_alive: 0 }, ACTION_TIMEOUT(), apiKey); },
};
