/**
 * Model load policy (PROTOCOL-v7-modelload.md). Pure: no react / react-native imports, so node tests can load it.
 */

export type LoadPolicy = 'unload_then_load' | 'use_loaded' | 'load_both';
export type RememberedPolicy = 'ask' | LoadPolicy;
export type Choice = LoadPolicy | 'cancel';
export interface LoadedModelInfo { id: string; sizeBytes?: number; vramBytes?: number }
export interface ModelConflictInfo {
  providerId: string;
  providerName: string;
  kind: string;
  model: string;
  modelSizeBytes?: number;
  loaded: LoadedModelInfo[];
}

export const CHOICE_ORDER: Choice[] = ['unload_then_load', 'use_loaded', 'load_both', 'cancel'];
export const RECOMMENDED: Choice = 'unload_then_load';

const REMEMBERED_VALUES: RememberedPolicy[] = ['ask', 'unload_then_load', 'use_loaded', 'load_both'];
const PROGRESS_PHASES: ProgressPhase[] = ['unloading', 'loading', 'ready'];

/** Anything that is not a known policy (stored garbage, old builds) counts as 'ask'. */
export function normalizeRemembered(v: unknown): RememberedPolicy {
  return (REMEMBERED_VALUES as unknown[]).includes(v) ? (v as RememberedPolicy) : 'ask';
}

/** Cancel is never stored. */
export function isRememberable(c: Choice): boolean {
  return c !== 'cancel';
}

export type Decision = { action: 'ask' } | { action: 'send'; policy: LoadPolicy; useModel?: string };

/**
 * What to do with a model_conflict. hadLoadError (model_load_failed) and a missing conflict always ask;
 * a remembered policy sends with it; use_loaded switches to the first loaded chat model.
 */
export function decideConflict(remembered: RememberedPolicy, conflict: ModelConflictInfo | null, hadLoadError = false): Decision {
  if (hadLoadError || !conflict) return { action: 'ask' };
  if (remembered === 'unload_then_load' || remembered === 'load_both') return { action: 'send', policy: remembered };
  if (remembered === 'use_loaded') {
    const id = conflict.loaded[0]?.id;
    return id ? { action: 'send', policy: 'use_loaded', useModel: id } : { action: 'send', policy: 'use_loaded' };
  }
  return { action: 'ask' };
}

/** '' when unknown or <= 0; otherwise 1024-based: '4.2 GB', '512 MB', '900 KB'. */
export function formatBytes(n: number | undefined | null): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  const KB = 1024;
  const MB = KB * KB;
  const GB = MB * KB;
  const TB = GB * KB;
  if (n >= TB) return `${(n / TB).toFixed(1)} TB`;
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.max(1, Math.round(n / KB))} KB`;
}

/** 'id1 (4.2 GB), id2' */
export function loadedSummary(c: ModelConflictInfo): string {
  return c.loaded
    .map((l) => {
      const size = formatBytes(l.sizeBytes);
      return size ? `${l.id} (${size})` : l.id;
    })
    .join(', ');
}

export type ProgressPhase = 'unloading' | 'loading' | 'ready';
export interface ModelLoadProgress { conversationId: string; phase: ProgressPhase; model: string; unloading?: string[] }

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validates a server `model_load` frame. Returns null for anything else. */
export function parseProgress(frame: any): ModelLoadProgress | null {
  if (!frame || typeof frame !== 'object' || frame.type !== 'model_load') return null;
  if (!isStr(frame.conversationId) || !frame.conversationId) return null;
  if (!(PROGRESS_PHASES as unknown[]).includes(frame.phase)) return null;
  if (!isStr(frame.model) || !frame.model) return null;
  const out: ModelLoadProgress = { conversationId: frame.conversationId, phase: frame.phase, model: frame.model };
  if (Array.isArray(frame.unloading)) out.unloading = frame.unloading.filter(isStr);
  return out;
}

/** Validates `frame.conflict` of an error frame. Any malformed loaded entry rejects the whole conflict. */
export function parseConflict(frame: any): ModelConflictInfo | null {
  const c = frame && typeof frame === 'object' ? frame.conflict : null;
  if (!c || typeof c !== 'object') return null;
  if (!isStr(c.providerId) || !isStr(c.providerName) || !isStr(c.kind) || !isStr(c.model)) return null;
  if (!Array.isArray(c.loaded)) return null;
  const loaded: LoadedModelInfo[] = [];
  for (const l of c.loaded) {
    if (!l || typeof l !== 'object' || !isStr(l.id) || !l.id) return null;
    const info: LoadedModelInfo = { id: l.id };
    if (isNum(l.sizeBytes)) info.sizeBytes = l.sizeBytes;
    if (isNum(l.vramBytes)) info.vramBytes = l.vramBytes;
    loaded.push(info);
  }
  const out: ModelConflictInfo = { providerId: c.providerId, providerName: c.providerName, kind: c.kind, model: c.model, loaded };
  if (isNum(c.modelSizeBytes)) out.modelSizeBytes = c.modelSizeBytes;
  return out;
}
