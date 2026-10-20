import { api } from "../client.mjs";
import { CliError, UsageError } from "../util.mjs";
import { table } from "../ui.mjs";
import { fetchGroups, resolveModel } from "./models.mjs";

const RUNNING = new Set(["running", "queued", "pending"]);
const fmt = (v, digits = 1) => (v == null || Number.isNaN(v) ? "-" : Number(v).toFixed(digits));
const pct = (v) => (v == null ? "-" : `${Math.round(v * 100)}%`);

/** Find a prompt set by exact name (case-insensitive) or id. */
export async function findSet(ctx, spec) {
  const r = await api(ctx, "GET", "/bench/sets");
  const sets = Array.isArray(r) ? r : Array.isArray(r?.sets) ? r.sets : [];
  const exact = sets.filter((s) => s.id === spec || s.name === spec);
  const hits = exact.length ? exact : sets.filter((s) => String(s.name).toLowerCase() === spec.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new CliError(`prompt set "${spec}" is ambiguous; use its id`);
  const names = sets.map((s) => `  ${s.name} (${s.id})`).join("\n") || "  (none; create one in the OmniChat app)";
  throw new CliError(`prompt set "${spec}" not found. Sets:\n${names}`);
}

/** Resolve each "<providerName>/<modelId>" entry of --targets to {providerId, model, label}. */
export async function resolveTargets(ctx, spec) {
  const parts = String(spec).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 6) throw new UsageError("--targets needs 1 to 6 comma-separated <providerName>/<modelId> entries");
  const groups = await fetchGroups(ctx);
  return parts.map((p) => {
    const m = resolveModel(p, groups);
    return { providerId: m.providerId, model: m.model, label: `${m.providerName}/${m.model}` };
  });
}

export async function benchCommand(ctx, pos) {
  const sub = pos[0];
  if (sub !== "run" || pos.length !== 2) {
    throw new UsageError('usage: omnichat bench run <setName|setId> --targets "<providerName>/<modelId>,..." [--repeats N]');
  }
  const f = ctx.flags;
  if (!f.targets) throw new UsageError("--targets is required");
  const repeats = f.repeats ?? 1;
  if (repeats < 1 || repeats > 5) throw new UsageError("--repeats must be between 1 and 5");
  if (f.maxTokens != null && f.maxTokens > 8192) throw new UsageError("--max-tokens must be at most 8192");

  const set = await findSet(ctx, pos[1]);
  const targets = await resolveTargets(ctx, f.targets);
  const body = {
    setId: set.id,
    targets: targets.map((t) => ({ providerId: t.providerId, model: t.model })),
    repeats,
    warmup: !f.noWarmup,
    maxTokens: f.maxTokens ?? 256,
  };
  const started = await api(ctx, "POST", "/bench/runs", { body });
  const runId = started?.runId;
  if (!runId) throw new CliError("server did not return a runId");
  const total = targets.length * (set.prompts?.length ?? 0) * repeats;
  ctx.info(`bench run ${runId}: ${set.name}, ${targets.length} target(s), ${total} generation(s)`);

  const pollMs = Number(ctx.env.OMNICHAT_BENCH_POLL_MS) || 1000;
  let cancelled = false;
  let giveUp = false;
  const offSig = ctx.io.onSigint(async () => {
    if (giveUp) return;
    if (cancelled) { giveUp = true; return; }
    cancelled = true;
    ctx.info("cancelling the run (Ctrl+C again to stop waiting)");
    try { await api(ctx, "POST", `/bench/runs/${encodeURIComponent(runId)}/cancel`, { body: {} }); } catch (e) { ctx.err(`cancel failed: ${e.message}`); }
  });
  const live = !!ctx.io.stderrIsTTY && !ctx.flags.quiet;
  let run;
  let lastLine = "";
  try {
    for (;;) {
      if (giveUp) { run = { id: runId, setName: set.name, status: "cancelled", summary: [], done: 0, total }; break; }
      run = await api(ctx, "GET", `/bench/runs/${encodeURIComponent(runId)}`);
      if (!RUNNING.has(run.status)) break;
      const line = `progress ${run.done ?? 0}/${run.total ?? total}`;
      if (line !== lastLine) {
        if (live) ctx.io.stderr.write(`\r${line}   `);
        else ctx.info(line);
        lastLine = line;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    offSig();
    if (live && lastLine) ctx.io.stderr.write("\n");
  }

  if (f.json) {
    ctx.out(JSON.stringify(run, null, 2) + "\n");
  } else {
    ctx.out(renderSummary(run, targets) + "\n");
  }
  if (cancelled || run.status === "cancelled") {
    ctx.info("run cancelled");
    return 130;
  }
  if (run.status === "error") {
    ctx.err(`error: benchmark run failed${run.error ? `: ${run.error}` : ""}`);
    return 1;
  }
  return 0;
}

export function renderSummary(run, targets) {
  const rows = (run.summary ?? []).map((s) => [
    targets[s.targetIndex]?.label ?? `${s.providerName}/${s.model}`,
    String(s.n),
    fmt(s.avgTtftMs, 0),
    fmt(s.avgPrefillTps),
    fmt(s.avgDecodeTps),
    fmt(s.p50DecodeTps),
    fmt(s.minDecodeTps),
    fmt(s.maxDecodeTps),
    String(s.errors ?? 0),
    pct(s.estimatedShare),
  ]);
  const head = `Run ${run.id ?? ""}  ${run.setName ?? ""}  status: ${run.status}${run.error ? ` (${run.error})` : ""}`;
  if (rows.length === 0) return head;
  const right = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  return `${head}\n${table(["TARGET", "N", "TTFT ms", "PREFILL t/s", "DECODE t/s", "P50 t/s", "MIN t/s", "MAX t/s", "ERR", "EST"], rows, right)}`;
}

