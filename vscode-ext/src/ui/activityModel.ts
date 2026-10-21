/**
 * Pure reducer for the activity panel (docs/design/VSCODE-BRIDGE.md §5, THEMES-IMPL.md "段階表示").
 * No `vscode` import. One run is shown at a time: a `runStart` replaces the previous run.
 * Labels are short and masked; tool results are never stored beyond a masked, cut note.
 */

export type RunStatus = "running" | "done" | "error" | "cancelled";
export type StepStatus = "pending" | "running" | "ok" | "error";

export interface ActivityStep {
  callId: string;
  tool: string;
  /** Short human label, e.g. "read src/a.ts" or "run npm test". Secrets masked, cut to LABEL_MAX_CHARS. */
  label: string;
  status: StepStatus;
  durationMs: number | null;
  /** Masked, cut summary of a failed call. Null for successful or unfinished calls. */
  note: string | null;
}

export interface ActivityProgress {
  /** Calls that have finished (ok, error, or closed when the run ended). */
  done: number;
  /** Every call announced in this run, including steps dropped by the cap. */
  total: number;
}

export interface ActivityState {
  runId: string;
  cwd: string;
  mode: string | null;
  status: RunStatus;
  /** Oldest first. Capped at MAX_STEPS. */
  steps: ActivityStep[];
  progress: ActivityProgress;
  /** Id of the last pending approval. Cleared by the next result or by the run end. */
  awaitingApproval: string | null;
}

export type ActivityEvent =
  | { type: "runStart"; runId: string; cwd: string; mode?: string }
  | { type: "toolCall"; callId: string; tool: string; args: unknown }
  | { type: "toolResult"; callId: string; ok: boolean; summary: string; durationMs: number }
  | { type: "approvalPending"; approvalId: string }
  | { type: "runDone"; ok: boolean; error?: string };

export const MAX_STEPS = 200;
export const LABEL_MAX_CHARS = 80;
export const NOTE_MAX_CHARS = 120;

const MASK = "***";

/** Secret-like values: header auth, bearer tokens, `--token=` style flags, and `NAME_TOKEN=` env assignments. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?\S+/gi, `$1${MASK}`],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`],
  [/(--?[\w-]*(?:token|secret|passw(?:or)?d|api[-_]?key|auth)[\w-]*)(=|\s+)\S+/gi, `$1$2${MASK}`],
  [/\b([A-Za-z0-9_]*(?:token|secret|password|api_?key)[A-Za-z0-9_]*)=\S+/gi, `$1=${MASK}`],
];

/** Masks secret-like values. Runs on collapsed text, before any truncation. */
export function maskSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Cuts text to `max` code points, ending with an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function field(args: unknown, key: string): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function words(...parts: (string | null)[]): string {
  return parts.filter((p): p is string => p !== null).join(" ");
}

/** Raw, unmasked label for one tool call. Missing arguments leave just the verb. */
function rawLabel(tool: string, args: unknown): string {
  const path = field(args, "path");
  switch (tool) {
    case "read_file":
      return words("read", path);
    case "list_dir":
      return words("list", path ?? ".");
    case "glob":
      return words("glob", field(args, "pattern"));
    case "grep":
      return words("grep", field(args, "pattern"), path ? `in ${path}` : null);
    case "write_file":
      return words("write", path);
    case "edit_file":
      return words("edit", path);
    case "run_command":
      return words("run", field(args, "command"));
    case "get_diagnostics":
      return words("diagnostics", path);
    case "git_status":
      return "git status";
    case "git_diff":
      return words("git diff", path);
    case "git_log":
      return "git log";
    case "git_commit":
      return words("git commit", field(args, "message"));
    default:
      return words(tool, path);
  }
}

/** Short, masked, single-line label for a tool call. */
export function describeCall(tool: string, args: unknown): string {
  return truncate(maskSecrets(oneLine(rawLabel(tool, args))), LABEL_MAX_CHARS);
}

function noteFor(summary: string): string | null {
  const note = truncate(maskSecrets(oneLine(summary)), NOTE_MAX_CHARS);
  return note === "" ? null : note;
}

function startRun(e: Extract<ActivityEvent, { type: "runStart" }>): ActivityState {
  return {
    runId: e.runId,
    cwd: e.cwd,
    mode: e.mode ?? null,
    status: "running",
    steps: [],
    progress: { done: 0, total: 0 },
    awaitingApproval: null,
  };
}

function addCall(state: ActivityState, e: Extract<ActivityEvent, { type: "toolCall" }>): ActivityState {
  if (state.status !== "running" || state.steps.some((s) => s.callId === e.callId)) return state;
  const step: ActivityStep = {
    callId: e.callId,
    tool: e.tool,
    label: describeCall(e.tool, e.args),
    status: "running",
    durationMs: null,
    note: null,
  };
  const steps = [...state.steps, step];
  if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
  return { ...state, steps, progress: { ...state.progress, total: state.progress.total + 1 } };
}

function finishCall(state: ActivityState, e: Extract<ActivityEvent, { type: "toolResult" }>): ActivityState {
  const index = state.steps.findIndex((s) => s.callId === e.callId);
  if (index < 0) return state;
  const current = state.steps[index];
  if (current.status === "ok" || current.status === "error") return state;
  const duration = Number.isFinite(e.durationMs) && e.durationMs >= 0 ? Math.round(e.durationMs) : null;
  const steps = state.steps.slice();
  steps[index] = {
    ...current,
    status: e.ok ? "ok" : "error",
    durationMs: duration,
    note: e.ok ? null : noteFor(e.summary),
  };
  return {
    ...state,
    steps,
    progress: { ...state.progress, done: state.progress.done + 1 },
    awaitingApproval: null,
  };
}

function endRun(state: ActivityState, e: Extract<ActivityEvent, { type: "runDone" }>): ActivityState {
  if (state.status !== "running") return state;
  const status: RunStatus = e.ok ? "done" : e.error === "cancelled" ? "cancelled" : "error";
  let closed = 0;
  // Calls still open when the run ends are closed as errors, so no row keeps spinning.
  const steps = state.steps.map((s): ActivityStep => {
    if (s.status !== "running" && s.status !== "pending") return s;
    closed += 1;
    return { ...s, status: "error" };
  });
  return {
    ...state,
    status,
    steps,
    progress: { ...state.progress, done: state.progress.done + closed },
    awaitingApproval: null,
  };
}

/**
 * Applies one event. Returns the same object when the event changes nothing (unknown call ids,
 * events before a run starts, events after it ended), so callers can detect changes by identity.
 */
export function reduce(state: ActivityState | null, event: ActivityEvent): ActivityState | null {
  if (event.type === "runStart") return startRun(event);
  if (state === null) return null;
  switch (event.type) {
    case "toolCall":
      return addCall(state, event);
    case "toolResult":
      return finishCall(state, event);
    case "approvalPending":
      return state.status === "running" ? { ...state, awaitingApproval: event.approvalId } : state;
    case "runDone":
      return endRun(state, event);
  }
}
