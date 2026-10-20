import { spawn, execFile, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";

export type DshEvent = Record<string, unknown> & { type?: string };

/** Incremental NDJSON parser: tolerates partial lines across chunks, multibyte splits, and non-JSON lines. */
export class NdjsonParser {
  private decoder = new StringDecoder("utf8");
  private buf = "";

  push(chunk: Buffer | string): DshEvent[] {
    this.buf += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  end(): DshEvent[] {
    this.buf += this.decoder.end();
    return this.drain(true);
  }

  private drain(flush: boolean): DshEvent[] {
    const out: DshEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const ev = parseLine(line);
      if (ev) out.push(ev);
    }
    if (flush && this.buf) {
      const ev = parseLine(this.buf);
      this.buf = "";
      if (ev) out.push(ev);
    }
    return out;
  }
}

export function parseLine(line: string): DshEvent | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as DshEvent) : null;
  } catch {
    return null;
  }
}

export interface DshRunOptions {
  appDir: string;
  profile: string;
  patch?: string | null;
  /** Per-run model overlay; passed as an extra --patch AFTER `patch` (later wins). */
  modelPatch?: string | null;
  sessionId?: string | null;
  cwd: string;
  prompt: string;
  /** Internal/testing: replace the executable (default: `<appDir>\DeepSeek Harness.exe`). */
  command?: string;
  /** Internal/testing: args placed before the dsh args (default: --expose-internals <cli.js>). */
  commandArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface DshResult {
  code: number | null;
  stderrTail: string;
  cancelled: boolean;
}

const STDERR_MAX = 4000;

export function defaultAppDir(): string {
  const base = process.env.LOCALAPPDATA ?? "";
  return path.join(base, "Programs", "DeepSeek Harness");
}

export function buildCommand(o: DshRunOptions): { command: string; args: string[] } {
  const command = o.command ?? path.join(o.appDir, "DeepSeek Harness.exe");
  const lead =
    o.commandArgs ??
    [
      "--expose-internals",
      path.join(o.appDir, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"),
    ];
  const args = [...lead, "--profile", o.profile];
  if (o.patch) args.push("--patch", o.patch);
  if (o.modelPatch) args.push("--patch", o.modelPatch);
  args.push("--json");
  if (o.sessionId) args.push("--session-id", o.sessionId);
  args.push("-");
  return { command, args };
}

export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
      try { child.kill(); } catch { /* ignore */ }
    });
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  }
}

export class DshRun implements AsyncIterable<DshEvent> {
  readonly done: Promise<DshResult>;
  private queue: DshEvent[] = [];
  private waiters: Array<() => void> = [];
  private finished = false;
  private cancelled = false;
  private stderr = "";
  private child: ChildProcess | null = null;

  constructor(opts: DshRunOptions) {
    const { command, args } = buildCommand(opts);
    this.done = new Promise<DshResult>((resolve) => {
      const finish = (code: number | null) => {
        if (this.finished) return;
        for (const ev of parser.end()) this.queue.push(ev);
        this.finished = true;
        this.wake();
        resolve({ code, stderrTail: this.stderr.trim(), cancelled: this.cancelled });
      };
      const parser = new NdjsonParser();
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        this.stderr = `spawn failed: ${(e as Error).message}`;
        queueMicrotask(() => finish(-1));
        return;
      }
      this.child = child;
      const errDec = new StringDecoder("utf8");
      child.stdout!.on("data", (c: Buffer) => {
        for (const ev of parser.push(c)) this.queue.push(ev);
        this.wake();
      });
      child.stderr!.on("data", (c: Buffer) => {
        this.stderr += errDec.write(c);
        if (this.stderr.length > STDERR_MAX) this.stderr = this.stderr.slice(-STDERR_MAX);
      });
      child.stdin!.on("error", () => { /* process may exit before reading */ });
      child.on("error", (e) => {
        this.stderr += `${this.stderr ? "\n" : ""}spawn error: ${e.message}`;
        finish(-1);
      });
      child.on("close", (code) => finish(code));
      child.stdin!.end(opts.prompt, "utf8");
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    if (this.child) killTree(this.child);
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DshEvent> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.finished) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

export function runDsh(opts: DshRunOptions): DshRun {
  return new DshRun(opts);
}
