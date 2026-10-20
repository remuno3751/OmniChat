import { randomUUID } from "node:crypto";
import { db, getProviderRow } from "./db.js";
import { AuthError } from "./auth.js";
import { broadcast } from "./hub.js";
import { getUsableProviderRow, modelDenied, scrubForUser } from "./shared-providers.js";
import { csvCell } from "./metrics.js";
import { quotaRefusal } from "./quota.js";
import { sanitizeParams, sanitizeEffort } from "./sampling.js";
import { runOneShot, resolveOneShot } from "./compare.js";
import type { ChatMessage } from "./providers/index.js";
import { paramsProblem } from "./structured.js";
import { assertMaintenanceAllows } from "./maintenance.js";

/* Benchmark runner (PROTOCOL-v3-phase4.md section 4). */

export const MAX_SET_PROMPTS = 50;
export const MAX_PROMPT_CHARS = 8000;
const SNIPPET = 500;
const bad = (m: string, status = 400) => new AuthError(m, status);

/* ---------------- prompt sets ---------------- */

export interface BenchSet { id: string; name: string; prompts: string[]; systemPrompt: string | null; createdAt: number; updatedAt: number }

/** Validates a set body (shared with the config import). Returns the clean value or a problem text. */
export function validateSetBody(b: any): { name: string; prompts: string[]; systemPrompt: string | null } | string {
  if (!b || typeof b !== "object") return "body must be an object";
  if (typeof b.name !== "string" || !b.name.trim()) return "name is required";
  if (!Array.isArray(b.prompts) || b.prompts.length < 1 || b.prompts.length > MAX_SET_PROMPTS) return `prompts must contain 1 to ${MAX_SET_PROMPTS} entries`;
  for (const p of b.prompts) {
    if (typeof p !== "string" || !p.trim()) return "every prompt must be a non-empty string";
    if (p.length > MAX_PROMPT_CHARS) return `a prompt is longer than ${MAX_PROMPT_CHARS} characters`;
  }
  if (b.systemPrompt != null && typeof b.systemPrompt !== "string") return "systemPrompt must be a string or null";
  const sp = typeof b.systemPrompt === "string" && b.systemPrompt.trim() ? b.systemPrompt.slice(0, 200_000) : null;
  return { name: b.name.trim().slice(0, 200), prompts: b.prompts as string[], systemPrompt: sp };
}

const toSet = (r: any): BenchSet => ({
  id: r.id, name: r.name, prompts: JSON.parse(r.prompts), systemPrompt: r.system_prompt ?? null, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listSets(userId: string): BenchSet[] {
  return (db.prepare("SELECT * FROM bench_sets WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as any[]).map(toSet);
}
export function upsertSet(userId: string, id: string, body: any): BenchSet {
  if (!id || id.length > 100) throw bad("invalid id");
  const v = validateSetBody(body);
  if (typeof v === "string") throw bad(v);
  const row = db.prepare("SELECT * FROM bench_sets WHERE id = ?").get(id) as any;
  if (row && row.user_id !== userId) throw bad("Forbidden", 403);
  const now = Date.now();
  if (!row) db.prepare("INSERT INTO bench_sets (id, user_id, name, prompts, system_prompt, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, userId, v.name, JSON.stringify(v.prompts), v.systemPrompt, now, now);
  else db.prepare("UPDATE bench_sets SET name = ?, prompts = ?, system_prompt = ?, updated_at = ? WHERE id = ?").run(v.name, JSON.stringify(v.prompts), v.systemPrompt, now, id);
  return toSet(db.prepare("SELECT * FROM bench_sets WHERE id = ?").get(id));
}
export function deleteSet(userId: string, id: string): boolean {
  return db.prepare("DELETE FROM bench_sets WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/* ---------------- runs ---------------- */

interface RunTarget { providerId: string; providerName: string; model: string; effort?: string | null; params?: unknown }
interface RunState { runId: string; controller: AbortController }
const running = new Map<string, RunState>();

export const isBenchRunning = (userId: string) => running.has(userId);

/** Validates, stores and starts a run in the background. */
export function startRun(userId: string, body: any): { runId: string } {
  assertMaintenanceAllows(userId);
  const b = body ?? {};
  if (typeof b.setId !== "string") throw bad("setId is required");
  const set = db.prepare("SELECT * FROM bench_sets WHERE id = ? AND user_id = ?").get(b.setId, userId) as any;
  if (!set) throw bad("Unknown prompt set", 404);
  if (!Array.isArray(b.targets) || b.targets.length < 1 || b.targets.length > 6) throw bad("targets must contain 1 to 6 entries");
  const targets: RunTarget[] = [];
  for (const t of b.targets) {
    if (!t || typeof t.providerId !== "string" || typeof t.model !== "string" || !t.model) throw bad("each target needs providerId and model");
    const prov = getUsableProviderRow(userId, t.providerId);
    if (!prov) throw bad("Unknown provider");
    if (modelDenied(userId, prov, t.model)) throw bad("This model is not allowed for your account", 403);
    const quota = quotaRefusal(userId, prov);
    if (quota) throw bad(quota.message, 429);
    if (prov.kind !== "openai-compatible") throw bad(`${prov.kind} providers cannot be benchmarked (only openai-compatible)`);
    if (t.effort != null && sanitizeEffort(t.effort) === undefined) throw bad("effort must be low, medium, high, max or null");
    if (t.params != null) {
      if (typeof t.params !== "object" || Array.isArray(t.params)) throw bad("params must be an object or null");
      const pp = paramsProblem(t.params);
      if (pp) throw bad(pp);
    }
    targets.push({
      providerId: prov.id, providerName: prov.name, model: t.model.slice(0, 300),
      ...(t.effort ? { effort: t.effort } : {}), ...(t.params ? { params: sanitizeParams(t.params) } : {}),
    });
  }
  let repeats = 1;
  if (b.repeats !== undefined) {
    if (!Number.isInteger(b.repeats) || b.repeats < 1 || b.repeats > 5) throw bad("repeats must be an integer 1..5");
    repeats = b.repeats;
  }
  let maxTokens = 256;
  if (b.maxTokens !== undefined) {
    if (!Number.isInteger(b.maxTokens) || b.maxTokens < 1 || b.maxTokens > 32768) throw bad("maxTokens must be an integer 1..32768");
    maxTokens = b.maxTokens;
  }
  if (b.warmup !== undefined && typeof b.warmup !== "boolean") throw bad("warmup must be a boolean");
  const warmup = b.warmup !== false;

  if (running.has(userId)) throw bad("a benchmark is already running", 409);
  const prompts: string[] = JSON.parse(set.prompts);
  const runId = randomUUID();
  const total = targets.length * prompts.length * repeats;
  db.prepare(
    "INSERT INTO bench_runs (id, user_id, set_id, set_name, status, started_at, targets, repeats, warmup, max_tokens, prompt_count, total, done) VALUES (?,?,?,?,'running',?,?,?,?,?,?,?,0)",
  ).run(runId, userId, set.id, set.name, Date.now(), JSON.stringify(targets), repeats, warmup ? 1 : 0, maxTokens, prompts.length, total);
  const state: RunState = { runId, controller: new AbortController() };
  running.set(userId, state);
  void execute(userId, state, { targets, prompts, systemPrompt: set.system_prompt ?? null, repeats, warmup, maxTokens, total })
    .catch((e) => console.error("benchmark failed", e));
  return { runId };
}

/** Every benchmark call re-checks maintenance: once it is on, a regular user's running benchmark ends with an error. */
const guardedOneShot = (i: Parameters<typeof runOneShot>[0]) => {
  assertMaintenanceAllows(i.userId);
  // a running benchmark stops at the limit: its remaining items are errors (the run itself goes on)
  const quota = quotaRefusal(i.userId, i.prov);
  if (quota) return Promise.resolve({ status: "error" as const, content: "", reasoning: "", metrics: null, error: quota.message });
  return runOneShot(i);
};

async function execute(
  userId: string, st: RunState,
  p: { targets: RunTarget[]; prompts: string[]; systemPrompt: string | null; repeats: number; warmup: boolean; maxTokens: number; total: number },
): Promise<void> {
  const { runId, controller } = st;
  let done = 0;
  let status: "done" | "cancelled" | "error" = "done";
  let fatal: string | undefined;
  const ins = db.prepare("INSERT INTO bench_results (run_id, n, json) VALUES (?,?,?)");
  try {
    outer: for (let ti = 0; ti < p.targets.length; ti++) {
      const t = p.targets[ti];
      const prov = getUsableProviderRow(userId, t.providerId);
      // a model revoked mid-run is an error for its remaining items, like a vanished provider
      if (!prov || prov.deleted || modelDenied(userId, prov, t.model)) {
        // provider vanished mid-run: every remaining item of this target is an error
        for (let pi = 0; pi < p.prompts.length; pi++) for (let r = 0; r < p.repeats; r++) {
          ins.run(runId, done, JSON.stringify(errorResult(ti, pi, r, "provider no longer exists")));
          done++;
        }
        db.prepare("UPDATE bench_runs SET done = ? WHERE id = ?").run(done, runId);
        continue;
      }
      const cfg = resolveOneShot(userId, prov, t.model, { params: t.params, effort: t.effort });
      const params = { ...cfg.params, maxTokens: p.maxTokens };
      const sys: ChatMessage[] = p.systemPrompt ? [{ role: "system", content: p.systemPrompt }] : [];
      if (p.warmup) {
        broadcast(userId, { type: "bench_progress", runId, done, total: p.total, current: { targetIndex: ti, warmup: true } });
        await guardedOneShot({
          userId, prov, model: t.model, messages: [{ role: "user", content: "Hi" }], params: { ...params, maxTokens: 8 },
          effortSentAs: cfg.effort.sentAs as any, signal: controller.signal, refreshState: true,
        });
        if (controller.signal.aborted) { status = "cancelled"; break outer; }
      }
      for (let pi = 0; pi < p.prompts.length; pi++) {
        for (let rep = 0; rep < p.repeats; rep++) {
          if (controller.signal.aborted) { status = "cancelled"; break outer; }
          broadcast(userId, { type: "bench_progress", runId, done, total: p.total, current: { targetIndex: ti, promptIndex: pi, repeat: rep } });
          const r = await guardedOneShot({
            userId, prov, model: t.model, messages: [...sys, { role: "user", content: p.prompts[pi] }], params,
            effortSentAs: cfg.effort.sentAs as any, signal: controller.signal, refreshState: pi === 0 && rep === 0 && !p.warmup,
          });
          if (r.status === "stopped") { status = "cancelled"; break outer; }
          const m = r.metrics;
          const row = {
            targetIndex: ti, promptIndex: pi, repeat: rep, status: r.status,
            ttftMs: m?.ttftMs ?? null, prefillTps: m?.prefillTps ?? null, decodeTps: m?.decodeTps ?? null,
            completionTokens: m?.completionTokens ?? null, reasoningTokens: m?.reasoningTokens ?? null, totalMs: m?.totalMs ?? null,
            source: m?.source ?? "estimated", ...(r.error ? { error: prov.user_id !== userId ? scrubForUser(r.error, prov) : r.error } : {}),
            answer: r.content.slice(0, SNIPPET),
            quantization: m?.quantization ?? null, contextLength: m?.contextLength ?? null,
          };
          ins.run(runId, done, JSON.stringify(row));
          done++;
          db.prepare("UPDATE bench_runs SET done = ? WHERE id = ?").run(done, runId);
        }
      }
    }
  } catch (e) {
    status = "error";
    fatal = e instanceof Error ? e.message : String(e);
  } finally {
    running.delete(userId);
    db.prepare("UPDATE bench_runs SET status = ?, finished_at = ?, done = ?, error = ? WHERE id = ?").run(status, Date.now(), done, fatal ?? null, runId);
    broadcast(userId, { type: "bench_progress", runId, done, total: p.total });
    broadcast(userId, { type: "bench_done", runId, status });
  }
}

const errorResult = (ti: number, pi: number, rep: number, error: string) => ({
  targetIndex: ti, promptIndex: pi, repeat: rep, status: "error", ttftMs: null, prefillTps: null, decodeTps: null,
  completionTokens: null, reasoningTokens: null, totalMs: null, source: "estimated", error, answer: "", quantization: null, contextLength: null,
});

export function cancelRun(userId: string, runId: string): "ok" | "notfound" | "notrunning" {
  const row = db.prepare("SELECT 1 FROM bench_runs WHERE id = ? AND user_id = ?").get(runId, userId);
  if (!row) return "notfound";
  const st = running.get(userId);
  if (!st || st.runId !== runId) return "notrunning";
  st.controller.abort();
  return "ok";
}

/* ---------------- results ---------------- */

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r2 = (x: number) => Math.round(x * 100) / 100;
const avg = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null;
};
const median = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return r2(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
};

export function summarize(targets: RunTarget[], results: any[]) {
  return targets.map((t, ti) => {
    const all = results.filter((r) => r.targetIndex === ti);
    const ok = all.filter((r) => r.status === "done");
    const dec = ok.map((r) => num(r.decodeTps));
    const known = dec.filter((x): x is number => x !== null);
    return {
      targetIndex: ti, providerName: t.providerName, model: t.model,
      quantization: ok.map((r) => r.quantization).find((x) => x != null) ?? null,
      contextLength: ok.map((r) => r.contextLength).find((x) => x != null) ?? null,
      n: ok.length,
      avgTtftMs: avg(ok.map((r) => num(r.ttftMs))),
      avgPrefillTps: avg(ok.map((r) => num(r.prefillTps))),
      avgDecodeTps: avg(dec),
      p50DecodeTps: median(dec),
      minDecodeTps: known.length ? Math.min(...known) : null,
      maxDecodeTps: known.length ? Math.max(...known) : null,
      errors: all.filter((r) => r.status === "error").length,
      estimatedShare: ok.length ? r2(ok.filter((r) => r.source === "estimated").length / ok.length) : 0,
    };
  });
}

function runRow(userId: string, id: string): any {
  return db.prepare("SELECT * FROM bench_runs WHERE id = ? AND user_id = ?").get(id, userId);
}
const readResults = (runId: string): any[] =>
  (db.prepare("SELECT json FROM bench_results WHERE run_id = ? ORDER BY n").all(runId) as any[]).map((r) => JSON.parse(r.json));

const runHead = (r: any) => ({
  id: r.id, setId: r.set_id ?? null, setName: r.set_name, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at ?? null,
  targets: JSON.parse(r.targets), repeats: r.repeats, warmup: !!r.warmup, maxTokens: r.max_tokens, promptCount: r.prompt_count,
  total: r.total, done: r.done, ...(r.error ? { error: r.error } : {}),
});

export function listRuns(userId: string) {
  return (db.prepare("SELECT * FROM bench_runs WHERE user_id = ? ORDER BY started_at DESC, rowid DESC").all(userId) as any[]).map(runHead);
}
export function getRun(userId: string, id: string) {
  const r = runRow(userId, id);
  if (!r) return null;
  const head = runHead(r);
  const results = readResults(id);
  return { ...head, results, summary: summarize(head.targets, results) };
}
export function deleteRun(userId: string, id: string): "ok" | "notfound" | "running" {
  const r = runRow(userId, id);
  if (!r) return "notfound";
  if (r.status === "running" && running.get(userId)?.runId === id) return "running";
  db.prepare("DELETE FROM bench_results WHERE run_id = ?").run(id);
  db.prepare("DELETE FROM bench_runs WHERE id = ?").run(id);
  return "ok";
}

const CSV_COLS = [
  "target", "provider", "model", "prompt", "repeat", "status", "ttft_ms", "prefill_tps", "decode_tps",
  "completion_tokens", "reasoning_tokens", "total_ms", "source", "error",
] as const;
export function runCsv(userId: string, id: string): string | null {
  const run = getRun(userId, id);
  if (!run) return null;
  const lines: string[] = [CSV_COLS.join(",")];
  for (const r of run.results) {
    const t = run.targets[r.targetIndex];
    const cells = [r.targetIndex, t?.providerName, t?.model, r.promptIndex, r.repeat, r.status, r.ttftMs, r.prefillTps, r.decodeTps,
      r.completionTokens, r.reasoningTokens, r.totalMs, r.source, r.error];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
