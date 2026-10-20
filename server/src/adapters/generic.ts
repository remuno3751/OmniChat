import type { Adapter, ApiKey, ModelState } from "./index.js";
import { getJson, NO_CAPS } from "./index.js";

/** Context window of one entry of GET /v1/models, from the first known field that holds a positive number. */
function contextOf(m: any): number | null {
  for (const v of [m?.meta?.n_ctx, m?.context_length, m?.context_window, m?.max_context_length, m?.max_model_len]) {
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

/** GET {origin}/v1/models -> id -> { contextLength } (entries without a known window carry no contextLength). Throws when the body is not a model list. */
async function readStates(origin: string, apiKey?: ApiKey): Promise<Map<string, ModelState>> {
  const body = await getJson(`${origin}/v1/models`, undefined, apiKey);
  if (!Array.isArray(body?.data)) throw new Error("not a model list");
  const out = new Map<string, ModelState>();
  for (const m of body.data) {
    if (typeof m?.id !== "string") continue;
    const n = contextOf(m);
    out.set(m.id, n ? { contextLength: n } : {});
  }
  return out;
}

/** Any OpenAI-compatible server that reports a context window per model (e.g. Strata, llama-swap). Read-only: no load/unload. Matches only when at least one model has a window. */
export const genericAdapter: Adapter = {
  kind: "generic",
  async probe(origin, apiKey) {
    const states = await readStates(origin, apiKey);
    if (![...states.values()].some((s) => s.contextLength)) return null;
    return { states, capabilities: NO_CAPS };
  },
  states: readStates,
  async load() { throw new Error("unsupported"); },
  async unload() { throw new Error("unsupported"); },
  async contextLimit(origin, model, apiKey) {
    return (await readStates(origin, apiKey)).get(model)?.contextLength ?? null;
  },
};
