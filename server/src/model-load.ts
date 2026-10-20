import { detectAdapter, originOf, type ModelState } from "./adapters/index.js";
import { apiKeyOf, providerState, runModelAction } from "./model-admin.js";
import { isChatModelId } from "./models.js";

/* Protocol v7 (docs/PROTOCOL-v7-modelload.md): before a chat turn can JIT-load a model next to another loaded one, reconcile. */

export type LoadPolicy = "unload_then_load" | "use_loaded" | "load_both";
const POLICIES: readonly string[] = ["unload_then_load", "use_loaded", "load_both"];
export const parsePolicy = (v: unknown): LoadPolicy | undefined =>
  typeof v === "string" && POLICIES.includes(v) ? (v as LoadPolicy) : undefined;

export interface LoadedModel { id: string; sizeBytes?: number; vramBytes?: number }
export interface ModelConflict { providerId: string; providerName: string; kind: string; model: string; modelSizeBytes?: number; loaded: LoadedModel[] }
export interface Inspect { controllable: boolean; kind?: string; loaded: LoadedModel[]; targetLoaded: boolean | null; targetSizeBytes?: number }

const verifyMs = () => Number(process.env.OMNICHAT_MODEL_VERIFY_MS ?? 8_000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const toLoaded = (id: string, s: ModelState): LoadedModel => {
  const out: LoadedModel = { id };
  if (s.sizeBytes !== undefined) out.sizeBytes = s.sizeBytes;
  if (s.vramBytes !== undefined) out.vramBytes = s.vramBytes;
  return out;
};

/** Loaded state of an openai-compatible provider. Never throws. Not controllable -> loaded [] and targetLoaded null. */
export async function inspectProvider(prov: any, model: string | null, refresh = true): Promise<Inspect> {
  const none: Inspect = { controllable: false, loaded: [], targetLoaded: null };
  try {
    const baseUrl = String(prov?.base_url ?? "");
    const ps = await providerState(prov, refresh);
    const det = await detectAdapter(baseUrl, false, apiKeyOf(prov));
    const adapter = det.adapter;
    const controllable = prov?.kind === "openai-compatible" && !!adapter && det.capabilities.load && det.capabilities.unload;
    if (!controllable || !adapter) return none;
    const states = ps?.states ?? new Map<string, ModelState>();
    const loaded = [...states]
      .filter(([id, s]) => s.loaded === true && isChatModelId(id))
      .map(([id, s]) => toLoaded(id, s))
      .sort((a, b) => a.id.localeCompare(b.id));
    const ts = model ? states.get(model) : undefined;
    const out: Inspect = {
      controllable: true,
      kind: adapter.kind,
      loaded,
      targetLoaded: model && ts ? ts.loaded === true : null,
    };
    if (ts?.sizeBytes !== undefined) out.targetSizeBytes = ts.sizeBytes;
    return out;
  } catch {
    return none;
  }
}

/** A conflict only when the target is known and NOT loaded while other chat models are. */
export function conflictOf(prov: any, model: string, insp: Inspect): ModelConflict | null {
  if (!insp.controllable || insp.targetLoaded !== false) return null;
  const others = insp.loaded.filter((l) => l.id !== model);
  if (!others.length) return null;
  const c: ModelConflict = {
    providerId: String(prov?.id ?? ""),
    providerName: String(prov?.name ?? ""),
    kind: insp.kind ?? "",
    model,
    loaded: others,
  };
  if (insp.targetSizeBytes !== undefined) c.modelSizeBytes = insp.targetSizeBytes;
  return c;
}

export interface ProgressFrame {
  type: "model_load";
  conversationId: string;
  messageId: string;
  providerId: string;
  phase: "unloading" | "loading" | "ready";
  model: string;
  unloading?: string[];
}

export type PrepareResult =
  | { ok: true; model: string; switched: boolean }
  | { ok: false; code: "model_conflict" | "model_load_failed"; message: string; conflict: ModelConflict };

// Per-origin promise chain: each caller waits for the previous one to release.
const chains = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  chains.set(key, tail);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** Polls the state (refreshed) until done() holds; checks immediately. */
async function waitFor(prov: any, model: string, done: (i: Inspect) => boolean): Promise<boolean> {
  const deadline = Date.now() + verifyMs();
  for (;;) {
    const i = await inspectProvider(prov, model, true);
    if (done(i)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

export async function prepareModel(a: {
  prov: any; model: string; conversationId: string; messageId: string; policy?: unknown; useModel?: unknown;
  contextLength?: number | null; progress: (f: ProgressFrame) => void;
}): Promise<PrepareResult> {
  const { prov, model, conversationId, messageId, progress } = a;
  const key = originOf(String(prov?.base_url ?? "")) ?? "";
  const loadOpts = a.contextLength ? { contextLength: a.contextLength } : undefined;
  const frame = (phase: ProgressFrame["phase"], extra: { unloading?: string[] } = {}) =>
    progress({ type: "model_load", conversationId, messageId, providerId: String(prov.id), phase, model, ...extra });

  return withLock(key, async (): Promise<PrepareResult> => {
    const insp = await inspectProvider(prov, model, true);
    if (!insp.controllable || insp.targetLoaded !== false) return { ok: true, model, switched: false };

    const conflict = conflictOf(prov, model, insp);
    if (!conflict) {
      // No conflict: LM Studio gets an explicit (best-effort) preload so a concurrent chat sees it loaded.
      if (insp.kind !== "lmstudio") return { ok: true, model, switched: false };
      frame("loading");
      await runModelAction(prov, "load", model, loadOpts);
      const after = await inspectProvider(prov, model, true);
      if (after.targetLoaded === true) frame("ready");
      return { ok: true, model, switched: false };
    }

    const policy = parsePolicy(a.policy);
    if (!policy) return { ok: false, code: "model_conflict", message: "Another model is loaded", conflict };

    if (policy === "use_loaded") {
      const chosen = conflict.loaded.find((l) => l.id === a.useModel) ?? conflict.loaded[0];
      return { ok: true, model: chosen.id, switched: true };
    }

    const fail = async (message: string): Promise<PrepareResult> => {
      const f = await inspectProvider(prov, model, true);
      return { ok: false, code: "model_load_failed", message, conflict: conflictOf(prov, model, f) ?? conflict };
    };

    // Loads the target unless already loaded; verifies it and sends "ready". Returns a failure result or null.
    const loadStep = async (): Promise<PrepareResult | null> => {
      const cur = await inspectProvider(prov, model, true);
      if (cur.targetLoaded !== true) {
        frame("loading");
        const r = await runModelAction(prov, "load", model, loadOpts);
        const verified = await waitFor(prov, model, (i) => i.targetLoaded === true);
        if (!verified) return fail(`Load of ${model} failed: ${r.ok ? "not loaded after load" : r.error}`);
      }
      frame("ready");
      return null;
    };

    if (policy === "load_both") {
      const failed = await loadStep();
      return failed ?? { ok: true, model, switched: false };
    }

    // unload_then_load
    const ids = conflict.loaded.map((l) => l.id);
    frame("unloading", { unloading: ids });
    for (const id of ids) {
      const r = await runModelAction(prov, "unload", id);
      if (!r.ok) return fail(`Unload of ${id} failed: ${r.error}`);
    }
    const gone = await waitFor(prov, model, (i) => !i.loaded.some((l) => ids.includes(l.id)));
    if (!gone) return fail(`Unload of ${ids.join(", ")} failed: still loaded`);
    const failed = await loadStep();
    return failed ?? { ok: true, model, switched: false };
  });
}
