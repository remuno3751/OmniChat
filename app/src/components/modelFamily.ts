// Pure model-name -> badge family matching. No React Native imports, so it can be unit-tested under node.
import { FAMILY_STYLES, GENERIC_PALETTE } from './modelLogoData';

export interface ResolvedFamily {
  /** Brand key (a FAMILY_STYLES key), 'x:<token>' for a generic family, or '' for an empty name. */
  key: string;
  /** Display name (also the accessibility label). */
  name: string;
  bg: string;
  /** A MARK_PATHS key when real artwork is bundled. */
  mark?: string;
  /** Glyph drawn when there is no mark. Always non-empty; '?' only for an empty name. */
  monogram: string;
}

export const UNKNOWN_FAMILY: ResolvedFamily = { key: '', name: '', bg: '#6B7280', monogram: '?' };

/**
 * Brand rules, first match wins. Tested against the normalised name (see normalizeModelName), so case,
 * the org prefix and the ':tag' suffix are already gone. Separators inside the name are kept, so the
 * boundary-aware patterns (phi, yi, step, ...) do not match inside other words.
 */
const BRAND_RULES: Array<[RegExp, string]> = [
  [/gemma|gemini|google/, 'google'],
  [/llama/, 'meta'],
  [/deepseek/, 'deepseek'],
  [/qwen|qwq/, 'qwen'],
  [/mistral|mixtral|ministral|devstral|magistral|codestral/, 'mistral'],
  [/(^|[^a-z])phi(?![a-z])/, 'microsoft'],
  [/(^|[^a-z])(gpt|o1|o3|o4)(?![a-z])|gpt-?oss/, 'openai'],
  [/claude/, 'anthropic'],
  [/lfm/, 'liquid'],
  [/nemotron/, 'nvidia'],
  [/glm/, 'zhipu'],
  [/kimi/, 'moonshot'],
  [/command/, 'cohere'],
  [/granite/, 'ibm'],
  [/olmo/, 'allenai'],
  [/smollm/, 'huggingface'],
  [/(^|[^a-z])yi(?![a-z])/, 'yi'],
  [/falcon/, 'tii'],
  [/internlm/, 'internlm'],
  [/minicpm/, 'openbmb'],
  [/ernie/, 'baidu'],
  [/hunyuan/, 'tencent'],
  [/(^|[^a-z])step(?![a-z])/, 'stepfun'],
  [/(^|[^a-z])seed(?![a-z])/, 'bytedance'],
];

/** Tokens that describe the build, not the family. Only the first family-like token is used, so these matter mostly as a guard. */
const NOISE = new Set([
  'gguf', 'mlx', 'awq', 'gptq', 'exl2', 'qat', 'it', 'instruct', 'chat', 'base', 'thinking', 'preview',
  'latest', 'long', 'short', 'uncensored', 'abliterated', 'distill', 'moe', 'hf', 'xs', 'xxs', 'xl', 'nl',
]);

/**
 * Lowercased model id without the org/publisher prefix ("Qwen/Qwen3-8B" -> "qwen3-8b") and without a
 * ":tag" suffix ("llama3:latest" -> "llama3").
 */
export function normalizeModelName(model: string): string {
  let m = (model || '').trim().toLowerCase();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) m = m.slice(slash + 1);
  const colon = m.indexOf(':');
  if (colon > 0) m = m.slice(0, colon);
  return m;
}

/** The brand key for a name, or null. */
export function brandFor(text: string): string | null {
  const m = normalizeModelName(text);
  if (!m) return null;
  for (const [re, key] of BRAND_RULES) if (re.test(m)) return key;
  return null;
}

/**
 * The family token of an unknown model, so that variants share one: "bonsai2-4b-long" -> "bonsai",
 * "ornith9b" -> "ornith", "some-model_iq3_xxs" -> "some". Size, quantisation and build tokens are skipped.
 * Returns '' when no token of two or more letters exists.
 */
export function genericFamily(model: string): string {
  const m = normalizeModelName(model);
  for (const tok of m.split(/[^a-z0-9]+/)) {
    if (!tok || /^\d/.test(tok) || NOISE.has(tok)) continue; // 4b, 8bit, 270m, 3, ...
    if (/^(iq|q|int|fp|bf)\d/.test(tok)) continue; // iq3, q4, int8, fp8, bf16
    const base = tok.replace(/\d.*$/, ''); // "bonsai2" -> "bonsai", "ornith9b" -> "ornith"
    if (base.length >= 2 && !NOISE.has(base)) return base;
  }
  return '';
}

/** Deterministic 32-bit FNV-1a hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The badge family for a model. The model's own name wins; the publisher (HF org) is a secondary brand signal;
 * otherwise the model's family token is used, so every variant of one family gets the same badge.
 */
export function resolveFamily(model: string, publisher?: string): ResolvedFamily {
  const norm = normalizeModelName(model);
  if (!norm) return UNKNOWN_FAMILY;

  const brand = brandFor(model) ?? (publisher ? brandFor(publisher) : null);
  if (brand && FAMILY_STYLES[brand]) {
    const st = FAMILY_STYLES[brand];
    return { key: brand, name: st.name, bg: st.bg, mark: st.mark, monogram: st.monogram ?? st.name.charAt(0).toUpperCase() };
  }

  // Fall back to the family token; a name with no letters at all still gets a glyph from its first character.
  const token = genericFamily(model) || norm.replace(/[^a-z0-9]/g, '') || norm;
  return {
    key: 'x:' + token,
    name: capitalize(token),
    bg: GENERIC_PALETTE[hash(token) % GENERIC_PALETTE.length],
    monogram: token.charAt(0).toUpperCase(),
  };
}
