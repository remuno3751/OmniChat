import { authScope, detectAdapter, originOf, type ApiKey, type Capabilities, type ModelState } from "./adapters/index.js";
import { decryptSecret } from "./secret.js";

export type { Capabilities, ModelState };
export interface ProviderState { states: Map<string, ModelState>; capabilities: Capabilities; /** the server's report on image input (single-model servers such as llama.cpp), when it gives one */ vision?: boolean }

/** The decrypted API key of a provider row (api_key is stored encrypted), or undefined when none. Never log it. */
export const apiKeyOf = (row: { api_key?: string | null } | null | undefined): ApiKey => decryptSecret(row?.api_key) || undefined;

const ttl = () => Number(process.env.OMNICHAT_MODELS_TTL_MS ?? 5_000);
const cache = new Map<string, { at: number; value: ProviderState | null }>();

/** Per-model state + capabilities for an openai-compatible provider row, or null (generic backend / unreachable). Never throws. */
export async function providerState(row: { base_url?: string; api_key?: string | null }, refresh = false): Promise<ProviderState | null> {
  try {
    const origin = originOf(String(row.base_url ?? ""));
    if (!origin) return null;
    const apiKey = apiKeyOf(row);
    const scope = authScope(origin, apiKey);
    const hit = cache.get(scope);
    if (!refresh && hit && Date.now() - hit.at < ttl()) return hit.value;
    const { adapter, capabilities } = await detectAdapter(origin, refresh, apiKey);
    let value: ProviderState | null = null;
    if (adapter) {
      try { value = { states: await adapter.states(origin, apiKey), capabilities }; } catch { value = null; }
      if (value && adapter.vision) {
        try { const v = await adapter.vision(origin, apiKey); if (v !== null) value.vision = v; } catch { /* unknown stays unknown */ }
      }
    }
    cache.set(scope, { at: Date.now(), value });
    return value;
  } catch { return null; }
}

export function invalidateState(row: { base_url?: string; api_key?: string | null }): void {
  const origin = originOf(String(row.base_url ?? ""));
  if (!origin) return;
  cache.delete(authScope(origin, apiKeyOf(row)));
  cache.delete(authScope(origin, undefined));
}

export type ActionResult = { ok: true } | { ok: false; status: number; error: string };

/** load/unload a model. Never throws. */
export async function runModelAction(row: { base_url?: string; api_key?: string | null }, action: "load" | "unload", model: string, opts?: { contextLength?: number }): Promise<ActionResult> {
  try {
    const origin = originOf(String(row.base_url ?? ""));
    if (!origin) return { ok: false, status: 501, error: "unsupported" };
    const apiKey = apiKeyOf(row);
    const { adapter, capabilities } = await detectAdapter(origin, false, apiKey);
    if (!adapter || !capabilities[action]) return { ok: false, status: 501, error: "unsupported" };
    try {
      await (action === "load" ? adapter.load(origin, model, opts, apiKey) : adapter.unload(origin, model, apiKey));
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      return { ok: false, status: timedOut ? 504 : 502, error: timedOut ? "timeout" : String(e?.message ?? e).slice(0, 300) };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, status: 500, error: String(e?.message ?? e).slice(0, 300) };
  } finally {
    invalidateState(row);
  }
}
