import type { WebSocket } from "ws";
import { decryptSecret } from "./secret.js";
import { db, getProviderRow } from "./db.js";
import type { Effort, SamplingParams } from "./db.js";
import { sendTo } from "./hub.js";
import { getUsableProviderRow, modelDenied, scrubForUser } from "./shared-providers.js";
import { maintenanceBlocking, maintenanceText } from "./maintenance.js";
import { createProvider } from "./providers/index.js";
import type { ChatMessage, DebugSink } from "./providers/index.js";
import { computeMetrics } from "./metrics.js";
import { quotaRefusal, recordQuotaUsage } from "./quota.js";
import type { MetricsComputed } from "./metrics.js";
import { providerState } from "./model-admin.js";
import { getSettings } from "./projects.js";
import { mergeParams, sanitizeParams, sanitizeEffort, toBodyParams } from "./sampling.js";
import { effortSupport, mapEffort } from "./effort.js";
import { sanitizeResponseFormat, toWireResponseFormat, checkJson } from "./structured.js";
import type { ResponseFormat } from "./structured.js";

/* Model comparison (PROTOCOL-v3-phase4.md section 3) + the shared one-shot generation used by the benchmark runner. */

export interface OneShotInput {
  userId: string;
  /** providers row (openai-compatible) */
  prov: any;
  model: string;
  messages: ChatMessage[];
  /** merged params (camelCase) */
  params: SamplingParams;
  /** value for the effort body fields (from mapEffort) */
  effortSentAs: Record<string, unknown> | string | null;
  responseFormat?: ResponseFormat | null;
  signal: AbortSignal;
  onDelta?: (kind: "text" | "reasoning", text: string) => void;
  /** re-read the adapter state (quantization / loaded context) even if cached */
  refreshState?: boolean;
}
export interface OneShotResult {
  status: "done" | "error" | "stopped";
  content: string;
  reasoning: string;
  metrics: MetricsComputed | null;
  error?: string;
}

/** Layers for a stateless run: one-shot > settings.modelParams[<providerId>::<model>] > global. Effort: one-shot > global. */
export function resolveOneShot(userId: string, prov: any, model: string, oneShot: { params?: unknown; effort?: unknown }) {
  const settings = getSettings(userId);
  const modelParams = settings.modelParams?.[`${prov.id}::${model}`] ?? null;
  const params = mergeParams(sanitizeParams(oneShot.params), modelParams, settings.params);
  const eff = sanitizeEffort(oneShot.effort) ?? settings.effort ?? null;
  const resolved: Effort | null = eff && effortSupport(model) !== "unsupported" ? eff : null;
  const sentAs = resolved ? mapEffort(prov.kind, resolved, prov.effort_profile ?? null) : null;
  return { params, effort: { requested: eff, resolved, sentAs } };
}

/** One isolated, non-stored generation through the normal provider layer (no tools, no history, no approvals). Never throws. */
export async function runOneShot(i: OneShotInput): Promise<OneShotResult> {
  let content = "";
  let reasoning = "";
  const sink: DebugSink = { response: {} };
  const startedAt = performance.now();
  let firstTokenAt: number | null = null;
  const finish = async (status: OneShotResult["status"], error?: string): Promise<OneShotResult> => {
    let metrics: MetricsComputed | null = null;
    try {
      const st = i.prov.kind === "openai-compatible"
        ? await providerState(i.prov, i.refreshState === true).then((ps) => ps?.states.get(i.model) ?? null).catch(() => null)
        : null;
      metrics = computeMetrics({
        startedAt, firstTokenAt, endedAt: performance.now(), content, reasoning, prompt: i.messages, response: sink.response,
        providerId: i.prov.id, providerKind: i.prov.kind, model: i.model, state: st,
      });
      if (metrics && i.responseFormat && status === "done") {
        const j = checkJson(content, i.responseFormat);
        metrics.jsonValid = j.valid;
        if (j.error) metrics.jsonError = j.error;
      }
      if (metrics) recordQuotaUsage(i.userId, i.prov, metrics.promptTokens + metrics.completionTokens);
    } catch { /* metrics are best effort */ }
    return { status, content, reasoning, metrics, ...(error ? { error } : {}) };
  };
  try {
    const provider = createProvider({ kind: i.prov.kind, baseUrl: i.prov.base_url, apiKey: decryptSecret(i.prov.api_key), model: i.prov.model });
    for await (const item of provider.stream({
      messages: i.messages, model: i.model, signal: i.signal,
      params: toBodyParams(i.params), effort: i.effortSentAs, debug: sink,
      responseFormat: i.responseFormat ? toWireResponseFormat(i.responseFormat) : undefined,
      extraBody: i.params.extraBody ?? undefined,
    })) {
      if (typeof item === "object" && item.kind === "tool_calls") continue;
      const kind = typeof item === "string" ? "text" : item.kind;
      const text = typeof item === "string" ? item : item.text;
      if (!text) continue;
      if (firstTokenAt === null) firstTokenAt = performance.now();
      if (kind === "reasoning") reasoning += text; else content += text;
      i.onDelta?.(kind as "text" | "reasoning", text);
      if (i.signal.aborted) break;
    }
    if (i.signal.aborted) return finish("stopped");
    return finish("done");
  } catch (e) {
    if (i.signal.aborted) return finish("stopped");
    const raw = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    // a shared provider's URL and key stay the owner's: another user sees the error without them
    return finish("error", i.prov.user_id !== i.userId ? scrubForUser(raw, i.prov) : raw);
  }
}

/* ---------------- compare ---------------- */

interface ActiveCompare { userId: string; controller: AbortController }
const activeCompares = new Map<string, ActiveCompare>();

interface Target { providerId: string; model: string; effort?: unknown; params?: unknown; responseFormat?: ResponseFormat | null }

const publicMetrics = (m: MetricsComputed | null) => {
  if (!m) return null;
  const { usageExact: _u, ...rest } = m;
  return { ...rest, origin: "compare" as const };
};

export function stopCompare(userId: string, compareId: unknown): void {
  if (typeof compareId !== "string") return;
  const a = activeCompares.get(compareId);
  if (a && a.userId === userId) a.controller.abort();
}

export async function handleCompare(userId: string, msg: any, reply: (f: unknown) => void): Promise<void> {
  const compareId = typeof msg?.compareId === "string" ? msg.compareId : "";
  const err = (message: string) => reply({ type: "error", message, ...(compareId ? { compareId } : {}) });
  const blocked = maintenanceBlocking(userId);
  if (blocked) return reply({ type: "error", code: "maintenance", message: maintenanceText(blocked), ...(compareId ? { compareId } : {}) });
  if (!compareId || compareId.length > 100) return err("compareId is required");
  if (typeof msg.prompt !== "string" || !msg.prompt.trim()) return err("prompt is required");
  if (msg.prompt.length > 200_000) return err("prompt is too long");
  if (msg.systemPrompt != null && typeof msg.systemPrompt !== "string") return err("systemPrompt must be a string or null");
  if (!Array.isArray(msg.targets) || msg.targets.length < 1 || msg.targets.length > 4) return err("targets must contain 1 to 4 entries");
  if (activeCompares.has(compareId) || db.prepare("SELECT 1 FROM comparisons WHERE id = ?").get(compareId)) return err("compareId already used");

  // one-shot response format for every target that does not set its own
  const defaultRf = msg.responseFormat != null ? sanitizeResponseFormat(msg.responseFormat) : null;
  if (defaultRf === undefined) return err("Invalid responseFormat");
  const targets: Target[] = [];
  const provs: any[] = [];
  for (const t of msg.targets) {
    if (!t || typeof t.providerId !== "string" || typeof t.model !== "string" || !t.model) return err("each target needs providerId and model");
    const prov = getUsableProviderRow(userId, t.providerId);
    if (!prov) return err("Unknown provider");
    if (modelDenied(userId, prov, t.model)) return reply({ type: "error", code: "model_not_allowed", message: "This model is not allowed for your account", ...(compareId ? { compareId } : {}) });
    const quota = quotaRefusal(userId, prov);
    if (quota) return reply({ type: "error", code: quota.code, message: quota.message, ...(compareId ? { compareId } : {}) });
    if (prov.kind !== "openai-compatible") return err(`${prov.kind} providers cannot be compared (only openai-compatible)`);
    let rf: ResponseFormat | null = defaultRf;
    if (t.responseFormat != null) {
      const s = sanitizeResponseFormat(t.responseFormat);
      if (s === undefined) return err("Invalid responseFormat");
      rf = s;
    }
    targets.push({ providerId: t.providerId, model: t.model.slice(0, 300), effort: t.effort, params: t.params, responseFormat: rf });
    provs.push(prov);
  }
  const sequential = msg.sequential !== false;
  const systemPrompt = typeof msg.systemPrompt === "string" && msg.systemPrompt.trim() ? msg.systemPrompt : null;
  const messages: ChatMessage[] = [...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []), { role: "user", content: msg.prompt }];

  const controller = new AbortController();
  activeCompares.set(compareId, { userId, controller });
  const results: any[] = new Array(targets.length);

  const runTarget = async (index: number) => {
    const t = targets[index];
    const prov = provs[index];
    const base = { providerId: prov.id, providerName: prov.name, model: t.model };
    let r: OneShotResult;
    // the entry check ran before any target; targets that run one after another are held to the limit again (as in bench.ts)
    const quota = controller.signal.aborted ? null : quotaRefusal(userId, prov);
    if (controller.signal.aborted) {
      r = { status: "stopped", content: "", reasoning: "", metrics: null };
    } else if (quota) {
      r = { status: "error", content: "", reasoning: "", metrics: null, error: quota.message };
    } else {
      const cfg = resolveOneShot(userId, prov, t.model, { params: t.params, effort: t.effort });
      r = await runOneShot({
        userId, prov, model: t.model, messages, params: cfg.params, effortSentAs: cfg.effort.sentAs as any,
        responseFormat: t.responseFormat ?? null, signal: controller.signal, refreshState: true,
        onDelta: (kind, text) => reply({ type: "compare_delta", compareId, index, kind, text }),
      });
    }
    const metrics = publicMetrics(r.metrics);
    results[index] = { index, ...base, status: r.status, content: r.content, reasoning: r.reasoning, metrics, ...(r.error ? { error: r.error } : {}) };
    reply({ type: "compare_done", compareId, index, status: r.status, content: r.content, reasoning: r.reasoning, metrics, ...(r.error ? { error: r.error } : {}) });
  };

  try {
    if (sequential) for (let i = 0; i < targets.length; i++) await runTarget(i);
    else await Promise.all(targets.map((_, i) => runTarget(i)));
  } finally {
    activeCompares.delete(compareId);
    try {
      db.prepare("INSERT INTO comparisons (id, user_id, created_at, prompt, system_prompt, targets, results) VALUES (?,?,?,?,?,?,?)").run(
        compareId, userId, Date.now(), msg.prompt, systemPrompt,
        JSON.stringify(targets.map((t, i) => ({
          providerId: t.providerId, providerName: provs[i].name, model: t.model,
          ...(t.effort != null ? { effort: sanitizeEffort(t.effort) ?? null } : {}),
          ...(t.params != null ? { params: sanitizeParams(t.params) } : {}),
          ...(t.responseFormat ? { responseFormat: t.responseFormat } : {}),
        }))),
        JSON.stringify(targets.map((t, i) => results[i] ?? { index: i, providerId: t.providerId, providerName: provs[i].name, model: t.model, status: "stopped", content: "", reasoning: "", metrics: null })),
      );
    } catch (e) { console.error("comparison save failed", e); }
    reply({ type: "compare_complete", compareId });
  }
}

/** WS dispatch. Returns true if the frame was a compare frame. */
export function handleCompareFrame(userId: string, ws: WebSocket, msg: any): boolean {
  if (msg?.type === "compare") {
    handleCompare(userId, msg, (f) => sendTo(ws, f)).catch((e) => console.error("compare failed", e));
    return true;
  }
  if (msg?.type === "compare_stop") {
    stopCompare(userId, msg.compareId);
    return true;
  }
  return false;
}

/* ---------------- storage for the routes ---------------- */

const parse = (s: unknown): any => { try { return JSON.parse(String(s)); } catch { return null; } };

export function listComparisons(userId: string) {
  const rows = db.prepare("SELECT * FROM comparisons WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId) as any[];
  return rows.map((r) => ({
    id: r.id, createdAt: r.created_at, prompt: String(r.prompt).slice(0, 200),
    targets: (parse(r.targets) ?? []).map((t: any) => ({ providerId: t.providerId, providerName: t.providerName, model: t.model })),
    statuses: (parse(r.results) ?? []).map((x: any) => x.status),
  }));
}
export function getComparison(userId: string, id: string) {
  const r = db.prepare("SELECT * FROM comparisons WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!r) return null;
  return { id: r.id, createdAt: r.created_at, prompt: r.prompt, systemPrompt: r.system_prompt ?? null, targets: parse(r.targets) ?? [], results: parse(r.results) ?? [] };
}
export function deleteComparison(userId: string, id: string): boolean {
  return db.prepare("DELETE FROM comparisons WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
