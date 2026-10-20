import type { Adapter, ApiKey, ModelState } from "./index.js";
import { getJson, postJson, ACTION_TIMEOUT } from "./index.js";

async function readStates(origin: string, apiKey?: ApiKey): Promise<Map<string, ModelState>> {
  const body = await getJson(`${origin}/api/v0/models`, undefined, apiKey);
  const list: any[] = Array.isArray(body?.data) ? body.data : null as any;
  if (!list) throw new Error("not LM Studio");
  const out = new Map<string, ModelState>();
  for (const m of list) {
    if (typeof m?.id !== "string" || m.type === "embeddings") continue;
    const st: ModelState = { loaded: m.state === "loaded" };
    if (typeof m.quantization === "string" && m.quantization) st.quantization = m.quantization;
    if (typeof m.max_context_length === "number") st.contextLength = m.max_context_length;
    if (typeof m.loaded_context_length === "number") st.loadedContextLength = m.loaded_context_length;
    if (typeof m.publisher === "string" && m.publisher) st.publisher = m.publisher;
    if (m.type === "vlm") st.vision = true;
    else if (m.type === "llm") st.vision = false;
    out.set(m.id, st);
  }
  // Best-effort: model sizes from the v1 API (LM Studio 0.4+). Silent on any failure.
  try {
    const v1 = await getJson(`${origin}/api/v1/models`, undefined, apiKey);
    for (const m of Array.isArray(v1?.models) ? v1.models : []) {
      const st = typeof m?.key === "string" ? out.get(m.key) : undefined;
      if (st && typeof m.size_bytes === "number") st.sizeBytes = m.size_bytes;
    }
  } catch { /* older LM Studio or a mock: no sizes */ }
  return out;
}

/** LM Studio 0.4+ exposes POST /api/v1/models/load|unload (verified to exist; unload takes instance_id). Older builds: JIT warm-up only. */
async function hasV1(origin: string, apiKey?: ApiKey): Promise<boolean> {
  try { return Array.isArray((await getJson(`${origin}/api/v1/models`, undefined, apiKey))?.models); } catch { return false; }
}

export const lmstudioAdapter: Adapter = {
  kind: "lmstudio",
  async probe(origin, apiKey) {
    const states = await readStates(origin, apiKey);
    const v1 = await hasV1(origin, apiKey);
    return { states, capabilities: { load: true, unload: v1, vram: false } };
  },
  states: readStates,
  async contextLimit(origin, model, apiKey) {
    const st = (await readStates(origin, apiKey)).get(model);
    if (!st) return null;
    return (st.loaded ? st.loadedContextLength : undefined) ?? st.contextLength ?? null;
  },
  async load(origin, model, opts, apiKey) {
    const ctx = opts?.contextLength;
    if (ctx) {
      // A different context size needs a fresh instance: drop the loaded one first.
      if ((await readStates(origin, apiKey)).get(model)?.loaded) await this.unload(origin, model, apiKey);
      await postJson(`${origin}/api/v1/models/load`, { model, context_length: ctx }, ACTION_TIMEOUT(), apiKey);
      return;
    }
    try {
      await postJson(`${origin}/api/v1/models/load`, { model }, ACTION_TIMEOUT(), apiKey);
      return;
    } catch (e: any) {
      if (!/HTTP (404|405)/.test(String(e?.message))) throw e;
    }
    // JIT warm-up: a minimal 1-token completion makes LM Studio load the model.
    await postJson(`${origin}/v1/chat/completions`, { model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "hi" }] }, ACTION_TIMEOUT(), apiKey);
  },
  async unload(origin, model, apiKey) {
    const body = await getJson(`${origin}/api/v1/models`, undefined, apiKey);
    const entry = (body?.models ?? []).find((m: any) => m?.key === model);
    const ids: string[] = (entry?.loaded_instances ?? []).map((i: any) => i?.id).filter((x: any) => typeof x === "string");
    if (!ids.length) return;
    for (const id of ids) await postJson(`${origin}/api/v1/models/unload`, { instance_id: id }, ACTION_TIMEOUT(), apiKey);
  },
};
