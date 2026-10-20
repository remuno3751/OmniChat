import { getUsableProviderRow } from "./shared-providers.js";
import { db } from "./db.js";
import { decryptSecret } from "./secret.js";
import type { ChatMessage } from "./providers/index.js";
import { buildContext } from "./prompts.js";
import type { BuiltContext, HistoryItem } from "./prompts.js";
import { getSettings } from "./projects.js";
import type { Settings } from "./projects.js";
import { lastMessageId } from "./branching.js";
import { loadDebug } from "./debuglog.js";
import { authScope, detectAdapter, originOf } from "./adapters/index.js";
import { apiKeyOf } from "./model-admin.js";
import { recordQuotaUsage } from "./quota.js";
import { backendCount, estimateTokens, MSG_OVERHEAD } from "./tokens.js";
import { buildWire, resolveVision, storedAttachments, IMAGE_TOKENS, type WireItem } from "./attachments-chat.js";
import type { AttachmentRecord } from "./attachments.js";

/* Context window accounting (PROTOCOL-v3-phase2.md section 2): usage numbers, limit discovery and overflow policy. */

export interface ContextUsage {
  limit: number | null;
  limitSource: "backend" | "override" | "default" | "unknown";
  total: number;
  used: { system: number; history: number; attachments: number; tools: number; input: number };
  reasoning: number;
  lastReasoning: number;
  estimated: boolean;
  reserve: number;
  fits: boolean;
  headId: string | null;
  /** /compact: tokens of the persisted summary. Already part of used.system (the summary is in the system string). */
  summaryTokens?: number;
}

export interface ContextAction {
  /** "compress": the context reached contextCompressAt, so older turns were summarized (phase 5). */
  mode: "truncate" | "summarize" | "stop" | "compress";
  droppedMessages: number;
  droppedIds: string[];
  summarized: boolean;
  /** summarize was requested but the extra call failed (or is unsupported for this provider) -> plain truncate. */
  fellBack?: boolean;
  limit: number;
  reserve: number;
  totalBefore: number;
  totalAfter: number;
  /** Even system + newest user message do not fit; sent anyway. */
  unfit?: boolean;
}

const DEFAULT_RESERVE = 1024;
/** Tokens set aside for the summary note when summarizing (the note is asked to be <= 200 words). */
const NOTE_BUDGET = 450;
const LIMIT_TIMEOUT = 2500;

/* ---------------- limit discovery ---------------- */

const limitCache = new Map<string, { at: number; value: number | null }>();
const limitTtl = () => Number(process.env.OMNICHAT_CONTEXT_TTL_MS ?? 3000);

/** Context window the BACKEND reports for this model (adapters), or null. Never throws; bounded by a short timeout. */
export async function backendLimit(prov: { base_url?: string; kind?: string; api_key?: string | null } | undefined, model: string): Promise<number | null> {
  if (!prov || prov.kind !== "openai-compatible") return null;
  const origin = originOf(String(prov.base_url ?? ""));
  if (!origin) return null;
  const apiKey = apiKeyOf(prov);
  const key = authScope(origin, apiKey) + "\u0000" + model;
  const hit = limitCache.get(key);
  if (hit && Date.now() - hit.at < limitTtl()) return hit.value;
  let value: number | null = null;
  try {
    value = await Promise.race([
      (async () => {
        const { adapter } = await detectAdapter(origin, false, apiKey);
        const v = adapter?.contextLimit ? await adapter.contextLimit(origin, model, apiKey) : null;
        return typeof v === "number" && v > 0 ? v : null;
      })(),
      new Promise<null>((r) => setTimeout(() => r(null), LIMIT_TIMEOUT).unref()),
    ]);
  } catch { value = null; }
  limitCache.set(key, { at: Date.now(), value });
  return value;
}

export async function discoverLimit(
  settings: Settings, prov: { id?: string; base_url?: string; kind?: string } | undefined, model: string,
): Promise<{ limit: number | null; source: ContextUsage["limitSource"]; backend: number | null }> {
  const backend = await backendLimit(prov, model);
  const ov = prov?.id ? settings.contextLimits?.[`${prov.id}::${model}`] : undefined;
  if (typeof ov === "number" && ov > 0) return { limit: ov, source: "override", backend };
  if (backend) return { limit: backend, source: "backend", backend };
  // Phase 5: the backend reports nothing, so assume the user's default context length.
  if (settings.defaultContextLength) return { limit: settings.defaultContextLength, source: "default", backend: null };
  return { limit: null, source: "unknown", backend: null };
}

/* ---------------- measurement ---------------- */

export interface Measured {
  usage: ContextUsage;
  built: BuiltContext;
  sysTok: number;
  /** tokens per history item (aligned with built.history) */
  hist: number[];
  prov: any;
  model: string;
  backendLimit: number | null;
  /** history items (by message id, "pending" included) whose body carries attachments: the text form and the image parts to send */
  wire: Map<string, WireItem>;
}

const scaleTo = (weights: number[], target: number): number[] => {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  return weights.map((w) => (w * target) / sum);
};
const sumOf = (a: number[]) => a.reduce((x, y) => x + y, 0);

interface Calibration { idx: number; promptTokens: number; aTok: number }

/** Latest completed assistant message on the path whose request is byte-identical to what would be re-sent now and whose usage was exact. */
function findCalibration(built: BuiltContext, wire: Map<string, WireItem>): Calibration | null {
  let tried = 0;
  for (let i = built.history.length - 1; i >= 0 && tried < 3; i--) {
    const h = built.history[i];
    if (h.role !== "assistant") continue;
    tried++;
    const m = db.prepare("SELECT * FROM metrics WHERE message_id = ?").get(h.id) as any;
    if (!m || !m.usage_exact || !(m.prompt_tokens > 0)) continue;
    const dbg = loadDebug(h.id);
    if (!dbg) continue;
    const expected: ChatMessage[] = [
      ...(built.system ? [{ role: "system" as const, content: built.system }] : []),
      ...built.history.slice(0, i).map((x) => ({ role: x.role, content: wire.get(x.id)?.content ?? x.content })),
    ];
    const sent = dbg.final.messages;
    if (sent.length !== expected.length || sent.some((s, k) => s.role !== expected[k].role || s.content !== expected[k].content)) continue;
    const aTok = Math.max(0, (m.completion_tokens ?? 0) - (m.reasoning_tokens ?? 0)) + MSG_OVERHEAD;
    return { idx: i, promptTokens: m.prompt_tokens, aTok };
  }
  return null;
}

async function pieceTokens(baseUrl: string | null, text: string, perMsg: number, apiKey?: string): Promise<number | null> {
  if (!baseUrl) return null;
  const n = await backendCount(baseUrl, text, undefined, apiKey);
  return n === null ? null : n + perMsg;
}

export interface MeasureOpts {
  userId: string;
  conv: any;
  leafId?: string | null;
  draft?: string;
  /** A user message not stored yet (stop-mode pre-check of a send). */
  pendingUser?: string;
  /** attachments of the pending user message (already validated) */
  pendingAttachments?: AttachmentRecord[];
  providerId?: string | null;
  model?: string | null;
  oneShot?: { params?: unknown; effort?: unknown };
}

export async function measureContext(o: MeasureOpts): Promise<Measured> {
  const { userId, conv } = o;
  const settings = getSettings(userId);
  let prov: any;
  if (o.providerId) {
    const p = getUsableProviderRow(userId, o.providerId);
    if (p && !p.deleted) prov = p;
  }
  if (!prov) prov = resolveProviderFor(userId, conv);
  const model: string = o.model || conv.model || prov?.model || "";
  const leafId = o.leafId !== undefined ? o.leafId : conv.head_id ?? lastMessageId(conv.id);
  const built = buildContext({ userId, conv, leafId, model, providerKind: prov?.kind ?? "openai-compatible", providerId: prov?.id ?? null, oneShot: o.oneShot });
  if (o.pendingUser) {
    built.history.push({ id: "pending", role: "user", content: o.pendingUser });
    built.messages.push({ role: "user", content: o.pendingUser });
  }
  // attachments: text notes and image parts of the user messages that carry some (strings stay strings)
  const wire = await buildWire(
    built.history,
    (id) => (id === "pending" ? o.pendingAttachments ?? [] : storedAttachments(id)),
    () => resolveVision(userId, prov, model),
    prov?.kind ?? "openai-compatible",
  );
  if (wire.size) {
    const offset = built.messages.length - built.history.length;
    built.history.forEach((h, i) => {
      const w = wire.get(h.id);
      if (w) built.messages[offset + i] = { role: h.role, content: w.content, ...(w.parts ? { parts: w.parts } : {}) };
    });
  }
  const baseUrl: string | null = prov?.kind === "openai-compatible" ? String(prov.base_url ?? "") : null;
  const apiKey = baseUrl ? apiKeyOf(prov) : undefined;
  const lim = await discoverLimit(settings, prov, model);

  const histEst = built.history.map((h) => {
    const w = wire.get(h.id);
    return w ? estimateTokens(w.text) + MSG_OVERHEAD + IMAGE_TOKENS * w.images : estimateTokens(h.content) + MSG_OVERHEAD;
  });
  let estimated = false;

  // system
  let sysTok = 0;
  if (built.system) {
    const t = await pieceTokens(baseUrl, built.system, MSG_OVERHEAD, apiKey);
    if (t === null) { sysTok = estimateTokens(built.system) + MSG_OVERHEAD; estimated = true; } else sysTok = t;
  }

  // history
  let hist: number[];
  const cal = built.history.length ? findCalibration(built, wire) : null;
  if (cal) {
    const prefixTok = Math.max(0, cal.promptTokens - sysTok);
    const prefix = scaleTo(histEst.slice(0, cal.idx), prefixTok);
    const later = histEst.slice(cal.idx + 1);
    hist = [...prefix, cal.aTok, ...later];
    if (later.length) estimated = true;
  } else if (built.history.length) {
    const joined = built.history.map((h) => wire.get(h.id)?.text ?? h.content).join("\n");
    const t = await pieceTokens(baseUrl, joined, MSG_OVERHEAD * built.history.length, apiKey);
    if (t === null) { hist = histEst; estimated = true; } else hist = scaleTo(histEst, t);
  } else hist = [];

  // input (draft)
  let inputTok = 0;
  if (o.draft) {
    const t = await pieceTokens(baseUrl, o.draft, MSG_OVERHEAD, apiKey);
    if (t === null) { inputTok = estimateTokens(o.draft) + MSG_OVERHEAD; estimated = true; } else inputTok = t;
  }

  let attTok = 0;
  for (const w of wire.values()) attTok += w.attachmentTokens;
  attTok = Math.round(attTok);
  // used.attachments is carved out of the history figure, so total is not counted twice
  const used = { system: Math.round(sysTok), history: Math.max(0, Math.round(sumOf(hist)) - attTok), attachments: attTok, tools: 0, input: Math.round(inputTok) };
  const total = used.system + used.history + used.attachments + used.input;
  const maxTokens = mergedMaxTokens(built);
  const reserve = maxTokens ?? DEFAULT_RESERVE;

  // last reply's thinking tokens (display only)
  let lastReasoning = 0;
  for (let i = built.history.length - 1; i >= 0; i--) {
    if (built.history[i].role !== "assistant") continue;
    const id = built.history[i].id;
    const m = db.prepare("SELECT reasoning_tokens FROM metrics WHERE message_id = ?").get(id) as any;
    if (m?.reasoning_tokens > 0) lastReasoning = m.reasoning_tokens;
    else {
      const r = db.prepare("SELECT reasoning FROM messages WHERE id = ?").get(id) as any;
      if (r?.reasoning) lastReasoning = estimateTokens(r.reasoning);
    }
    break;
  }

  const usage: ContextUsage = {
    limit: lim.limit, limitSource: lim.source, total, used, reasoning: 0, lastReasoning, estimated, reserve,
    fits: lim.limit === null ? true : total + reserve <= lim.limit,
    headId: leafId ?? null,
    ...(built.compactedTokens ? { summaryTokens: built.compactedTokens } : {}),
  };
  return { usage, built, sysTok, hist, prov, model, backendLimit: lim.backend, wire };
}

const mergedMaxTokens = (built: BuiltContext): number | null => {
  const v = built.params.maxTokens;
  return typeof v === "number" && v > 0 ? v : null;
};

/** Same selection as chat.ts used before: the conversation's provider, or the user's first one when none is set. */
function resolveProviderFor(userId: string, conv: any): any | undefined {
  // own providers and shared ones this user may use (see shared-providers.ts)
  let prov = conv.provider_id ? getUsableProviderRow(userId, conv.provider_id) : undefined;
  if (!prov && !conv.provider_id) {
    prov = db.prepare("SELECT * FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY created_at, seq LIMIT 1").get(userId);
  }
  return prov;
}

/* ---------------- overflow policy ---------------- */

export interface Enforced {
  messages: ChatMessage[];
  action: ContextAction | null;
  /** stop mode and the context does not fit */
  overflow: boolean;
  usage: ContextUsage;
}

const summaryCache = new Map<string, string>();

export interface SummarizeOpts {
  /** Extra focus from the user (/compact), appended to the system prompt (trimmed, <= 2000 chars). */
  instructions?: string;
  /** An earlier summary to fold in: sent as a "Previous summary:" block before the transcript. */
  previous?: string;
  /** Word budget of the summary (default 200). */
  maxWords?: number;
  signal?: AbortSignal;
  /** the user the summary is for: its tokens count against the shared-provider quota (docs/PROTOCOL-v7-quotas.md) */
  userId?: string;
}

/**
 * One non-streamed summary of `items` on an openai-compatible provider. Null when the provider cannot summarize,
 * the call fails or the reply is empty. Used by automatic compression (no opts) and by /compact (compact.ts).
 */
export async function summarizeItems(
  prov: any, model: string, items: HistoryItem[], limit: number, opts: SummarizeOpts = {},
): Promise<string | null> {
  if (prov?.kind !== "openai-compatible") return null;
  let transcript = items
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.length > 4000 ? m.content.slice(0, 4000) + "..." : m.content}`)
    .join("\n\n");
  const maxChars = Math.max(2000, (limit - 1500) * 3);
  if (transcript.length > maxChars) transcript = transcript.slice(transcript.length - maxChars);
  const previous = opts.previous?.trim();
  if (previous) transcript = `Previous summary:\n${previous}\n\n${transcript}`;
  const words = opts.maxWords ?? 200;
  let system = `Summarize this conversation so far in <=${words} words. Keep names, facts, decisions and open questions. Output only the summary.`;
  const focus = opts.instructions?.trim().slice(0, 2000);
  if (focus) system += `\n\nAdditional focus from the user: ${focus}`;
  const url = `${String(prov.base_url).replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (prov.api_key) headers.Authorization = `Bearer ${decryptSecret(prov.api_key)}`;
  try {
    const sigs = [AbortSignal.timeout(Number(process.env.OMNICHAT_SUMMARY_TIMEOUT_MS ?? 90_000))];
    if (opts.signal) sigs.push(opts.signal);
    const res = await fetch(url, {
      method: "POST", headers, signal: AbortSignal.any(sigs),
      body: JSON.stringify({
        model, stream: false, temperature: 0.2, max_tokens: 1500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript },
        ],
      }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    if (opts.userId) {
      const p = Number(j?.usage?.prompt_tokens), c = Number(j?.usage?.completion_tokens);
      recordQuotaUsage(opts.userId, prov, Number.isFinite(p) && Number.isFinite(c) ? p + c : estimateTokens(system) + estimateTokens(transcript) + estimateTokens(typeof text === "string" ? text : ""));
    }
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch { return null; }
}

/**
 * Applies the user's overflow policy to an already measured context.
 * truncate/summarize: drop whole user+assistant pairs from the start of the path (system message and the newest
 * user message are never dropped). stop: reports `overflow` and leaves the messages untouched.
 */
export async function enforceContext(m: Measured, settings: Settings, signal?: AbortSignal, userId?: string): Promise<Enforced> {
  const { usage, built } = m;
  const untouched: Enforced = { messages: built.messages, action: null, overflow: false, usage };
  const limit = usage.limit;
  if (limit === null) return untouched;
  const overflow = usage.total + usage.reserve > limit;
  // Phase 5: automatic compression starts at contextCompressAt% of the limit (null = off).
  const compress = settings.contextCompressAt !== null && usage.total >= (limit * settings.contextCompressAt) / 100;
  if (!overflow && !compress) return untouched;
  const mode = settings.contextOverflow;
  if (mode === "stop") return overflow ? { ...untouched, overflow: true } : untouched;

  // Tokens the kept history may take: what fits next to the reply, or the compression target when compressing.
  let budget = limit - usage.reserve;
  if (compress) budget = Math.min(budget, Math.floor((limit * settings.contextCompressTarget) / 100));
  const summarizing = compress || mode === "summarize";

  const h = built.history;
  const n = h.length;
  const extra = summarizing ? NOTE_BUDGET : 0;
  let keepFrom = 0;
  let running = usage.total;
  while (running + extra > budget && keepFrom < n - 1) {
    running -= m.hist[keepFrom];
    keepFrom++;
    if (h[keepFrom - 1].role === "user" && keepFrom < n - 1 && h[keepFrom].role === "assistant") {
      running -= m.hist[keepFrom];
      keepFrom++;
    }
  }
  if (keepFrom === 0) return untouched;

  const dropped = h.slice(0, keepFrom);
  const kept = h.slice(keepFrom);
  const action: ContextAction = {
    mode: compress ? "compress" : mode, droppedMessages: dropped.length, droppedIds: dropped.map((x) => x.id), summarized: false,
    limit, reserve: usage.reserve, totalBefore: usage.total, totalAfter: Math.round(running),
  };
  let note: string | null = null;
  if (summarizing) {
    const key = `${m.built.history[0]?.id ?? ""}|${dropped[0].id}|${dropped[dropped.length - 1].id}|${dropped.length}|${m.model}`;
    note = summaryCache.get(key) ?? null;
    if (!note) {
      note = await summarizeItems(m.prov, m.model, dropped, limit, { signal, userId });
      if (note) {
        if (summaryCache.size > 200) summaryCache.delete(summaryCache.keys().next().value as string);
        summaryCache.set(key, note);
      }
    }
    if (note) {
      action.summarized = true;
      action.totalAfter = Math.round(running + estimateTokens(note) + MSG_OVERHEAD);
    } else action.fellBack = true;
  }
  if (action.totalAfter + usage.reserve > limit) action.unfit = true;

  const body: ChatMessage[] = kept.map((x) => {
    const w = m.wire?.get(x.id);
    return w ? { role: x.role, content: w.content, ...(w.parts ? { parts: w.parts } : {}), plain: x.content } : { role: x.role, content: x.content };
  });
  const label = "[Summary of the earlier conversation]";
  let head: ChatMessage[];
  if (!built.system) head = note ? [{ role: "system", content: `${label}\n${note}` }] : [];
  else head = [{ role: "system", content: note ? `${built.system}\n\n${label}\n${note}` : built.system }];
  return { messages: [...head, ...body], action, overflow: false, usage };
}

export const overflowMessage = (u: ContextUsage): string =>
  `Context limit exceeded: about ${u.total} tokens used + ${u.reserve} reserved for the reply > ${u.limit} limit. Start a new chat, shorten the message, or change the overflow setting.`;

