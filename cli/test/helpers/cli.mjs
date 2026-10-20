// Test helpers: run the real bin as a child process, or run main() in-process with injected terminal/IO.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { main } from "../../src/main.mjs";

export const BIN = fileURLToPath(new URL("../../bin/omnichat.mjs", import.meta.url));

/** A fresh HOME-like directory with its own config file path. */
export function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omnichat-cli-test-"));
  return { home, configPath: path.join(home, "config.json") };
}

export function writeConfig(configPath, obj) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2));
}

export function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/** Run the CLI binary as a child process. stdin is piped (never a TTY). */
export function runCli(args, { env = {}, input = "", configPath, home, timeoutMs = 30000, inheritEnv = false } = {}) {
  const base = inheritEnv
    ? { ...process.env }
    : { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SYSTEMROOT: process.env.SYSTEMROOT };
  const childEnv = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home ?? os.tmpdir(), "AppData"),
    OMNICHAT_CONFIG: configPath,
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: omnichat ${args.join(" ")}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Write-only sink that collects text. */
function sink() {
  let text = "";
  return { write(s) { text += String(s); return true; }, get text() { return text; } };
}

/**
 * Run main() in-process. Options: env, input (stdin text), isTTY (stdin and stdout/stderr TTY flags),
 * ask (answers for prompts: function(question) -> string), fetch/WebSocket default to globals.
 * Returns { code, stdout, stderr, fireSigint(), stdinTTY }.
 */
export async function runInProcess(args, opts = {}) {
  const h = startInProcess(args, opts);
  return h.done;
}

/** Like runInProcess, but returns immediately: { done: Promise<result>, fireSigint(), stdout(), stderr() }. */
export function startInProcess(args, { env = {}, input = "", isTTY = false, ask, configPath, home } = {}) {
  const stdout = sink();
  const stderr = sink();
  const handlers = new Set();
  const stdin = Readable.from(input ? [input] : []);
  const io = {
    stdin,
    stdout,
    stderr,
    stdinIsTTY: isTTY,
    stdoutIsTTY: isTTY,
    stderrIsTTY: isTTY,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    ask,
    onSigint(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
  };
  const childEnv = { HOME: home, USERPROFILE: home, APPDATA: path.join(home ?? os.tmpdir(), "AppData"), OMNICHAT_CONFIG: configPath, ...env };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  const done = main(args, { env: childEnv, io }).then((code) => ({
    code,
    stdout: stdout.text,
    stderr: stderr.text,
  }));
  return {
    done,
    stdout: () => stdout.text,
    stderr: () => stderr.text,
    fireSigint: () => { for (const h of [...handlers]) h(); },
  };
}

export const hasSigintOnWindows = process.platform === "win32";
