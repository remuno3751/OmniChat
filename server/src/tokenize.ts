import { authHeaders, detectAdapter, originOf } from "./adapters/index.js";

/* Token view (PROTOCOL-v3-phase4.md section 2). */

export const MAX_TOKENIZE_CHARS = 20_000;

export interface TokenPiece { id?: number; text: string }
export interface TokenizeResult { tokens: TokenPiece[]; count: number; exact: boolean; source: "llama.cpp" | "estimate"; truncated?: boolean }

const WIDE_CH = /[ᄀ-ᇿ⺀-〿぀-ヿ㄀-ㄯ㄰-㆏㆐-鿿가-힯豈-﫿＀-￯]/;

/**
 * Estimated pseudo-tokens following the estimator of tokens.ts: wide (CJK/kana/hangul) characters ~1.5 chars per token
 * (alternating pieces of 2 and 1 characters), everything else ~4 characters per token (split at word boundaries first).
 * The pieces concatenate back to the input.
 */
export function estimatePieces(text: string): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  let i = 0;
  let flip = false;
  while (i < chars.length) {
    if (WIDE_CH.test(chars[i])) {
      let j = i;
      while (j < chars.length && WIDE_CH.test(chars[j])) j++;
      for (let k = i; k < j;) {
        const n = flip ? 1 : 2;
        out.push(chars.slice(k, Math.min(j, k + n)).join(""));
        k += n;
        flip = !flip;
      }
      i = j;
    } else {
      let j = i;
      while (j < chars.length && !WIDE_CH.test(chars[j])) j++;
      const run = chars.slice(i, j).join("");
      for (const w of run.match(/\s+|[^\s]+/g) ?? []) {
        const cs = Array.from(w);
        if (cs.length <= 4) out.push(w);
        else for (let k = 0; k < cs.length; k += 4) out.push(cs.slice(k, k + 4).join(""));
      }
      i = j;
    }
  }
  return out;
}

const pieceText = (p: unknown): string => {
  if (typeof p === "string") return p;
  if (Array.isArray(p)) { try { return Buffer.from(p as number[]).toString("utf8"); } catch { return ""; } }
  return "";
};

async function llamaTokenize(origin: string, text: string, timeoutMs: number, apiKey?: string): Promise<TokenPiece[] | null> {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...authHeaders(apiKey) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as any;
  };
  const j = await post("/tokenize", { content: text, add_special: false, with_pieces: true });
  const toks = j?.tokens;
  if (!Array.isArray(toks)) return null;
  if (toks.every((t: any) => t && typeof t === "object" && typeof t.id === "number")) {
    return toks.map((t: any) => ({ id: t.id as number, text: pieceText(t.piece ?? t.text) }));
  }
  if (!toks.every((t: any) => typeof t === "number")) return null;
  // older builds: ids only -> detokenize token by token (bounded)
  const ids = toks as number[];
  if (ids.length > 4000) return ids.map((id) => ({ id, text: "" }));
  const out: TokenPiece[] = new Array(ids.length);
  for (let s = 0; s < ids.length; s += 32) {
    await Promise.all(ids.slice(s, s + 32).map(async (id, k) => {
      const d = await post("/detokenize", { tokens: [id] }).catch(() => null);
      out[s + k] = { id, text: typeof d?.content === "string" ? d.content : "" };
    }));
  }
  return out;
}

/** Never throws. `baseUrl` = the provider's base URL when a provider was given. */
export async function tokenizeText(text: string, baseUrl: string | null, timeoutMs = Number(process.env.OMNICHAT_TOKENIZE_TIMEOUT_MS ?? 5000), apiKey?: string): Promise<TokenizeResult> {
  const truncated = text.length > MAX_TOKENIZE_CHARS;
  const t = truncated ? text.slice(0, MAX_TOKENIZE_CHARS) : text;
  if (baseUrl && t) {
    try {
      const origin = originOf(baseUrl);
      if (origin) {
        const { adapter } = await detectAdapter(baseUrl, false, apiKey);
        if (adapter?.kind === "llamacpp") {
          const tokens = await llamaTokenize(origin, t, timeoutMs, apiKey);
          if (tokens) return { tokens, count: tokens.length, exact: true, source: "llama.cpp", ...(truncated ? { truncated } : {}) };
        }
      }
    } catch { /* fall back to the estimate */ }
  }
  const tokens = estimatePieces(t).map((text) => ({ text }));
  return { tokens, count: tokens.length, exact: false, source: "estimate", ...(truncated ? { truncated } : {}) };
}
