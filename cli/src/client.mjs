// HTTP and WebSocket access to the OmniChat server.
import { CliError, redactObject } from "./util.mjs";

export function normalizeServer(s) {
  if (!s) return "";
  let v = String(s).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "http://" + v;
  return v.replace(/\/+$/, "");
}

export function requireServer(ctx) {
  if (!ctx.server) {
    throw new CliError("no server configured: run `omnichat login --server URL` or set OMNICHAT_SERVER");
  }
}

export function requireAuth(ctx) {
  requireServer(ctx);
  if (!ctx.token) throw new CliError("not logged in: run `omnichat login`");
}

function errorText(data, text) {
  if (data && typeof data === "object") {
    const e = data.error;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    if (typeof data.message === "string") return data.message;
  }
  return String(text ?? "").slice(0, 200);
}

/**
 * Perform a request. opts: { body, auth (default true), text (return raw text), timeoutMs }.
 * Throws CliError with readable messages.
 */
export async function api(ctx, method, path, opts = {}) {
  const auth = opts.auth !== false;
  if (auth) requireAuth(ctx);
  else requireServer(ctx);
  const url = ctx.server + path;
  const headers = { accept: opts.text ? "*/*" : "application/json" };
  let body;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (auth) headers.authorization = `Bearer ${ctx.token}`;
  const t0 = Date.now();
  ctx.debug(`--> ${method} ${path}${opts.body !== undefined ? " " + JSON.stringify(redactObject(opts.body)).slice(0, 300) : ""}`);
  let res;
  try {
    res = await ctx.io.fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? ctx.timeoutMs),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new CliError(`request ${method} ${path} timed out after ${Math.round((opts.timeoutMs ?? ctx.timeoutMs) / 1000)}s`);
    }
    const reason = e?.cause?.code || e?.cause?.message || e?.message || "unknown error";
    throw new CliError(`cannot reach server ${ctx.server} (${reason}). Check --server / OMNICHAT_SERVER and that the server is running`);
  }
  const raw = await res.text();
  ctx.debug(`<-- ${res.status} (${raw.length} bytes, ${Date.now() - t0} ms)`);
  let data;
  if (!opts.text || !res.ok) {
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  }
  if (!res.ok) {
    const msg = errorText(data, raw);
    if (res.status === 401) {
      if (!auth) throw new CliError(msg || "invalid credentials");
      throw new CliError("authentication failed (401): the token is invalid or revoked. Run `omnichat login`");
    }
    if (res.status === 403) {
      throw new CliError(msg ? `forbidden (403): ${msg}` : "forbidden (403)");
    }
    if (res.status === 404) throw new CliError(`not found (404): ${msg || path}`);
    if (res.status === 409) throw new CliError(`conflict (409): ${msg}`);
    if (res.status >= 500) throw new CliError(`server error (${res.status}): ${msg}`);
    throw new CliError(`${method} ${path} failed (${res.status}): ${msg}`);
  }
  return opts.text ? raw : data;
}

export function wsUrl(ctx) {
  return ctx.server.replace(/^http/i, "ws") + "/ws?token=" + encodeURIComponent(ctx.token);
}

/** Open the /ws socket. Resolves once connected; frames are buffered until `listen` is called. */
export function connectWs(ctx) {
  requireAuth(ctx);
  const url = wsUrl(ctx);
  ctx.debug(`ws connect ${url}`);
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new ctx.io.WebSocket(url);
    } catch (e) {
      reject(new CliError(`cannot open WebSocket: ${e.message}`));
      return;
    }
    let opened = false;
    let handler = null;
    let closeHandler = null;
    const buffered = [];
    let closedInfo = null;
    const connTimer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* ignore */ }
        reject(new CliError(`timed out connecting to ${ctx.server}/ws`));
      }
    }, ctx.timeoutMs);
    const conn = {
      send(obj) {
        ctx.debug(`ws -> ${obj.type}`);
        ws.send(JSON.stringify(obj));
      },
      listen(fn, onClose) {
        handler = fn;
        closeHandler = onClose;
        for (const f of buffered.splice(0)) fn(f);
        if (closedInfo && onClose) onClose(closedInfo);
      },
      /** Close and wait (bounded) for the close handshake so no socket is left half-closed. */
      close() {
        return new Promise((resolve) => {
          if (ws.readyState === 3) return resolve();
          const t = setTimeout(resolve, 1000);
          ws.addEventListener("close", () => { clearTimeout(t); resolve(); }, { once: true });
          try { ws.close(); } catch { clearTimeout(t); resolve(); }
        });
      },
    };
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(connTimer);
      resolve(conn);
    });
    ws.addEventListener("message", (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return; }
      ctx.debug(`ws <- ${frame?.type}`);
      if (handler) handler(frame);
      else buffered.push(frame);
    });
    ws.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(connTimer);
        reject(new CliError(`cannot open WebSocket to ${ctx.server}. If the token was revoked run \`omnichat login\`; otherwise check the server`));
      }
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(connTimer);
      closedInfo = { code: ev.code, reason: ev.reason };
      if (closeHandler) closeHandler(closedInfo);
    });
  });
}
