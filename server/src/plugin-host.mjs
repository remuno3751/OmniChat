// Child entry for process-isolated plugins (see docs/design/PLUGIN-INSTALL.md section 5, stage 2).
// Started by plugin-sandbox.ts as: node --permission --allow-fs-read=<this file> --allow-fs-read=<plugin dir>/* ... plugin-host.mjs <absolute main file>
// Uses Node builtins only. Talks to the parent over the IPC channel (JSON messages, see plugin-sandbox.ts for the protocol).
// Security note: the parent kills this process on timeout, reload, disable, delete or server exit. The process exits
// when the IPC channel closes, so an orphaned plugin process cannot outlive the server.
import { pathToFileURL } from "node:url";

const MAX_TEXT = 64 * 1024; // the parent caps results at 8 KB; this bounds the IPC message size
const mainFile = process.argv[2];
const pending = new Map(); // call id -> AbortController
const fetchWaiters = new Map(); // request id -> { resolve, reject }
let fetchSeq = 0;

const send = (m) => { try { process.send(m); } catch { /* channel closed: the parent is gone */ } };
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const toText = (out) => {
  if (typeof out === "string") return out;
  if (out === undefined || out === null) return "";
  return JSON.stringify(out) ?? "";
};

let toolsMod = null;
let loadError = null;
const loaded = import(pathToFileURL(mainFile).href)
  .then((m) => {
    if (!m || typeof m.tools !== "object" || !m.tools) throw new Error("module does not export `tools`");
    toolsMod = m.tools;
  })
  .catch((e) => { loadError = String(e?.message ?? e); });

process.on("disconnect", () => process.exit(0));

/* ---------------- ctx.fetch (proxied through the parent, which enforces the block list) ---------------- */

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

async function proxyFetch(callId, signal, input, init) {
  const opts = init ?? {};
  if (signal?.aborted) throw new Error("aborted");
  const url = typeof input === "object" && input && "url" in input ? String(input.url) : String(input);
  const method = String(opts.method ?? (typeof input === "object" && input ? input.method : undefined) ?? "GET").toUpperCase();
  const fromInput = typeof input === "object" && input ? input : null;
  const headers = Object.entries(Object.fromEntries(new Headers(opts.headers ?? fromInput?.headers ?? undefined)));
  const body = opts.body === undefined || opts.body === null ? null
    : Buffer.from(await new Response(opts.body).arrayBuffer()).toString("base64");
  const rid = ++fetchSeq;
  const reply = new Promise((resolve, reject) => fetchWaiters.set(rid, { resolve, reject }));
  send({ t: "fetch", rid, id: callId, url, method, headers, body, redirect: opts.redirect ?? "follow" });
  const onAbort = () => {
    const w = fetchWaiters.get(rid);
    if (w) { fetchWaiters.delete(rid); w.reject(new Error("aborted")); }
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
  let res;
  try { res = await reply; } finally { signal?.removeEventListener("abort", onAbort); }
  if (!res || res.status < 200 || res.status > 599) throw new TypeError("fetch: invalid response status");
  return new Response(NULL_BODY.has(res.status) || !res.body ? null : Buffer.from(res.body, "base64"), {
    status: res.status, statusText: res.statusText ?? "", headers: res.headers,
  });
}

/* ---------------- calls ---------------- */

async function runCall(m) {
  const ac = new AbortController();
  pending.set(m.id, ac);
  try {
    await loaded;
    if (loadError) throw new Error(`failed to load ${mainFile.split(/[\\/]/).pop()}: ${loadError}`);
    const fn = toolsMod[m.tool];
    if (typeof fn !== "function") throw new Error(`module does not export a function for tool "${m.tool}"`);
    const ctx = {
      signal: ac.signal,
      log: (msg) => send({ t: "log", id: m.id, msg: clip(String(msg), 500) }),
      userId: m.userId,
      config: {},
    };
    if (m.network) ctx.fetch = (input, init) => proxyFetch(m.id, ac.signal, input, init);
    // the in-process registry passes a per-turn state object as the third argument; plugins get an empty one here
    const out = await fn(m.args, ctx, { sources: [] });
    send({ t: "result", id: m.id, ok: true, text: clip(toText(out), MAX_TEXT) });
  } catch (e) {
    send({ t: "result", id: m.id, ok: false, error: clip(String(e?.message ?? e), 500) });
  } finally {
    pending.delete(m.id);
  }
}

process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "call") { void runCall(m); return; }
  if (m.t === "abort") { pending.get(m.id)?.abort(new Error("stopped")); return; }
  if (m.t === "fetch-res") {
    const w = fetchWaiters.get(m.rid);
    if (!w) return;
    fetchWaiters.delete(m.rid);
    if (m.ok) w.resolve(m); else w.reject(new Error(String(m.error ?? "fetch failed")));
  }
});
