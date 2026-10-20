import { db } from "./db.js";
import type { Metrics } from "./db.js";
import type { ChatMessage, DebugSink } from "./providers/index.js";
import type { ModelState } from "./adapters/index.js";
import { estimateTokens, MSG_OVERHEAD } from "./tokens.js";

/* Speed metrics (PROTOCOL-v3-phase2.md section 3). */

export interface MetricsInput {
  /** performance.now()-style clock, ms */
  startedAt: number;
  firstTokenAt: number | null;
  endedAt: number;
  content: string;
  reasoning: string;
  prompt: ChatMessage[];
  response: DebugSink["response"];
  providerId: string | null;
  providerKind: string | null;
  model: string | null;
  state?: ModelState | null;
  /** context window reported by the backend adapter */
  contextLength?: number | null;
  now?: number;
}
export interface MetricsComputed extends Metrics { usageExact: boolean }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round2 = (x: number) => Math.round(x * 100) / 100;
const rate = (tokens: number, ms: number | null): number | null =>
  ms !== null && ms > 0 && tokens > 0 ? round2((tokens * 1000) / ms) : null;

/** Pure: builds the metrics record of one finished reply, or null when there was nothing to measure. */
export function computeMetrics(i: MetricsInput): MetricsComputed | null {
  const usage = (i.response.usage ?? {}) as any;
  const timings = (i.response.timings ?? {}) as any;
  const stats = (i.response.stats ?? {}) as any;
  const hasOutput = !!(i.content || i.reasoning);
  if (!hasOutput && num(usage.completion_tokens) === null) return null;

  const uPrompt = num(usage.prompt_tokens);
  const uCompl = num(usage.completion_tokens);
  const usageExact = uPrompt !== null && uCompl !== null;
  const promptTokens = Math.round(uPrompt ?? num(timings.prompt_n) ?? i.prompt.reduce((a, m) => a + estimateTokens(m.content) + MSG_OVERHEAD, 0));
  const estContent = estimateTokens(i.content);
  const estReason = estimateTokens(i.reasoning);
  const completionTokens = Math.round(uCompl ?? num(timings.predicted_n) ?? estContent + estReason);
  let reasoningTokens = num(usage.completion_tokens_details?.reasoning_tokens) ?? num(usage.reasoning_tokens);
  if (reasoningTokens === null) {
    reasoningTokens = i.reasoning && estContent + estReason > 0 ? Math.round((completionTokens * estReason) / (estContent + estReason)) : 0;
  }
  reasoningTokens = Math.min(Math.round(reasoningTokens), completionTokens);

  const totalMs = Math.max(0, i.endedAt - i.startedAt);
  let ttftMs: number | null = i.firstTokenAt === null ? null : Math.max(0, i.firstTokenAt - i.startedAt);
  let prefillTps: number | null;
  let decodeTps: number | null;
  let source: Metrics["source"] = "estimated";

  const tPrefill = num(timings.prompt_per_second);
  const tDecode = num(timings.predicted_per_second);
  const sDecode = num(stats.tokens_per_second);
  if (tPrefill !== null || tDecode !== null) {
    // llama.cpp timings
    source = "backend";
    prefillTps = tPrefill ?? rate(num(timings.prompt_n) ?? promptTokens, num(timings.prompt_ms));
    decodeTps = tDecode ?? rate(num(timings.predicted_n) ?? completionTokens, num(timings.predicted_ms));
  } else if (sDecode !== null) {
    // LM Studio stats
    source = "backend";
    const t = num(stats.time_to_first_token);
    if (t !== null) ttftMs = t * 1000;
    decodeTps = sDecode;
    prefillTps = rate(promptTokens, ttftMs);
  } else {
    decodeTps = ttftMs !== null ? rate(completionTokens, totalMs - ttftMs) : null;
    prefillTps = rate(promptTokens, ttftMs);
  }

  const st = i.state;
  return {
    providerId: i.providerId, providerKind: i.providerKind, model: i.model,
    quantization: st?.quantization ?? null,
    contextLength: (st?.loaded ? st.loadedContextLength : undefined) ?? i.contextLength ?? st?.contextLength ?? null,
    promptTokens, completionTokens, reasoningTokens,
    ttftMs: ttftMs === null ? null : Math.round(ttftMs),
    totalMs: Math.round(totalMs),
    prefillTps: prefillTps === null ? null : round2(prefillTps),
    decodeTps: decodeTps === null ? null : round2(decodeTps),
    source, createdAt: i.now ?? Date.now(), usageExact,
  };
}

export function saveMetrics(userId: string, conversationId: string, messageId: string, m: MetricsComputed): void {
  db.prepare(
    "INSERT OR REPLACE INTO metrics (message_id, user_id, conversation_id, provider_id, provider_kind, model, quantization, context_length, " +
    "prompt_tokens, completion_tokens, reasoning_tokens, ttft_ms, total_ms, prefill_tps, decode_tps, source, usage_exact, created_at, json_valid, json_error) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    messageId, userId, conversationId, m.providerId, m.providerKind, m.model, m.quantization, m.contextLength,
    m.promptTokens, m.completionTokens, m.reasoningTokens, m.ttftMs, m.totalMs, m.prefillTps, m.decodeTps, m.source,
    m.usageExact ? 1 : 0, m.createdAt,
    m.jsonValid === undefined || m.jsonValid === null ? null : m.jsonValid ? 1 : 0, m.jsonError ?? null,
  );
}

/* ---------------- stats ---------------- */

interface Avg {
  count: number; avgTtftMs: number | null; avgPrefillTps: number | null; avgDecodeTps: number | null;
  avgCompletionTokens: number | null; estimatedShare: number;
}

const mean = (rows: any[], k: string): number | null => {
  const v = rows.map((r) => r[k]).filter((x) => typeof x === "number" && Number.isFinite(x)) as number[];
  return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null;
};
const averages = (rows: any[]): Avg => ({
  count: rows.length,
  avgTtftMs: mean(rows, "ttft_ms"),
  avgPrefillTps: mean(rows, "prefill_tps"),
  avgDecodeTps: mean(rows, "decode_tps"),
  avgCompletionTokens: mean(rows, "completion_tokens"),
  estimatedShare: rows.length ? round2(rows.filter((r) => r.source === "estimated").length / rows.length) : 0,
});

export function computeStats(userId: string, since: number, recentN: number) {
  const rows = db.prepare("SELECT * FROM metrics WHERE user_id = ? AND created_at >= ? ORDER BY created_at, rowid").all(userId, since) as any[];
  const names = new Map<string, string>();
  for (const p of db.prepare("SELECT id, name FROM providers WHERE user_id = ?").all(userId) as any[]) names.set(p.id, p.name);
  const recentRows = rows.slice(Math.max(0, rows.length - recentN));
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const k = JSON.stringify([r.provider_id, r.model, r.quantization, r.context_length]);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const { count: oc, ...overall } = averages(rows);
  const { count: rc, ...recent } = averages(recentRows);
  return {
    overall: { count: oc, ...overall },
    recent: { n: rc, ...recent },
    byModel: [...groups.values()].map((g) => {
      const f = g[0];
      const a = averages(g);
      return {
        providerId: f.provider_id ?? null, providerName: names.get(f.provider_id) ?? null, model: f.model ?? null,
        quantization: f.quantization ?? null, contextLength: f.context_length ?? null,
        count: a.count, avgTtftMs: a.avgTtftMs, avgPrefillTps: a.avgPrefillTps, avgDecodeTps: a.avgDecodeTps,
        avgCompletionTokens: a.avgCompletionTokens, estimatedShare: a.estimatedShare,
      };
    }).sort((a, b) => b.count - a.count),
    series: rows.slice(-200).map((r) => ({
      t: r.created_at, model: r.model ?? null, decodeTps: r.decode_tps ?? null, prefillTps: r.prefill_tps ?? null, ttftMs: r.ttft_ms ?? null,
    })),
  };
}

const CSV_COLS = [
  "message_id", "conversation_id", "provider_id", "provider_kind", "model", "quantization", "context_length",
  "prompt_tokens", "completion_tokens", "reasoning_tokens", "ttft_ms", "total_ms", "prefill_tps", "decode_tps", "source", "created_at",
] as const;
export const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function metricsCsv(userId: string): string {
  const rows = db.prepare("SELECT * FROM metrics WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as any[];
  const lines = [CSV_COLS.join(",")];
  for (const r of rows) lines.push(CSV_COLS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}
