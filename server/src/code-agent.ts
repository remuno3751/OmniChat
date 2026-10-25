import { randomUUID } from "node:crypto";
import type { ChatMessage, StreamToolCall, ToolDef } from "./providers/index.js";
import { createProvider } from "./providers/index.js";
import { decryptSecret } from "./secret.js";
import { setMessageTools } from "./db.js";
import type { ToolCall } from "./tools/types.js";
import { ToolSession } from "./tools/exec.js";
import { getTool, toolsReady } from "./tools/registry.js";
import { broadcast } from "./hub.js";
import { PhaseTracker } from "./phases.js";
import { getUsableProviderRow, modelDenied } from "./shared-providers.js";
import { quotaRefusal, recordQuotaUsage } from "./quota.js";
import { getSettings } from "./projects.js";
import { discoverLimit } from "./context.js";
import { estimateTokens, MSG_OVERHEAD } from "./tokens.js";
import { planSearch, rawQuery } from "./search/plan.js";
import { newRuntime } from "./search/pipeline.js";
import { phaseLabel, injectSearch, planAskOf, searchModelOf, searchModeFor, saveGuardNotice } from "./search/turn.js";
import { openRun, closeRun, VscodeBridgeError, type VscodeRun } from "./vscode-bridge.js";
import { CODE_TOOLS, CODE_TOOL_NAMES, codeSystemPrompt, formatToolResult, displayArgs, callSummary, clip } from "./code-tools.js";
import { RunSupport, currentApprovalMode } from "./code-run-hooks.js";
import { beginTranscript, type TranscriptFeed } from "./vscode-transcript.js";
import { logCodeDiag } from "./code-diag.js";

/**
 * Entry point for one turn of a `vscode-bridge` conversation (docs/design/VSCODE-BRIDGE.md S5).
 * chat.ts hands the turn over here instead of streaming from a provider. The loop talks to the model (any provider
 * adapter that can do tool calls, chosen by the conversation's "<providerId>::<modelId>") and to the VS Code extension
 * through `openRun` / `callTool` / `closeRun` of vscode-bridge.ts, which executes the tools.
 */
export interface VscodeTurnArgs {
  userId: string;
  /** the providers row of kind 'vscode-bridge' (base_url = bridge name) */
  prov: any;
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
  /** conversation row (cwd, approval_mode, ... ) */
  conversation: any;
  /** the context-managed message list (system prompt + history) built for this turn */
  messages: ChatMessage[];
  /** conversation model: "<providerId>::<modelId>" (BRIDGE-v2 modelRef) or empty */
  model: string;
  effort: unknown;
  signal: AbortSignal;
  /** streams answer text / reasoning text into the assistant message */
  onText(text: string): void;
  onReasoning(text: string): void;
}

const DEFAULT_ROUNDS = 50;
const MAX_ROUNDS = 200;
const DEFAULT_WALL_MS = 30 * 60_000;
const ELIDE_AT = 0.7;
const TOOL_RESULT_SHOWN = 8 * 1024;
/** provider kinds that are agent bridges themselves, not model backends */
const NOT_MODEL_KINDS = new Set(["dsh-bridge", "vscode-bridge"]);

/** Round limit of one Code turn: env OMNICHAT_CODE_MAX_ROUNDS (default 50, max 200). */
export function codeMaxRounds(): number {
  const n = Math.floor(Number(process.env.OMNICHAT_CODE_MAX_ROUNDS ?? DEFAULT_ROUNDS));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_ROUNDS) : DEFAULT_ROUNDS;
}
/** Wall clock limit of one Code turn in ms (30 minutes; OMNICHAT_CODE_MAX_MS overrides it, mainly for tests). */
function codeMaxMs(): number {
  const n = Number(process.env.OMNICHAT_CODE_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WALL_MS;
}

/** The model backend of a Code turn, from the conversation model ref. Throws a readable Error when it cannot be used. */
export function resolveCodeModel(userId: string, ref: string): { prov: any; model: string } {
  const i = typeof ref === "string" ? ref.indexOf("::") : -1;
  if (i <= 0 || i + 2 >= ref.length) throw new Error("この Code の会話にはモデルが選ばれていません。モデルを選んでから送信してください。");
  const row = getUsableProviderRow(userId, ref.slice(0, i));
  if (!row || row.deleted) throw new Error("The provider of the chosen model is not available.");
  const model = ref.slice(i + 2);
  if (modelDenied(userId, row, model)) throw new Error("This model is not allowed for your account");
  if (NOT_MODEL_KINDS.has(row.kind)) throw new Error(`Provider kind '${row.kind}' cannot answer: it has no model that can call tools. Choose a model provider.`);
  const q = quotaRefusal(userId, row);
  if (q) throw new Error(q.message);
  return { prov: row, model };
}

const tokensOf = (m: ChatMessage): number =>
  estimateTokens(m.content) + MSG_OVERHEAD + (m.tool_calls ?? []).reduce((a, c) => a + estimateTokens(c.function.name + c.function.arguments), 0);

/** Replaces the OLDEST tool results by a one-line stub until the estimate is <= `target` tokens (results of the newest round are kept). */
export function elideToolResults(wire: ChatMessage[], target: number): number {
  let total = wire.reduce((a, m) => a + tokensOf(m), 0);
  if (total <= target) return 0;
  let lastAsst = -1;
  for (let i = wire.length - 1; i >= 0; i--) if (wire[i].role === "assistant" && wire[i].tool_calls?.length) { lastAsst = i; break; }
  const names = new Map<string, string>();
  for (const m of wire) for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  let n = 0;
  for (let i = 0; i < lastAsst && total > target; i++) {
    const m = wire[i];
    if (m.role !== "tool" || m.content.startsWith("[result elided")) continue;
    const before = tokensOf(m);
    wire[i] = { ...m, content: `[result elided to save context: ${names.get(m.tool_call_id ?? "") ?? "tool"}, ${m.content.length} chars]` };
    total -= before - tokensOf(wire[i]);
    n++;
  }
  return n;
}

function parseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false } {
  try {
    const v = raw.trim() ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, args: v as Record<string, unknown> } : { ok: false };
  } catch { return { ok: false }; }
}

export async function runVscodeTurn(args: VscodeTurnArgs): Promise<void> {
  // live transcript for the chat panel in VS Code (S12); streams to the chat-capable windows of this bridge
  const feed = beginTranscript({
    userId: args.userId, bridge: String(args.prov?.base_url ?? "").trim(), conversationId: args.conversationId,
    userMessageId: args.userMessageId, assistantMessageId: args.assistantMessageId,
  });
  const a: VscodeTurnArgs = {
    ...args,
    onText: (t) => { feed.addText(t); args.onText(t); },
    onReasoning: (t) => { feed.addReasoning(t); args.onReasoning(t); },
  };
  try {
    await runTurn(a, feed);
    feed.end(args.signal.aborted ? "stopped" : "done");
  } catch (e) {
    feed.end(args.signal.aborted ? "stopped" : "error", args.signal.aborted ? undefined : e instanceof Error ? e.message : String(e));
    throw e;
  }
}

async function runTurn(a: VscodeTurnArgs, feed: TranscriptFeed): Promise<void> {
  const { userId, conversationId, assistantMessageId, signal } = a;
  const bridge = String(a.prov?.base_url ?? "").trim();
  const cwd = typeof a.conversation?.cwd === "string" ? a.conversation.cwd : "";
  if (!bridge) throw new Error("The VS Code provider has no bridge name.");
  if (!cwd) throw new Error("No working folder is selected for this Code chat. Pick a folder that is open in VS Code.");
  const target = resolveCodeModel(userId, a.model);
  const provider = createProvider({ kind: target.prov.kind, baseUrl: target.prov.base_url, apiKey: decryptSecret(target.prov.api_key), model: target.model });
  const effort = a.effort && typeof a.effort === "object" ? (a.effort as Record<string, unknown>) : typeof a.effort === "string" ? a.effort : null;

  const support = new RunSupport({ userId, conversationId, assistantMessageId, bridge, cwd, roots: [cwd], signal });
  // one tool list for the message: bridge calls and server-side web_search calls (ToolSession keeps and saves both)
  const session = new ToolSession(userId, conversationId, assistantMessageId, signal);
  const calls: ToolCall[] = session.calls;
  const phases = new PhaseTracker(userId, conversationId, assistantMessageId);
  const emit = (call: ToolCall) => {
    feed.tool(call);
    try { setMessageTools(assistantMessageId, calls, session.turn.sources); } catch (e) { console.error("tool trace save failed", e); }
    broadcast(userId, { type: "tool", messageId: assistantMessageId, conversationId, call: { ...call } });
  };

  let run: VscodeRun | null = null;
  let usedTokens = 0;
  try {
    run = await openRun({ userId, bridge, cwd, conversationId, approvalMode: currentApprovalMode(conversationId), checkpoint: true, roots: [cwd], hooks: support.hooks, signal });
    support.run = run;
    feed.setRunId(run.runId);
    const offered = new Set(run.tools.length ? run.tools.filter((t) => CODE_TOOL_NAMES.has(t)) : CODE_TOOL_NAMES);
    const defs: ToolDef[] = CODE_TOOLS.filter((d) => offered.has(d.function.name));
    logCodeDiag({ conversationId, providerKind: target.prov.kind, providerName: target.prov.name, model: target.model, tools: defs.map((d) => d.function.name), cwd });
    if (!defs.length) throw new Error("VS Code から使えるツールがありません（拡張のバージョン・フォルダの信頼設定・選んだフォルダが VS Code で開かれているかを確認してください）");

    // system message: the conversation's own system text first, then the Code rules
    const sys = codeSystemPrompt(cwd, run.roots);
    let wire: ChatMessage[] = a.messages.map((m) => ({ ...m }));
    if (wire[0]?.role === "system") wire[0] = { ...wire[0], content: `${wire[0].content}\n\n${sys}` };
    else wire.unshift({ role: "system", content: sys });

    // the context limit is looked up while the web-search planning below runs (it is awaited after that block)
    const limitP = discoverLimit(getSettings(userId), target.prov, target.model).catch(() => ({ limit: null }));

    // web search, as in chat: always (or smart with a search model) searches once before round 0 and injects the results
    // into the last user message; smart without a search model offers web_search to the model instead; off does nothing
    await toolsReady().catch(() => undefined);
    const sopts = getSettings(userId).search;
    const sm = searchModelOf(userId, sopts);
    const planAsk = planAskOf(sm, target.prov, target.model, signal);
    session.turn.search = newRuntime(sopts, sm ? planAsk : null, null);
    const searchMode = searchModeFor(userId, a.conversation);
    const searchUp = !!getTool("web_search")?.available;
    const webTools = new Set<string>();
    if (searchMode === "smart" && !sm && searchUp) {
      const t = getTool("web_search")!;
      defs.push({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } });
      webTools.add("web_search");
    }
    if ((searchMode === "always" || (searchMode === "smart" && !!sm)) && (searchUp || searchMode === "always")) {
      const lastUserText = [...wire].reverse().find((m) => m.role === "user")?.content ?? "";
      phases.start("searching", phaseLabel(lastUserText));
      const history = wire.filter((m) => m.role === "user" || m.role === "assistant").slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      const plan = searchUp ? await planSearch(planAsk, history, lastUserText, searchMode === "smart") : { search: true, query: rawQuery(lastUserText), source: "fallback" as const };
      if (plan.search) {
        phases.end("searching");
        phases.start("searching", phaseLabel(plan.query));
        wire = (await injectSearch(session, wire, plan.query)).messages;
      }
      phases.end("searching");
    }

    const limit = (await limitP).limit;
    const maxRounds = codeMaxRounds();
    const started = Date.now();
    const wallMs = codeMaxMs();
    let needSep = false;
    let stopNote = "";
    let thinking = false;

    for (let round = 0; ; round++) {
      if (signal.aborted) break;
      if (round >= maxRounds) { stopNote = `ラウンド上限(${maxRounds})に達したため停止しました。続けるには「続けて」と送ってください。 (Stopped: round limit of ${maxRounds} reached.)`; break; }
      if (Date.now() - started > wallMs) { stopNote = `実行時間の上限(${Math.round(wallMs / 60000)}分)に達したため停止しました。続けるには「続けて」と送ってください。 (Stopped: time limit reached.)`; break; }
      if (limit) elideToolResults(wire, Math.floor(limit * ELIDE_AT));

      let text = "";
      let toolCalls: StreamToolCall[] | null = null;
      const sink = { response: {} as { usage?: any } };
      try {
        for await (const item of provider.stream({
          messages: wire, model: target.model, signal, effort, debug: sink, tools: defs.length ? defs : undefined,
          context: { userId, conversationId, providerId: target.prov.id, userMessageId: a.userMessageId ?? undefined, assistantMessageId },
        })) {
          if (signal.aborted) break;
          if (typeof item === "object" && item.kind === "tool_calls") { toolCalls = item.calls; phases.end("thinking"); thinking = false; continue; }
          const kind = typeof item === "string" ? "text" : item.kind;
          const t = typeof item === "string" ? item : item.text;
          if (!t) continue;
          if (kind === "reasoning") {
            if (!thinking) { thinking = true; phases.start("thinking"); }
            a.onReasoning(t);
          } else {
            if (thinking) { thinking = false; phases.end("thinking"); }
            if (needSep) { a.onText("\n\n"); needSep = false; }
            text += t;
            a.onText(t);
          }
        }
      } catch (e) {
        if (signal.aborted) break;
        const msg = e instanceof Error ? e.message : String(e);
        if (round === 0 && !text && /^HTTP (400|404|405|415|422|501)\b|\btools?\b|function[ _-]?call/i.test(msg)) {
          throw new Error(`The model or provider did not accept tool calling (${clip(msg, 300)}). Choose a model that supports tools.`);
        }
        throw e;
      } finally {
        if (thinking) { thinking = false; phases.end("thinking"); }
        const u = sink.response.usage;
        const p = Number(u?.prompt_tokens), c = Number(u?.completion_tokens);
        usedTokens += Number.isFinite(p) && Number.isFinite(c) ? p + c : wire.reduce((s, m) => s + tokensOf(m), 0) + estimateTokens(text);
      }
      if (signal.aborted) break;
      if (text.trim()) needSep = true;
      if (!toolCalls?.length) break;

      const tcs = toolCalls.map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` }));
      wire = [...wire, { role: "assistant", content: text, tool_calls: tcs.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) }];
      for (const c of tcs) {
        if (signal.aborted) { wire = [...wire, { role: "tool", tool_call_id: c.id, content: "ERROR cancelled: run was cancelled" }]; continue; }
        const out = await executeCall(c);
        wire = [...wire, { role: "tool", tool_call_id: c.id, content: out }];
      }
    }
    if (stopNote && !signal.aborted) a.onText(`${needSep ? "\n\n" : ""}${stopNote}`);

    /** One tool call: policy / approval, then the extension. Never throws except for a lost connection. */
    async function executeCall(c: StreamToolCall): Promise<string> {
      if (webTools.has(c.name)) {
        // server-side search: no bridge, no extension approval; ToolSession keeps the trace and the sources
        const parsedWeb = parseArgs(c.arguments);
        phases.start("searching", callSummary(c.name, parsedWeb.ok ? parsedWeb.args : {}), c.id);
        try { return (await session.execute(c.id, c.name, c.arguments, webTools)).text; } finally { phases.end("searching", c.id); }
      }
      const call: ToolCall = { id: c.id, name: c.name, arguments: {}, status: "running", startedAt: Date.now() };
      calls.push(call);
      const parsed = parseArgs(c.arguments);
      const fail = (code: string, message: string, status: ToolCall["status"] = "error", decidedBy?: string): string => {
        call.status = status; call.error = `${code}: ${message}`; call.durationMs = Date.now() - call.startedAt;
        if (decidedBy) call.decidedBy = decidedBy;
        emit(call);
        return formatToolResult({ ok: false, error: { code, message } });
      };
      if (!parsed.ok) { emit(call); return fail("invalid_args", "arguments are not a valid JSON object"); }
      const args = parsed.args;
      call.arguments = displayArgs(args);
      if (!CODE_TOOL_NAMES.has(c.name) || !offered.has(c.name)) { emit(call); return fail("unsupported", `tool '${c.name}' is not available in this VS Code window`); }
      call.status = "pending";
      emit(call);
      phases.start("tool", callSummary(c.name, args), c.id);
      try {
        support.current = { tool: c.name, args };
        const auth = await support.authorize(c.name, args);
        if (!auth.ok) return fail("denied", auth.message, "denied", auth.decidedBy);
        call.decidedBy = auth.decidedBy;
        call.status = "running";
        emit(call);
        let shown = "";
        let lastEmit = 0;
        support.onProgress = (stream, t) => {
          shown = clip(shown + (stream === "stderr" ? "[stderr] " : "") + t, TOOL_RESULT_SHOWN);
          const now = Date.now();
          if (now - lastEmit < 250) return;
          lastEmit = now; call.result = shown; emit(call);
        };
        const r = await run!.callTool(c.name, args, { approval: auth.approval });
        call.durationMs = Date.now() - call.startedAt;
        const text = formatToolResult(r);
        if (r.ok) { call.status = "done"; call.result = clip(text, TOOL_RESULT_SHOWN); delete call.error; }
        else { call.status = "error"; call.error = `${r.error.code}: ${r.error.message}`; call.result = shown || undefined; }
        emit(call);
        return text;
      } catch (e) {
        if (e instanceof VscodeBridgeError && e.code !== "closed") throw e; // lost connection: the turn fails
        return fail("cancelled", "run is not active");
      } finally {
        support.onProgress = null;
        support.current = null;
        phases.end("tool", c.id);
      }
    }
  } finally {
    feed.setSources(session.turn.sources);
    phases.closeAll();
    saveGuardNotice(assistantMessageId, session.turn.search);
    if (usedTokens > 0) { try { recordQuotaUsage(userId, target.prov, usedTokens); } catch { /* ignore */ } }
    if (run) {
      const done = await closeRun(run);
      if (!done.ok && !signal.aborted && done.error && done.error !== "cancelled") console.warn("vscode run ended with:", done.error);
    }
  }
}
