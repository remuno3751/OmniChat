import { detectAdapter, originOf } from "./adapters/index.js";

/** Per-message overhead (role markers etc.) added to every counted message. */
export const MSG_OVERHEAD = 4;

// CJK ideographs + extensions A, compatibility, kana, hangul, fullwidth forms.
const WIDE = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u3190-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

/** CJK-aware estimate: wide chars ~ chars/1.5 tokens, everything else ~ chars/4. Excludes message overhead. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const wide = (text.match(WIDE) ?? []).length;
  const other = text.length - wide;
  return Math.ceil(wide / 1.5 + other / 4);
}
export const estimateMessageTokens = (content: string): number => estimateTokens(content) + MSG_OVERHEAD;

const cache = new Map<string, number>();
/**
 * Exact count through the backend tokenizer (llama.cpp POST {origin}/tokenize) when the provider has one; null otherwise.
 * Never throws. Results are cached by (origin, text).
 */
export async function backendCount(baseUrl: string, text: string, timeoutMs = 1500, apiKey?: string): Promise<number | null> {
  try {
    const origin = originOf(baseUrl);
    if (!origin) return null;
    const { adapter } = await detectAdapter(baseUrl, false, apiKey);
    if (!adapter?.tokenize) return null;
    const key = origin + "\u0000" + text;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const n = await adapter.tokenize(origin, text, timeoutMs, apiKey);
    if (n === null) return null;
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, n);
    return n;
  } catch { return null; }
}
