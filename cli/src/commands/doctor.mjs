// `omnichat doctor`: local checks (node, config, port, healthz, token, data dir) plus the server's diagnostics.
// Works without login; the server part needs an admin token.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { api, normalizeServer } from "../client.mjs";
import { truncate } from "../util.mjs";

const DEFAULT_SERVER = "http://localhost:8787";
const PORT_TIMEOUT_MS = 3000;
const HEALTH_TIMEOUT_MS = 5000;

/** Replace literal secret values (token, saved token) in text. The rest of the text is left as it is. */
function scrub(text, secrets) {
  let s = String(text ?? "");
  for (const sec of secrets) {
    if (typeof sec === "string" && sec.length >= 4) s = s.split(sec).join("***");
  }
  return s;
}

/** TCP connect to host:port with a timeout. Resolves { ok } or { ok: false, code }. */
function checkPort(server) {
  let host;
  let port;
  try {
    const u = new URL(server);
    host = u.hostname.replace(/^\[|\]$/g, "");
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return Promise.resolve({ ok: false, code: "invalid URL" });
  }
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(PORT_TIMEOUT_MS, () => done({ ok: false, code: "ETIMEDOUT" }));
    sock.once("connect", () => done({ ok: true }));
    sock.once("error", (e) => done({ ok: false, code: e.code || e.message }));
  });
}

async function checkHealthz(ctx, server) {
  try {
    const res = await ctx.io.fetch(server + "/healthz", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body = (await res.text()).trim();
    if (res.ok && body === "ok") return { ok: true };
    return { ok: false, detail: `HTTP ${res.status}, body ${JSON.stringify(truncate(body, 80))}` };
  } catch (e) {
    return { ok: false, detail: `request failed: ${e?.cause?.code || e?.name || e?.message || "unknown error"}` };
  }
}

/** Create and delete a probe file inside the directory. Returns null when fine, else the reason. */
function checkDataDir(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    return e.code === "ENOENT" ? `does not exist: ${dir}` : `cannot access ${dir}: ${e.code || e.message}`;
  }
  if (!st.isDirectory()) return `not a directory: ${dir}`;
  const probe = path.join(dir, `.omnichat-doctor-${process.pid}`);
  try {
    fs.writeFileSync(probe, "omnichat doctor\n", { flag: "wx" });
  } catch (e) {
    return `not writable: ${e.code || e.message}`;
  }
  try {
    fs.unlinkSync(probe);
  } catch (e) {
    return `probe file could not be removed (${e.code || e.message})`;
  }
  return null;
}

export async function doctorCommand(ctx) {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });
  const explicitServer = !!(ctx.flags.server || ctx.env.OMNICHAT_SERVER);
  const server = ctx.server || normalizeServer(DEFAULT_SERVER);

  // The saved token belongs to the saved server. main.mjs only checks that when --server is given,
  // so drop it here when the default server is used and the saved login is for another one.
  let token = ctx.token;
  let tokenMismatch = !!ctx.tokenServerMismatch;
  const savedServer = normalizeServer(ctx.config?.server ?? "");
  if (token && !ctx.server && !ctx.env.OMNICHAT_TOKEN && savedServer !== server) {
    token = undefined;
    tokenMismatch = true;
  }

  // 1. node
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) add("FAIL", "node", `${process.version}: omnichat needs Node >= 22`);
  else if (major < 24) add("WARN", "node", `${process.version}: the server needs Node >= 24 when run from source`);
  else add("OK", "node", process.version);

  // 2. config file
  if (fs.existsSync(ctx.configPath)) {
    add("OK", "config file", ctx.configPath);
  } else if (explicitServer) {
    add("WARN", "config file", "not found (not logged in; fine when --server and OMNICHAT_TOKEN are used)");
  } else {
    add("FAIL", "config file", `not found at ${ctx.configPath}: run \`omnichat login\``);
  }

  // 3. port
  const port = await checkPort(server);
  if (port.ok) add("OK", "port", `${server} reachable`);
  else add("FAIL", "port", `${server} not reachable (${port.code})`);

  // 4. healthz (skipped when the port is closed)
  if (port.ok) {
    const h = await checkHealthz(ctx, server);
    if (h.ok) add("OK", "healthz", `${server}/healthz is ok`);
    else add("FAIL", "healthz", h.detail ?? "unexpected response");
  }

  // 5. token
  if (!token) {
    const why = tokenMismatch
      ? "the saved token belongs to another server and was not sent; run `omnichat login` for this server"
      : "run `omnichat login` or set OMNICHAT_TOKEN";
    add("FAIL", "token", `no token: ${why} (needed for /admin/diagnostics)`);
  } else {
    add("OK", "token", "present");
  }

  // 6. server diagnostics (only with a token)
  let section;
  if (token) {
    try {
      const body = await api({ ...ctx, server, token }, "GET", "/admin/diagnostics", { text: true });
      section = scrub(body, ctx.secrets).replace(/\n?$/, "\n");
      add("OK", "server diagnostics", "fetched");
    } catch (e) {
      const msg = scrub(e?.message ?? String(e), ctx.secrets);
      section = `server unreachable or request failed: ${msg}\n`;
      const forbidden = /^forbidden \(403\)/.test(msg);
      add("FAIL", "server diagnostics", forbidden ? "forbidden: the account must be an admin" : msg);
    }
  } else {
    section = "skipped: no token (see the token check above)\n";
  }

  // 7. data dir (only with --data-dir)
  if (ctx.flags.dataDir !== undefined) {
    const problem = checkDataDir(ctx.flags.dataDir);
    if (problem) add("FAIL", "data dir", problem);
    else add("OK", "data dir", `${ctx.flags.dataDir} exists and is writable`);
  }

  const lines = ["# omnichat doctor", "", "## Local checks"];
  for (const c of checks) lines.push(`- [${c.level}] ${c.name}: ${c.detail}`);
  ctx.out(lines.join("\n") + "\n\n## Server diagnostics\n" + section);
  return checks.some((c) => c.level === "FAIL") ? 1 : 0;
}
