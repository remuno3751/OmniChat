/**
 * Tool registry and dispatch (spec: docs/design/VSCODE-BRIDGE.md §3 and §9).
 *
 * `execute` validates args, runs the registered handler, maps failures to the
 * `{code, message, details?}` error shape, and enforces the 256 KB result cap.
 * Stack traces and absolute paths never appear in error messages produced here.
 */
import type { ToolCall, ToolName, ToolResult } from "../protocol/frames";
import type { Host } from "../host/types";
import { isToolName, validateArgs, type ToolArgsMap } from "./schemas";
import { TOOL_RESULT_MAX_BYTES, truncateHeadTail } from "./limits";

/** Error codes from spec §3 (`エラー形`). */
export type ToolErrorCode =
  | "invalid_args"
  | "not_found"
  | "not_unique"
  | "dirty_editor"
  | "outside_workspace"
  | "protected_path"
  | "denied"
  | "cancelled"
  | "timeout"
  | "too_large"
  | "binary_file"
  | "io_error"
  | "not_git"
  | "git_failed"
  | "unsupported"
  | "internal";

/** The error shape `{code, message, details?}`. */
export interface ToolErrorBody {
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

/** Throwable form of {@link ToolErrorBody}. Handlers throw this to fail a call. */
export class ToolError extends Error implements ToolErrorBody {
  readonly code: ToolErrorCode;
  readonly details?: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Builds a {@link ToolError}; throw the result. */
export function toolError(code: ToolErrorCode, message: string, details?: unknown): ToolError {
  return new ToolError(code, message, details);
}

/** Per-call context handed to every handler. */
export interface ToolContext {
  host: Host;
  /** The run's primary root (absolute). */
  root: string;
  /** All roots of the run (absolute). */
  roots: string[];
  signal: AbortSignal;
  /** The run's working directory (absolute). */
  cwd: string;
  /** The server allowed outside-workspace access for this call (`approval.outsideOk`). */
  allowOutside?: boolean;
}

/** A tool implementation. Args are already validated and defaulted. */
export type ToolHandler<N extends ToolName = ToolName> = (
  args: ToolArgsMap[N],
  ctx: ToolContext,
) => Promise<unknown>;

export interface ToolRegistry {
  /** Registers (or replaces) the handler for `name`. */
  register<N extends ToolName>(name: N, handler: ToolHandler<N>): void;
  /**
   * Runs one tool call. Never rejects: every failure becomes `{ok:false, error}`.
   */
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

type ErrorInfo = ToolErrorBody;

const encoder = new TextEncoder();

/** Serialized size in bytes; `undefined` (no JSON form) counts as `null`. */
function byteSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "null").length;
}

/**
 * Shrinks `value` until its serialized form fits `TOOL_RESULT_MAX_BYTES`.
 * Repeatedly halves the largest top-level string or array. Returns `null`
 * when it still does not fit (for example, a deeply nested payload).
 */
export function capResult(value: unknown): { value: unknown; truncated: boolean } | null {
  if (byteSize(value) <= TOOL_RESULT_MAX_BYTES) return { value, truncated: false };

  const isObj = typeof value === "object" && value !== null && !Array.isArray(value);
  let cur: unknown = isObj ? { ...(value as Record<string, unknown>) } : value;

  const shrinkField = (v: unknown): unknown => {
    if (typeof v === "string") return truncateHeadTail(v, Math.floor(v.length / 2));
    if (Array.isArray(v)) return v.slice(0, Math.floor(v.length / 2));
    return undefined;
  };

  for (let i = 0; i < 64 && byteSize(cur) > TOOL_RESULT_MAX_BYTES; i++) {
    if (!isObj) {
      const next = shrinkField(cur);
      if (next === undefined) break;
      cur = next;
      continue;
    }
    const obj = cur as Record<string, unknown>;
    let bestKey: string | undefined;
    let bestSize = -1;
    for (const key of Object.keys(obj)) {
      const size = byteSize(obj[key]);
      if (size > bestSize) {
        bestSize = size;
        bestKey = key;
      }
    }
    if (bestKey === undefined) break;
    const shrunk = shrinkField(obj[bestKey]);
    if (shrunk === undefined) break;
    obj[bestKey] = shrunk;
  }

  if (byteSize(cur) > TOOL_RESULT_MAX_BYTES) return null;
  if (isObj && "truncated" in (cur as object)) {
    (cur as Record<string, unknown>)["truncated"] = true;
  }
  return { value: cur, truncated: true };
}

function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof ToolError) {
    const info: ErrorInfo = { code: err.code, message: err.message };
    if (err.details !== undefined) info.details = err.details;
    return info;
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "AbortError") return { code: "cancelled", message: "cancelled" };
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return { code: "not_found", message: "not found" };
  // Anything else is an unexpected failure. Never expose the raw message or stack.
  return { code: "io_error", message: "tool failed unexpectedly" };
}

export function createRegistry(): ToolRegistry {
  const handlers = new Map<ToolName, ToolHandler>();

  return {
    register(name, handler) {
      handlers.set(name, handler as unknown as ToolHandler);
    },

    async execute(call, ctx) {
      const started = Date.now();
      const failed = (error: ErrorInfo): ToolResult => ({ ok: false, error });

      if (!isToolName(call.tool)) {
        return failed({ code: "unsupported", message: "unknown tool" });
      }
      const handler = handlers.get(call.tool);
      if (!handler) {
        return failed({ code: "unsupported", message: "tool not available" });
      }
      if (ctx.signal.aborted) {
        return failed({ code: "cancelled", message: "cancelled" });
      }

      const validated = validateArgs(call.tool, call.args);
      if (!validated.ok) {
        return failed({ code: "invalid_args", message: validated.error });
      }

      let raw: unknown;
      try {
        raw = await handler(validated.args as never, ctx);
      } catch (err) {
        return failed(toErrorInfo(err));
      }

      const capped = capResult(raw);
      if (!capped) {
        return failed({ code: "too_large", message: "result exceeds 256 KB" });
      }
      return {
        ok: true,
        result: capped.value,
        truncated: capped.truncated,
        durationMs: Date.now() - started,
      };
    },
  };
}
