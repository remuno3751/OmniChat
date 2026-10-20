import fs from "node:fs";
import path from "node:path";

/** "off" = thinking off (no reasoning), below "low". */
export type Effort = "off" | "low" | "medium" | "high" | "max";

/** Names accepted for a provider's effort profile. "standard" = the per-kind map (same as null). */
export const EFFORT_PROFILES = ["standard", "xhigh", "think-toggle", "none"] as const;
export type EffortProfileName = (typeof EFFORT_PROFILES)[number];

export const DEFAULT_EFFORT_MAP = {
  "openai-compatible": {
    off: { reasoning_effort: "none" },
    low: { reasoning_effort: "low" },
    medium: { reasoning_effort: "medium" },
    high: { reasoning_effort: "high" },
    max: { reasoning_effort: "high" },
  },
  "dsh-bridge": { low: "low", medium: "medium", high: "high", max: "max" },
  // per-provider ways of sending effort; a provider row picks one by effort_profile (null = standard)
  profiles: {
    xhigh: {
      off: { chat_template_kwargs: { enable_thinking: false } },
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "xhigh" },
      max: { reasoning_effort: "xhigh" },
    },
    "think-toggle": {
      off: { chat_template_kwargs: { enable_thinking: false } },
      low: { chat_template_kwargs: { enable_thinking: true } },
      medium: { chat_template_kwargs: { enable_thinking: true } },
      high: { chat_template_kwargs: { enable_thinking: true } },
      max: { chat_template_kwargs: { enable_thinking: true } },
    },
    none: {},
  },
  noReasoning: ["embed", "^gemma-?[0-9]-.*it$"],
  reasoning: ["gpt-oss", "qwen3", "deepseek-r1", "r1", "o[134]", "reasoning", "think"],
};

type EffortMap = Record<string, any>;

let cache: { path: string; mtime: number; map: EffortMap; noR: RegExp[]; yesR: RegExp[] } | null = null;

export function effortMapPath(): string {
  if (process.env.EFFORT_MAP) return process.env.EFFORT_MAP;
  const dataDir = process.env.DATA_DIR || "./data";
  return path.join(dataDir, "effort-map.json");
}

function compile(list: unknown): RegExp[] {
  const out: RegExp[] = [];
  if (!Array.isArray(list)) return out;
  for (const s of list) {
    try { out.push(new RegExp(String(s), "i")); } catch { /* ignore bad regex */ }
  }
  return out;
}

export function loadEffortMap(): EffortMap {
  const p = effortMapPath();
  let mtime = -1;
  try { mtime = fs.statSync(p).mtimeMs; } catch { /* missing */ }
  if (mtime < 0) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(DEFAULT_EFFORT_MAP, null, 2));
      mtime = fs.statSync(p).mtimeMs;
    } catch { /* read-only: use defaults */ }
  }
  if (cache && cache.path === p && cache.mtime === mtime) return cache.map;
  let map: EffortMap = DEFAULT_EFFORT_MAP;
  if (mtime >= 0) {
    try { map = JSON.parse(fs.readFileSync(p, "utf8")); } catch { map = DEFAULT_EFFORT_MAP; }
  }
  cache = { path: p, mtime, map, noR: compile(map.noReasoning), yesR: compile(map.reasoning) };
  return map;
}

export function effortSupport(modelId: string): "supported" | "unsupported" | "unknown" {
  loadEffortMap();
  const c = cache!;
  const id = modelId || "";
  if (c.noR.some((r) => r.test(id))) return "unsupported";
  if (c.yesR.some((r) => r.test(id))) return "supported";
  return "unknown";
}

/**
 * Validate a provider's effortProfile from the API / config file.
 * null, undefined and "standard" all mean the per-kind map (stored as null).
 */
export function parseEffortProfile(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === undefined || v === "standard") return { ok: true, value: null };
  if (typeof v === "string" && (EFFORT_PROFILES as readonly string[]).includes(v)) return { ok: true, value: v };
  return { ok: false };
}

/** The profile's own map from the file, falling back to the built-in one when the file lacks it. */
function profileMap(map: EffortMap, name: string): Record<string, unknown> | null {
  const fromFile = map?.profiles?.[name];
  if (fromFile && typeof fromFile === "object") return fromFile;
  const builtin = (DEFAULT_EFFORT_MAP.profiles as Record<string, Record<string, unknown>>)[name];
  return builtin && typeof builtin === "object" ? builtin : null;
}

export function mapEffort(kind: string, effort: Effort, profile?: string | null): Record<string, unknown> | string | null {
  const map = loadEffortMap();
  // a known non-standard profile replaces the kind map; unknown names behave as standard
  if (profile && profile !== "standard" && (EFFORT_PROFILES as readonly string[]).includes(profile)) {
    const pm = profileMap(map, profile);
    const pv = pm ? pm[effort] : undefined;
    if (pv === undefined || pv === null) return null;
    return pv as Record<string, unknown>;
  }
  const k = map[kind];
  if (!k || typeof k !== "object") return null;
  // a map written by an older version has no "off" entry: fall back to the built-in one (other levels: absent = not sent)
  const v = effort === "off" && !("off" in k) ? (DEFAULT_EFFORT_MAP as Record<string, any>)[kind]?.off : k[effort];
  if (v === undefined || v === null) return null;
  return v;
}
