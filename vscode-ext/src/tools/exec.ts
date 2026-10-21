/**
 * run_command implementation (spec: docs/design/VSCODE-BRIDGE.md §3 "run_command の実行",
 * and §2.4 for cancel / timeout semantics).
 *
 * Shell: `$SHELL -c` (fallback /bin/sh) on POSIX, `cmd.exe /d /s /c` on Windows.
 * The process tree is killed on timeout or cancel: SIGTERM to the process group,
 * then SIGKILL after a grace period (POSIX), or `taskkill /T /F` (Windows).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolveInWorkspace, type PathRefusalReason } from "../guard/paths";
import { toolError, type ToolContext, type ToolRegistry } from "./index";
import {
  RUN_COMMAND_OUTPUT_HEAD_BYTES,
  RUN_COMMAND_OUTPUT_MAX_BYTES,
  RUN_COMMAND_OUTPUT_TAIL_BYTES,
} from "./limits";
import type { RunCommandArgs } from "./schemas";

/** Environment variable names removed before spawning (case-insensitive). */
const DROP_ENV: readonly RegExp[] = [/TOKEN/i, /SECRET/i, /KEY/i, /PASSWORD/i, /^OMNICHAT_/i];
const DEFAULT_KILL_GRACE_MS = 2000;

export interface ExecOptions {
  /** Overrides the shell program (spec setting `omnichat.shell`). */
  shell?: string;
  /** Delay between SIGTERM and SIGKILL on POSIX. Default 2000 ms. */
  killGraceMs?: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  /** True when the extension's own `timeoutMs` expired and the tree was killed. */
  timedOut: boolean;
  truncated: boolean;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Copies `src` without secret-looking variables, then adds the fixed extras. */
export function scrubEnv(src: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (DROP_ENV.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  env.TERM = "dumb";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PAGER = "cat";
  return env;
}

/**
 * Resolves `requested` (or the run's cwd when omitted) to an absolute path inside
 * one of the run's roots. Relative values are taken relative to a root.
 */
export async function resolveCwd(ctx: ToolContext, requested?: string): Promise<string> {
  const roots = ctx.roots.length > 0 ? ctx.roots : [ctx.root];
  const input = requested ?? ctx.cwd;
  let refusal: { reason: PathRefusalReason; message: string } | undefined;
  for (const root of roots) {
    const r = await resolveInWorkspace(root, input, (p) => realpath(p));
    if (r.ok) return r.abs;
    refusal ??= r;
  }
  if (!refusal) throw toolError("outside_workspace", "path is outside the workspace");
  throw toolError(refusal.reason, refusal.message);
}

function invocation(command: string, shell?: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: shell ?? "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] };
  }
  return { file: shell ?? (process.env.SHELL || "/bin/sh"), args: ["-c", command] };
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** Kills the whole process tree. Idempotent. */
function killTree(child: ChildProcess, graceMs: number): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  signalGroup(pid, "SIGTERM");
  setTimeout(() => signalGroup(pid, "SIGKILL"), graceMs).unref();
}

const HEAD_BYTES = RUN_COMMAND_OUTPUT_HEAD_BYTES;
const TAIL_BYTES = RUN_COMMAND_OUTPUT_TAIL_BYTES;

/**
 * Bounded per-stream capture: keeps the first HEAD_BYTES and the last TAIL_BYTES,
 * plus the total byte count, so memory stays bounded for very large output.
 */
class Capture {
  private readonly head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headLen < HEAD_BYTES) {
      const take = Math.min(HEAD_BYTES - this.headLen, rest.length);
      this.head.push(rest.subarray(0, take));
      this.headLen += take;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      this.tail.push(rest);
      this.tailLen += rest.length;
      if (this.tailLen > 2 * TAIL_BYTES) this.compactTail();
    }
  }

  private compactTail(): void {
    const all = Buffer.concat(this.tail);
    const keep = all.subarray(Math.max(0, all.length - TAIL_BYTES));
    this.tail = [keep];
    this.tailLen = keep.length;
  }

  result(): { text: string; truncated: boolean } {
    const headBuf = Buffer.concat(this.head);
    if (this.total <= RUN_COMMAND_OUTPUT_MAX_BYTES) {
      return { text: Buffer.concat([headBuf, ...this.tail]).toString("utf8"), truncated: false };
    }
    this.compactTail();
    const omitted = this.total - headBuf.length - TAIL_BYTES;
    const tailText = Buffer.concat(this.tail).toString("utf8");
    return {
      text: `${headBuf.toString("utf8")}\n... [${omitted} bytes omitted]\n${tailText}`,
      truncated: true,
    };
  }
}

/**
 * Runs `args.command` in a shell. Resolves with the exit status and captured output.
 * A `timeoutMs` expiry kills the tree and resolves with `timedOut: true`.
 * An abort via `ctx.signal` kills the tree and rejects with code `cancelled`.
 */
export async function runCommand(
  args: RunCommandArgs,
  ctx: ToolContext,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const cwd = await resolveCwd(ctx, args.cwd);
  if (ctx.signal.aborted) throw toolError("cancelled", "cancelled");

  const posix = process.platform !== "win32";
  const inv = invocation(args.command, opts.shell);
  const child = spawn(inv.file, inv.args, {
    cwd,
    env: scrubEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    detached: posix,
    windowsHide: true,
    windowsVerbatimArguments: !posix,
  });
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const out = new Capture();
  const err = new Capture();
  child.stdout?.on("data", (c: Buffer) => out.push(c));
  child.stderr?.on("data", (c: Buffer) => err.push(c));

  let timedOut = false;
  let cancelled = false;
  const exit = await new Promise<ExitInfo>((resolve, reject) => {
    let exitInfo: ExitInfo | undefined;
    let backstop: NodeJS.Timeout | undefined;
    let stopped = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, args.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(backstop);
      ctx.signal.removeEventListener("abort", onAbort);
    };
    const finish = (info: ExitInfo): void => {
      cleanup();
      resolve(info);
    };
    // After a kill, do not wait forever for stdio to close (a grandchild may
    // have escaped the group). Fall back to the exit event, if any, after a delay.
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      killTree(child, graceMs);
      backstop = setTimeout(() => finish(exitInfo ?? { code: null, signal: null }), graceMs + 1000);
    };

    child.once("error", (e) => {
      cleanup();
      reject(e);
    });
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
    });
    child.once("close", (code, signal) => finish({ code, signal }));
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  if (cancelled) throw toolError("cancelled", "cancelled");
  const o = out.result();
  const e = err.result();
  const res: ExecResult = {
    exitCode: exit.code,
    stdout: o.text,
    stderr: e.text,
    timedOut,
    truncated: o.truncated || e.truncated,
  };
  if (exit.signal) res.signal = exit.signal;
  return res;
}

/** Registers the `run_command` handler on `registry`. */
export function registerExecTool(registry: ToolRegistry, opts: ExecOptions = {}): void {
  registry.register("run_command", (args, ctx) => runCommand(args, ctx, opts));
}
