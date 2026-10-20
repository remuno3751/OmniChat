import type { SamplingParams } from "./db.js";
import { sanitizeExtraBody, MAX_GRAMMAR_CHARS } from "./structured.js";

export type { SamplingParams };

const NUM_KEYS = ["temperature", "topP", "topK", "minP", "repeatPenalty", "seed", "maxTokens"] as const;
const BODY_NAMES: Record<string, string> = {
  temperature: "temperature", topP: "top_p", topK: "top_k", minP: "min_p",
  repeatPenalty: "repeat_penalty", seed: "seed", maxTokens: "max_tokens", stop: "stop",
};

/** Validate/normalise user-provided params. Unknown keys are dropped; null/absent = inherit. Returns null if empty. */
export function sanitizeParams(v: unknown): SamplingParams | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of NUM_KEYS) {
    const x = src[k];
    if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
  }
  if (Array.isArray(src.stop)) {
    const stop = src.stop.filter((s): s is string => typeof s === "string" && s !== "").slice(0, 16);
    if (stop.length) out.stop = stop;
  }
  if (typeof src.logprobs === "number" && Number.isInteger(src.logprobs) && src.logprobs >= 0 && src.logprobs <= 20) out.logprobs = src.logprobs;
  if (typeof src.grammar === "string" && src.grammar.trim() && src.grammar.length <= MAX_GRAMMAR_CHARS) out.grammar = src.grammar;
  const extra = sanitizeExtraBody(src.extraBody);
  if (extra) out.extraBody = extra;
  return Object.keys(out).length ? (out as SamplingParams) : null;
}

/** Per key, first non-null layer wins (layers ordered highest priority first). */
export function mergeParams(...layers: Array<SamplingParams | null | undefined>): SamplingParams {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, val] of Object.entries(layer)) {
      if (val === null || val === undefined) continue;
      if (k === "extraBody") {
        // shallow-merged key by key: higher layers win per key
        out.extraBody = { ...(val as object), ...((out.extraBody as object | undefined) ?? {}) };
        continue;
      }
      if (k in out) continue;
      out[k] = val;
    }
  }
  return out as SamplingParams;
}

/** camelCase merged params -> OpenAI-style snake_case body fields. */
export function toBodyParams(p: SamplingParams | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!p) return out;
  for (const [k, val] of Object.entries(p)) {
    if (val === null || val === undefined) continue;
    if (k === "logprobs") { out.logprobs = true; out.top_logprobs = val; continue; }
    if (k === "grammar") { out.grammar = val; continue; }
    const name = BODY_NAMES[k];
    if (name) out[name] = val;
  }
  return out;
}

/** undefined = invalid value; null = explicit "inherit". */
export function sanitizeEffort(v: unknown): "off" | "low" | "medium" | "high" | "max" | null | undefined {
  if (v === null) return null;
  return v === "off" || v === "low" || v === "medium" || v === "high" || v === "max" ? v : undefined;
}
