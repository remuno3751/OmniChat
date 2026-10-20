import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { fetchUpstreamModels, isOpenAiish, looksLikeChatModel, parseUpstreams, redact, type FetchLike, type Upstream } from "./live.js";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export const DEFAULT_MODEL_ENTRY_ID = "agent-default-model";

export function defaultDshHome(): string {
  return path.join(os.homedir(), ".dsh");
}

export function cordisPatchPath(dshHome: string, profile: string): string {
  return path.join(dshHome, "profiles", profile, "cordis.patch.yml");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Extracts ONLY provider key, model id and model name from the `llm-pi-ai` entry.
 * Everything else in the file (headers, apiKeys, baseURLs ...) is dropped on the floor.
 */
export function parseModels(yamlText: string): ModelInfo[] {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  const out: ModelInfo[] = [];
  for (const entry of doc) {
    if (!entry || typeof entry !== "object" || (entry as any).id !== "llm-pi-ai") continue;
    const providers = (entry as any).config?.providers;
    if (!providers || typeof providers !== "object") continue;
    for (const [provider, p] of Object.entries(providers as Record<string, any>)) {
      const models = p?.models;
      if (!Array.isArray(models)) continue;
      for (const m of models) {
        const id = str(m?.id);
        if (!id) continue;
        out.push({ provider, id, name: str(m?.name) ?? id });
      }
    }
  }
  return out;
}

/** modelRef (`provider::id`) of the `agent-default-model` entry in an overlay/patch yml, if present. */
export function parseDefaultModel(yamlText: string): string | undefined {
  let doc: unknown;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return undefined;
  }
  if (!Array.isArray(doc)) return undefined;
  for (const entry of doc) {
    if (!entry || typeof entry !== "object" || (entry as any).id !== DEFAULT_MODEL_ENTRY_ID) continue;
    const provider = str((entry as any).config?.provider);
    const model = str((entry as any).config?.model);
    if (model) return provider ? `${provider}::${model}` : model;
  }
  return undefined;
}

export function readModelsFile(file: string): ModelInfo[] {
  try {
    return parseModels(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function readDefaultModel(file: string | null | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return parseDefaultModel(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function splitModelRef(ref: string): { provider: string | null; id: string } {
  const i = ref.indexOf("::");
  if (i < 0) return { provider: null, id: ref };
  return { provider: ref.slice(0, i) || null, id: ref.slice(i + 2) };
}

/** YAML text of the per-run overlay selecting the model. */
export function buildModelOverlay(provider: string | null, modelId: string): string {
  const config: Record<string, string> = {};
  if (provider) config.provider = provider;
  config.model = modelId;
  return YAML.stringify([{ id: DEFAULT_MODEL_ENTRY_ID, name: "@deepseek-ai/dsh-agent-default-model", config }]);
}

export interface ModelOverlay {
  file: string;
  cleanup(): void;
}

/** Writes the overlay to a fresh temp dir. A bare id (no `::`) uses `defaultProvider`. */
export function writeModelOverlay(modelRef: string, defaultProvider?: string | null): ModelOverlay {
  const { provider, id } = splitModelRef(modelRef);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omnichat-model-"));
  const file = path.join(dir, "model-overlay.yml");
  fs.writeFileSync(file, buildModelOverlay(provider ?? defaultProvider ?? null, id), "utf8");
  return {
    file,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Watches the profile patch by mtime and the upstreams' live /models; `check()`/`refreshLive()` return true when the effective list changed. */
export class ModelCatalog {
  models: ModelInfo[] = [];
  defaultModel: string | undefined;
  private declared: ModelInfo[] = [];
  /** In memory only (baseURL + headers). Never logged or serialised. */
  private upstreams: Upstream[] = [];
  /** provider -> ids currently served (absent = unknown/unreachable, use declared). */
  private live = new Map<string, string[]>();
  private mtime = -1;
  private json = "";
  private refreshing = false;

  constructor(private file: string, private overlayFile: string | null, private opts: { fetch?: FetchLike; onError?: (msg: string) => void } = {}) {
    this.defaultModel = readDefaultModel(overlayFile);
    this.reload();
  }

  private compute(): boolean {
    const out: ModelInfo[] = [];
    const providers = new Set<string>([...this.declared.map((m) => m.provider), ...this.upstreams.map((u) => u.provider)]);
    for (const provider of providers) {
      const served = this.live.get(provider);
      const decl = this.declared.filter((m) => m.provider === provider);
      if (!served) {
        out.push(...decl);
        continue;
      }
      const set = new Set(served);
      out.push(...decl.filter((m) => set.has(m.id)));
      const up = this.upstreams.find((u) => u.provider === provider);
      if (up && isOpenAiish(up.api)) {
        const have = new Set(decl.map((m) => m.id));
        for (const id of served) if (!have.has(id) && looksLikeChatModel(id)) out.push({ provider, id, name: id });
      }
    }
    const json = JSON.stringify(out);
    const changed = json !== this.json;
    this.models = out;
    this.json = json;
    return changed;
  }

  private reload(): boolean {
    let text = "";
    try { text = fs.readFileSync(this.file, "utf8"); } catch { /* missing */ }
    let models = parseModels(text);
    this.upstreams = parseUpstreams(text);
    for (const p of [...this.live.keys()]) if (!this.upstreams.some((u) => u.provider === p)) this.live.delete(p);
    if (!models.length && this.defaultModel) {
      const { provider, id } = splitModelRef(this.defaultModel);
      if (provider) models = [{ provider, id, name: id }];
    }
    this.declared = models;
    return this.compute();
  }

  /** True if the model list changed since the last call. */
  check(): boolean {
    let m = 0;
    try { m = fs.statSync(this.file).mtimeMs; } catch { m = 0; }
    if (m === this.mtime) return false;
    this.mtime = m;
    const dm = readDefaultModel(this.overlayFile);
    const dmChanged = dm !== this.defaultModel;
    this.defaultModel = dm;
    return this.reload() || dmChanged;
  }

  /** Polls every upstream's /models once (in parallel). True if the effective list changed. */
  async refreshLive(): Promise<boolean> {
    if (this.refreshing) return false;
    this.refreshing = true;
    try {
      const ups = this.upstreams;
      const results = await Promise.all(ups.map((u) => fetchUpstreamModels(u, this.opts.fetch)));
      if (ups !== this.upstreams) return false; // profile re-read meanwhile
      ups.forEach((u, i) => {
        const r = results[i];
        if (r.ids) this.live.set(u.provider, r.ids);
        else {
          this.live.delete(u.provider);
          this.opts.onError?.(`live model poll failed for provider '${u.provider}': ${redact(r.error ?? "error", u)}`);
        }
      });
      return this.compute();
    } finally {
      this.refreshing = false;
    }
  }

  /** Provider to assume for a bare model id. */
  providerFor(id: string): string | null {
    const hit = this.models.find((x) => x.id === id);
    if (hit) return hit.provider;
    if (this.defaultModel) return splitModelRef(this.defaultModel).provider;
    return this.models[0]?.provider ?? null;
  }
}
