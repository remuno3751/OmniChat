import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginIsolation } from "./tools/types.js";

/* Stage 2 of docs/design/PLUGIN-INSTALL.md section 5: plugin tools run in a separate Node child process.
 *
 * What the child gets (measured on Node 24, see the design doc):
 *  - `--permission` with fs read only on the plugin folder (and this host file). Writes, child processes, worker
 *    threads and native addons are denied by the permission model.
 *  - NOT enforced by the permission model: direct network (net, http, fetch, dns are all allowed). That is why
 *    `ctx.fetch` is proxied here: the parent resolves DNS, refuses blocked addresses and re-checks every redirect.
 *    A malicious plugin can still open its own sockets. The UI must say so.
 *  - an empty environment (no server secrets).
 *  - `--max-old-space-size` (PLUGIN_MEMORY_MB, default 256).
 *
 * Protocol (JSON over the IPC channel):
 *  parent -> child: {t:"call",id,tool,args,userId,network} | {t:"abort",id} | {t:"fetch-res",rid,ok,...}
 *  child -> parent: {t:"result",id,ok,text|error} | {t:"log",id,msg} | {t:"fetch",rid,id,url,method,headers,body,redirect}
 */

export const isolationMode = (): "process" | "inproc" | "process-all" => {
  const v = (process.env.PLUGIN_ISOLATION ?? "process").trim();
  if (v === "inproc" || v === "process-all") return v;
  if (v !== "process") console.warn(`PLUGIN_ISOLATION="${v}" is not one of process | inproc | process-all; using process`);
  return "process";
};

/** Decides where one plugin runs. `installed` = it has a plugin_installs row (installed through the admin flow). */
export function isolationFor(installed: boolean): PluginIsolation {
  const m = isolationMode();
  if (m === "inproc") return "inproc";
  if (m === "process-all") return "process";
  return installed ? "process" : "inproc";
}

const memoryMb = (): number => {
  const n = Number(process.env.PLUGIN_MEMORY_MB ?? 256);
  return Number.isFinite(n) && n >= 32 ? Math.floor(n) : 256;
};
const idleMs = (): number => {
  const n = Number(process.env.PLUGIN_IDLE_MINUTES ?? 5);
  return Number.isFinite(n) && n > 0 ? n * 60_000 : 5 * 60_000;
};
const ABORT_GRACE_MS = 1000; // a call that ignores its abort signal gets the child killed after this
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TEXT_LOG_CAP = 500;

/* ---------------- address block list (ctx.fetch) ---------------- */

function blockedV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 // 0.0.0.0/8
    || a === 10 // private
    || a === 127 // loopback
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, includes cloud metadata 169.254.169.254
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 168) // private
    || (a === 192 && b === 0) // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224; // multicast, reserved, broadcast
}

/** Parses an IPv6 address (with optional embedded IPv4 tail) into eight 16-bit groups, or null. */
function expandV6(input: string): number[] | null {
  let s = input;
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const o = s.slice(i + 1).split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !(n >= 0 && n <= 255))) return null;
    s = `${s.slice(0, i + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.some((n) => !(n >= 0 && n <= 0xffff)) ? null : nums;
}

/** True when a connection to this address must be refused for ctx.fetch (private, loopback, link-local, metadata, ...). */
export function isBlockedAddress(raw: string): boolean {
  const addr = raw.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const v = isIP(addr);
  if (v === 4) return blockedV4(addr);
  if (v !== 6) return true;
  const p = expandV6(addr);
  if (!p) return true;
  const v4 = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  if (p.slice(0, 5).every((x) => x === 0) && p[5] === 0xffff) return blockedV4(v4(p[6], p[7])); // ::ffff:a.b.c.d
  if (p.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, deprecated ::a.b.c.d
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) return blockedV4(v4(p[6], p[7])); // NAT64
  if (p[0] === 0x2002) return blockedV4(v4(p[1], p[2])); // 6to4
  if ((p[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((p[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((p[0] & 0xffc0) === 0xfec0) return true; // site-local (deprecated) fec0::/10
  if ((p[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Test-only escape hatch: PLUGIN_FETCH_ALLOW_PRIVATE=1 lets ctx.fetch reach LOOPBACK only (the test server).
 * LAN, link-local and metadata addresses stay blocked, and DNS is still checked. Never set this in production. */
const allowLoopback = (): boolean => process.env.PLUGIN_FETCH_ALLOW_PRIVATE === "1";
const isLoopbackAddr = (raw: string): boolean => {
  const a = raw.replace(/^[|]$/g, "").split("%")[0].toLowerCase();
  return /^127./.test(a) || a === "::1" || a === "0:0:0:0:0:0:0:1";
};
const blockedFor = (addr: string): boolean => isBlockedAddress(addr) && !(allowLoopback() && isLoopbackAddr(addr));

/** DNS lookup used for ctx.fetch: resolves, refuses if ANY address is blocked, and pins the connection to the checked address. */
function checkedLookup(hostname: string, opts: any, cb: (...a: any[]) => void): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => blockedFor(a.address));
    if (bad) return cb(Object.assign(new Error(`ctx.fetch: address ${bad.address} is not allowed for plugins`), { code: "EPLUGINADDR" }));
    if (!addrs.length) return cb(new Error("ctx.fetch: no address"));
    if (opts?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

export interface FetchReq { url: string; method: string; headers: [string, string][]; body: string | null; redirect: string }
export interface FetchRes { ok: true; status: number; statusText: string; headers: [string, string][]; body: string | null }

function requestOnce(u: URL, method: string, headers: [string, string][], body: Buffer | null): Promise<FetchRes> {
  return new Promise((resolve, reject) => {
    const h = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(h) && blockedFor(h)) {
      reject(Object.assign(new Error(`ctx.fetch: address ${h} is not allowed for plugins`), { code: "EPLUGINADDR" }));
      return;
    }
    const mk = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = mk(u, {
      method,
      headers: Object.fromEntries(headers),
      agent: false,
      lookup: checkedLookup as any,
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > FETCH_MAX_BYTES) { req.destroy(new Error("ctx.fetch: response too large")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const out: [string, string][] = [];
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const x of Array.isArray(v) ? v : [v]) out.push([k, String(x)]);
        }
        resolve({ ok: true, status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: out,
          body: chunks.length ? Buffer.concat(chunks).toString("base64") : null });
      });
      res.on("error", reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("ctx.fetch: timed out")));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

/** Parent side of ctx.fetch: http/https only, every hop re-checked, bounded time and size. */
export async function proxyFetch(r: FetchReq): Promise<FetchRes> {
  let url: URL;
  try { url = new URL(r.url); } catch { throw new Error("ctx.fetch: invalid URL"); }
  let method = r.method;
  let body = r.body ? Buffer.from(r.body, "base64") : null;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("ctx.fetch: only http and https are allowed");
    const res = await requestOnce(url, method, r.headers, body);
    const loc = res.headers.find(([k]) => k.toLowerCase() === "location")?.[1];
    const redirects = [301, 302, 303, 307, 308].includes(res.status);
    if (!redirects || !loc || r.redirect === "manual") return res;
    if (r.redirect === "error") throw new Error("ctx.fetch: redirect not allowed");
    if (hop >= MAX_REDIRECTS) throw new Error("ctx.fetch: too many redirects");
    url = new URL(loc, url);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = null; }
  }
}

/* ---------------- child process management ---------------- */

interface Pend {
  network: boolean;
  log: (m: string) => void;
  resolve: (t: string) => void;
  reject: (e: Error) => void;
  grace?: NodeJS.Timeout;
  onAbort: () => void;
  signal: AbortSignal;
}

class PluginHost {
  child: ChildProcess | null = null;
  pending = new Map<number, Pend>();
  idle?: NodeJS.Timeout;
  spawns = 0;
  constructor(readonly pluginId: string, readonly dir: string, readonly main: string) {}
}

const hosts = new Map<string, PluginHost>();
let seq = 0;

/** The child entry file: next to this module (src/) or in ../src when this runs from dist/. */
export function hostScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "plugin-host.mjs"), join(here, "..", "src", "plugin-host.mjs")]) {
    if (existsSync(p)) return resolve(p);
  }
  throw new Error("plugin-host.mjs not found");
}

function clearIdle(h: PluginHost): void {
  if (h.idle) clearTimeout(h.idle);
  h.idle = undefined;
}

function armIdle(h: PluginHost): void {
  clearIdle(h);
  if (!h.child || h.pending.size) return;
  h.idle = setTimeout(() => { if (!h.pending.size) killHost(h, "idle"); }, idleMs());
  h.idle.unref();
}

function settle(h: PluginHost, id: number): Pend | undefined {
  const p = h.pending.get(id);
  if (!p) return undefined;
  h.pending.delete(id);
  if (p.grace) clearTimeout(p.grace);
  p.signal.removeEventListener("abort", p.onAbort);
  return p;
}

function rejectAll(h: PluginHost, reason: string): void {
  for (const id of [...h.pending.keys()]) {
    const p = settle(h, id);
    p?.reject(new Error(reason));
  }
}

/** Kills the child (if any). Pending calls fail with `reason`. The next call starts a new child. */
export function killHost(h: PluginHost, reason: string): void {
  const c = h.child;
  h.child = null;
  clearIdle(h);
  if (c) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  rejectAll(h, `plugin stopped: ${reason}`);
}

function answerFetch(h: PluginHost, child: ChildProcess, rid: number, id: number, req: FetchReq): void {
  const reply = (m: object) => { try { child.send(m as any); } catch { /* gone */ } };
  const p = h.pending.get(id);
  if (!p || !p.network) {
    reply({ t: "fetch-res", rid, ok: false, error: "ctx.fetch requires the network permission" });
    return;
  }
  proxyFetch(req).then(
    (res) => reply({ t: "fetch-res", rid, ...res }),
    (e) => reply({ t: "fetch-res", rid, ok: false, error: String(e?.message ?? e).slice(0, 300) }),
  );
}

function onChildMessage(h: PluginHost, child: ChildProcess, m: any): void {
  if (!m || typeof m !== "object") return;
  if (m.t === "result") {
    const p = settle(h, m.id);
    if (!p) return;
    if (m.ok) p.resolve(String(m.text ?? "")); else p.reject(new Error(String(m.error ?? "tool failed")));
    armIdle(h);
  } else if (m.t === "log") {
    h.pending.get(m.id)?.log(String(m.msg ?? ""));
  } else if (m.t === "fetch") {
    answerFetch(h, child, Number(m.rid), Number(m.id), {
      url: String(m.url), method: String(m.method ?? "GET"), headers: Array.isArray(m.headers) ? m.headers : [],
      body: typeof m.body === "string" ? m.body : null, redirect: String(m.redirect ?? "follow"),
    });
  }
}

function spawnChild(h: PluginHost): ChildProcess {
  const host = hostScript();
  const args = [
    "--permission",
    `--allow-fs-read=${host}`,
    `--allow-fs-read=${h.dir}`,
    `--allow-fs-read=${join(h.dir, "*")}`,
    `--max-old-space-size=${memoryMb()}`,
    host,
    h.main,
  ];
  // empty environment: server secrets (API keys, tokens) are never inherited
  const child = spawn(process.execPath, args, { cwd: h.dir, env: {}, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  h.spawns++;
  const tag = `[plugin:${h.pluginId}]`;
  const out = (name: string) => (chunk: Buffer) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) console.log(`${tag} ${name}: ${line.slice(0, TEXT_LOG_CAP)}`);
  };
  child.stdout?.on("data", out("stdout"));
  child.stderr?.on("data", out("stderr"));
  child.on("message", (m) => onChildMessage(h, child, m));
  const gone = (why: string) => {
    // an old child killed by killHost reports its exit later: by then the pending calls may belong to the next child
    if (h.child !== child) return;
    h.child = null;
    clearIdle(h);
    rejectAll(h, why);
  };
  child.on("exit", (code, signal) => gone(`plugin process exited (${signal ?? `code ${code}`})`));
  child.on("error", (e) => gone(`plugin process error: ${e.message}`));
  child.unref();
  child.channel?.unref();
  h.child = child;
  return child;
}

const hostFor = (pluginId: string, dir: string, main: string): PluginHost => {
  let h = hosts.get(pluginId);
  if (h && (h.dir !== dir || h.main !== main)) { killHost(h, "plugin changed"); h = undefined; }
  if (!h) { h = new PluginHost(pluginId, dir, main); hosts.set(pluginId, h); }
  return h;
};

export interface IsolatedCall {
  pluginId: string;
  /** absolute plugin folder and absolute main file */
  dir: string;
  main: string;
  tool: string;
  args: unknown;
  network: boolean;
  userId: string;
  signal: AbortSignal;
  log: (msg: string) => void;
}

/** Runs one tool call in the plugin's child process. Rejects with an Error on failure, crash, abort or stop. */
export function callIsolated(c: IsolatedCall): Promise<string> {
  return new Promise<string>((resolveCall, rejectCall) => {
    if (c.signal.aborted) { rejectCall(new Error("stopped")); return; }
    const h = hostFor(c.pluginId, c.dir, c.main);
    let child: ChildProcess;
    try {
      clearIdle(h);
      child = h.child ?? spawnChild(h);
    } catch (e: any) {
      rejectCall(new Error(`plugin process could not start: ${e?.message ?? e}`));
      return;
    }
    const id = ++seq;
    const onAbort = () => {
      // ask nicely first; a call that does not stop within the grace period takes the process down with it
      try { child.send({ t: "abort", id }); } catch { /* gone */ }
      const p = h.pending.get(id);
      if (p && !p.grace) p.grace = setTimeout(() => killHost(h, "call aborted or timed out"), ABORT_GRACE_MS);
    };
    h.pending.set(id, {
      network: c.network,
      log: c.log,
      signal: c.signal,
      onAbort,
      resolve: resolveCall,
      reject: rejectCall,
    });
    c.signal.addEventListener("abort", onAbort, { once: true });
    try {
      child.send({ t: "call", id, tool: c.tool, args: c.args ?? null, userId: c.userId, network: c.network });
    } catch (e: any) {
      settle(h, id)?.reject(new Error(`plugin process unavailable: ${e?.message ?? e}`));
    }
  });
}

/** Kills every plugin child (reload, server exit). Next calls start fresh children. */
export function stopPluginHosts(reason = "reload"): void {
  for (const h of hosts.values()) killHost(h, reason);
  hosts.clear();
}

/** Test/diagnostic view of one plugin's child. */
export function pluginHostStats(pluginId: string): { running: boolean; spawns: number } {
  const h = hosts.get(pluginId);
  return { running: !!h?.child, spawns: h?.spawns ?? 0 };
}

// the server exiting takes every plugin process with it (the IPC disconnect also ends them)
process.once("exit", () => stopPluginHosts("server exit"));

