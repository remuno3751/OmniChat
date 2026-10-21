/**
 * Run state machine (docs/design/VSCODE-BRIDGE.md §2.1–2.4). One run per instance; reads run up to 4
 * in parallel, writes are exclusive, and calls keep arrival order. Each call gets one tool_result.
 * Phases: starting (beforeRun; frames held) -> running -> closing (afterRun, then done). Busy until done.
 * Each call passes the approval gate (./escalation.ts) before it executes.
 */
import type { Client } from "./client";
import { admitRun } from "./admit";
import { createEscalation, type Escalation, type EscalationOptions } from "./escalation";
import { startCallTimer, type CallTimer } from "./call-timer";
import type {
  CancelFrame,
  DoneFrame,
  Frame,
  RunEndFrame,
  RunFrame,
  ToolCallFrame,
  ToolErrorInfo,
  ToolResult,
} from "../protocol/frames";
import type { Host } from "../host/types";
import type { ToolContext, ToolRegistry } from "../tools/index";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PARALLEL_READS = 4;
const WRITE_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "run_command", "git_commit"]);

export interface RunTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunEndInfo {
  runId: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface AfterRunResult {
  /** Sent before `done`, in order (e.g. the `changes` frame). */
  frames: Frame[];
  /** Added to `done.warning`. */
  warning?: string;
}

export interface RunManagerOptions {
  client: Client;
  registry: ToolRegistry;
  host: Host;
  /** Workspace folders the user allows. The run's cwd and roots must lie inside them. */
  getRoots: () => readonly string[];
  /** Workspace Trust state. Defaults to trusted; the wiring passes the real value. */
  isTrusted?: () => boolean;
  now?: () => number;
  timers?: RunTimers;
  /** After admission, before run_ack: its frames (the `checkpoint`) go out first. */
  beforeRun?: (run: RunFrame) => Promise<Frame[]>;
  /** Before done: its frames (`changes`) go out first; its warning goes into done. */
  afterRun?: (info: RunEndInfo) => Promise<AfterRunResult>;
  /** Approval gate hooks (checkProtected, onPendingChange, ...). Wiring-only overrides. */
  escalation?: Omit<EscalationOptions, "send" | "getRoots" | "getCwd" | "timers" | "realpath">;
}

export interface RunManager {
  /** Consumes S -> E frames. Frames other than run, tool_call, cancel, approval_reply and run_end are ignored. */
  handleFrame(frame: Frame): void;
  /** The run in progress (including closing), or null. */
  activeRunId(): string | null;
  /** Client disconnected: aborts in-flight calls, ends pending approvals, and sends nothing more. */
  dispose(): void;
}

type CallState = "queued" | "running" | "done";

interface Call {
  frame: ToolCallFrame;
  write: boolean;
  state: CallState;
  controller: AbortController;
  timer: CallTimer | null;
}

interface Run {
  runId: string;
  cwd: string;
  roots: string[];
  root: string;
  startedAt: number;
  phase: "starting" | "running" | "closing";
  cancelled: boolean;
  seen: Set<string>;
  /** Unfinished calls in arrival order. */
  calls: Call[];
  /** run_end received; done is sent once `calls` drains. */
  ended: boolean;
}

const defaultTimers: RunTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export { within } from "./admit";

const fail = (code: string, message: string): ToolResult => ({ ok: false, error: { code, message } as ToolErrorInfo });

export function createRunManager(opts: RunManagerOptions): RunManager {
  const { client, registry, host } = opts;
  const timers = opts.timers ?? defaultTimers;
  const now = opts.now ?? Date.now;
  const isTrusted = opts.isTrusted ?? (() => true);
  let run: Run | null = null;
  let disposed = false;

  const escalation: Escalation = createEscalation({
    ...opts.escalation,
    send: (f) => client.send(f),
    getRoots: () => run?.roots ?? [],
    getCwd: () => run?.cwd ?? "",
    realpath: host.realpath?.bind(host),
    timers,
    onWaiting: (callId, waiting) => {
      const call = run?.calls.find((c) => c.frame.callId === callId);
      if (waiting) call?.timer?.pause();
      else call?.timer?.resume();
    },
  });

  const replyTo = (runId: string, callId: string, body: ToolResult): void => {
    client.send({ type: "tool_result", runId, callId, ...body });
  };

  /** Marks a call done and drops it from `calls`. False if it was already done. */
  const retire = (r: Run, call: Call, abort: boolean): boolean => {
    if (call.state === "done") return false;
    call.state = "done";
    call.timer?.stop();
    if (abort) call.controller.abort();
    r.calls = r.calls.filter((c) => c !== call);
    return true;
  };

  /** Runs afterRun, sends its frames then done. The run stays busy until done is sent. */
  const finish = async (r: Run, ok: boolean, error?: string): Promise<void> => {
    if (r.phase === "closing") return;
    r.phase = "closing";
    const info: RunEndInfo = { runId: r.runId, ok, durationMs: now() - r.startedAt };
    if (error !== undefined) info.error = error;
    let after: AfterRunResult = { frames: [] };
    try {
      after = (await opts.afterRun?.(info)) ?? after;
    } catch {
      /* the run still ends; the failure is not reported in the frames */
    }
    if (disposed) return;
    if (run === r) run = null;
    for (const f of after.frames) client.send(f);
    const done: DoneFrame = ok
      ? { type: "done", runId: r.runId, ok: true }
      : { type: "done", runId: r.runId, ok: false, error: error ?? "failed" };
    if (after.warning) done.warning = after.warning;
    client.send(done);
  };

  const start = (r: Run, call: Call): void => {
    call.state = "running";
    const settle = (body: ToolResult): void => {
      if (retire(r, call, false)) {
        replyTo(r.runId, call.frame.callId, body);
        pump(r);
      }
    };
    const execute = (): void => {
      if (call.state === "done") return; // cancelled or timed out while waiting for approval
      const ctx: ToolContext = { host, root: r.root, roots: r.roots, cwd: r.cwd, signal: call.controller.signal };
      registry.execute(call.frame, ctx).then(settle, () => settle(fail("internal", "tool failed unexpectedly")));
    };
    // The gate runs before execution; its approval wait pauses this call's timeout (see onWaiting).
    escalation.gate(call.frame, call.controller.signal).then(
      (v) => (v.allow ? execute() : settle(fail(v.error.code, v.error.message))),
      () => settle(fail("internal", "tool failed unexpectedly")),
    );
  };

  /** Starts queued calls in arrival order while the concurrency rules allow it. */
  const pump = (r: Run): void => {
    if (r.phase !== "running") return;
    for (;;) {
      const next = r.calls.find((c) => c.state === "queued");
      if (!next) break;
      const running = r.calls.filter((c) => c.state === "running");
      const allowed = next.write
        ? running.length === 0
        : running.length < MAX_PARALLEL_READS && !running.some((c) => c.write);
      if (!allowed) break;
      start(r, next);
    }
    if (r.ended && r.calls.length === 0) void finish(r, true);
  };

  const onRun = async (f: RunFrame): Promise<void> => {
    if (run) {
      client.send({ type: "run_ack", runId: f.runId, ok: false, error: "busy" });
      return;
    }
    const admitted = admitRun(f, opts.getRoots(), isTrusted());
    if (!admitted.ok) {
      client.send({ type: "run_ack", runId: f.runId, ok: false, error: admitted.error });
      return;
    }
    const r: Run = {
      runId: f.runId, cwd: f.cwd, roots: [...f.roots], root: admitted.root, startedAt: now(),
      phase: "starting", cancelled: false, seen: new Set(), calls: [], ended: false,
    };
    run = r; // busy from here on, while the hook runs
    let pre: Frame[] = [];
    try {
      pre = (await opts.beforeRun?.(f)) ?? [];
    } catch {
      /* a failed hook must not block the run */
    }
    if (disposed) return;
    for (const frame of pre) client.send(frame);
    client.send({ type: "run_ack", runId: f.runId, ok: true });
    r.phase = "running";
    if (r.cancelled) void finish(r, false, "cancelled");
    else pump(r);
  };

  const onToolCall = (f: ToolCallFrame): void => {
    const r = run;
    if (!r || r.ended || r.phase === "closing" || f.runId !== r.runId) return;
    if (r.seen.has(f.callId)) return replyTo(r.runId, f.callId, fail("invalid_args", "duplicate callId"));
    r.seen.add(f.callId);
    if (!f.approval) return replyTo(r.runId, f.callId, fail("denied", "tool call not approved"));
    const timeoutMs = typeof f.timeoutMs === "number" && f.timeoutMs > 0 ? f.timeoutMs : DEFAULT_TIMEOUT_MS;
    const call: Call = { frame: f, write: WRITE_TOOLS.has(f.tool), state: "queued", controller: new AbortController(), timer: null };
    // Timeout counts from arrival (§2.4), minus any time spent waiting for approval. On expiry only this call fails.
    call.timer = startCallTimer({
      timers,
      now,
      ms: timeoutMs,
      onExpire: () => {
        if (retire(r, call, true)) {
          replyTo(r.runId, f.callId, fail("timeout", "timed out"));
          pump(r);
        }
      },
    });
    r.calls.push(call);
    pump(r);
  };

  const onCancel = (f: CancelFrame): void => {
    const r = run;
    if (!r || f.runId !== r.runId || r.phase === "closing") return;
    r.cancelled = true;
    for (const call of [...r.calls]) {
      if (retire(r, call, true)) replyTo(r.runId, call.frame.callId, fail("cancelled", "cancelled"));
    }
    escalation.cancelAll();
    // While starting, the run is finished once the start frames are out (see onRun).
    if (r.phase === "running") void finish(r, false, "cancelled");
  };

  const onRunEnd = (f: RunEndFrame): void => {
    const r = run;
    if (!r || f.runId !== r.runId) return;
    r.ended = true;
    pump(r);
  };

  return {
    handleFrame(frame) {
      if (disposed) return;
      if (frame.type === "run") void onRun(frame);
      else if (frame.type === "tool_call") onToolCall(frame);
      else if (frame.type === "cancel") onCancel(frame);
      else if (frame.type === "run_end") onRunEnd(frame);
      else if (frame.type === "approval_reply") escalation.handleReply(frame);
    },
    activeRunId() {
      return run ? run.runId : null;
    },
    dispose() {
      disposed = true;
      const r = run;
      run = null;
      if (r) for (const call of [...r.calls]) retire(r, call, true);
      escalation.cancelAll();
    },
  };
}
