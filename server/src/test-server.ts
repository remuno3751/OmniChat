// Test helper (S1): spawns the server as a child process on a random port.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => res(p)); });
  });
}

export interface TestServer { base: string; port: number; tmp: string; child: ChildProcess; stop(): void }

export async function startServer(env: Record<string, string> = {}, tmp = mkdtempSync(join(tmpdir(), "omni-s1-"))): Promise<TestServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { windowsHide: true,
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: tmp, DB_PATH: join(tmp, "t.db"), WEB_DIR: join(tmp, "no-web"), AUTO_TITLE_DEFAULT: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res, rej) => {
    child.stdout!.on("data", (d) => { if (String(d).includes("listening")) res(); });
    child.once("exit", () => rej(new Error("server exited")));
  });
  return { base: `http://127.0.0.1:${port}`, port, tmp, child, stop() {
    // Windows keeps the SQLite files locked until the process is gone: remove the folder after the exit, with retries
    const clean = () => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* ignore */ } };
    if (child.exitCode !== null || child.signalCode !== null) clean();
    else { child.once("exit", clean); child.kill(); }
  } };
}

export async function api(base: string, method: string, path: string, body?: unknown, tok = "", extra: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

export function openWs(url: string): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    // The server sends its first frame right after the upgrade; it can arrive in the same TCP chunk as the
    // handshake response, i.e. before the caller had a chance to attach "message". Hold the early frames and hand
    // them, in order and exactly once, to the FIRST "message" listener the caller attaches (frames that arrive later
    // reach listeners live, so nothing is delivered twice).
    const early: Array<[WebSocket.RawData, boolean]> = [];
    let attached = false;
    const hold = (d: WebSocket.RawData, b: boolean) => { if (!attached) early.push([d, b]); };
    ws.on("message", hold);
    const anyWs = ws as any;
    for (const name of ["on", "addListener", "once"] as const) {
      const orig = anyWs[name].bind(ws);
      anyWs[name] = (ev: string, fn: (...a: any[]) => void) => {
        const r = orig(ev, fn);
        if (ev === "message" && fn !== hold && !attached) {
          attached = true;
          if (name === "once") {
            // a once-listener takes only the oldest early frame, the rest stay for later listeners
            const first = early.shift();
            if (first) { ws.off("message", fn); fn.call(ws, first[0], first[1]); }
            attached = false; // keep collecting for the next listener
          } else {
            for (const [d, b] of early) fn.call(ws, d, b);
            early.length = 0;
          }
        }
        return r;
      };
    }
    ws.once("open", () => res(ws));
    ws.once("error", rej);
    ws.once("unexpected-response", (_q, resp) => rej(new Error("HTTP " + resp.statusCode)));
  });
}
