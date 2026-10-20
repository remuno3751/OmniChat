import type { FastifyInstance } from "fastify";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.js";
import { AuthError, authFromRequest } from "./auth.js";
import { PORT, HOST, DATA_DIR, DB_PATH, CORS_ORIGIN, TRUST_PROXY, SEARXNG_URL } from "./config.js";
import { registrationAllowed } from "./server-general.js";
import { maskSecrets, recentLogLines } from "./logring.js";
import { getSearchBackend, searchMaxResults } from "./search/index.js";
import { listBridges } from "./bridges.js";
import { parseModels } from "./models.js";
import { hasForwardingHeaders } from "./route.js";

const PROBE_TIMEOUT_MS = 2000;
const DIR_ENTRY_LIMIT = 20000;
const LOG_LINES = 40;

/** What requests since startup looked like (headers only, never values): feeds the exposure warnings. */
const seen = { forwarded: false, tailscale: false, httpsProto: false };
export function noteRequestHeaders(headers: Record<string, unknown>): void {
  if (!hasForwardingHeaders(headers)) return;
  seen.forwarded = true;
  if (Object.keys(headers).some((k) => k.toLowerCase().startsWith("tailscale-"))) seen.tailscale = true;
  const p = String(headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  if (p === "https") seen.httpsProto = true;
}

export interface ExposureInput {
  allowRegistration: boolean; trustProxy: boolean; host: string; publicUrl: string;
  forwardedSeen: boolean; tailscaleSeen: boolean; httpsSeen: boolean;
}

/** Bilingual (EN / JA) warnings for a server that is reachable from the internet (for example through Tailscale Funnel). */
export function exposureWarnings(i: ExposureInput): string[] {
  const w: string[] = [];
  if (i.allowRegistration) w.push("WARN: registration is open (ALLOW_REGISTRATION). Anyone who can reach the URL can create an account. Create accounts as an administrator and turn it off. / 新規登録が開いています(ALLOW_REGISTRATION)。URL に届く人なら誰でもアカウントを作れます。管理者がアカウントを作成し、登録は閉じてください。");
  if (i.forwardedSeen && !i.trustProxy) w.push("WARN: requests with proxy headers (X-Forwarded-*, Tailscale-*) were seen but TRUST_PROXY is not set. All remote users share one login rate-limit bucket (the proxy address). Set TRUST_PROXY=1. / プロキシ経由のヘッダーを検出しましたが TRUST_PROXY が未設定です。全ての外部ユーザーがログイン試行制限を共有します。TRUST_PROXY=1 を設定してください。");
  if (i.forwardedSeen || i.tailscaleSeen) w.push("INFO: passwords only need 8 characters (no complexity rule) and cannot be audited here. Use long, unique passwords for every account. / パスワードの最小長は 8 文字で複雑性の要件はなく、ここでは強度を確認できません。全アカウントで長く固有のパスワードを使ってください。");
  if (i.tailscaleSeen && (i.host === "0.0.0.0" || i.host === "::")) w.push("WARN: Tailscale headers were seen while HOST is 0.0.0.0 — the port is also open on your LAN, bypassing Funnel. Set HOST=127.0.0.1 when Funnel is the only entrance. / Tailscale のヘッダーを検出しましたが HOST が 0.0.0.0 のため、Funnel を介さず LAN からも直接届きます。入口が Funnel だけなら HOST=127.0.0.1 にしてください。");
  if (i.forwardedSeen && !i.httpsSeen && !/^https:\/\//i.test(i.publicUrl)) w.push("WARN: no sign of HTTPS (no X-Forwarded-Proto: https seen, OMNICHAT_PUBLIC_URL is not https). Passwords and tokens would travel in clear text. / HTTPS の形跡がありません(X-Forwarded-Proto: https なし、OMNICHAT_PUBLIC_URL も https ではない)。パスワードやトークンが平文で流れる恐れがあります。");
  return w;
}

/** Same rule as routes-history.ts (kept local so that module's helper stays private). */
function requireAdmin(req: { headers: Record<string, any> }): string {
  const userId = authFromRequest(req).userId;
  const u = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
  if (!u?.is_admin) throw new AuthError("Admin only", 403);
  return userId;
}

function serverVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

/** Table-cell safe text: no pipes or newlines. */
const cell = (s: unknown): string => String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const yn = (b: boolean): string => (b ? "yes" : "no");

/** Recursive size walk; stops after DIR_ENTRY_LIMIT entries. Symlinks are not followed. */
function dirSize(root: string): { bytes: number; entries: number; truncated: boolean } {
  let bytes = 0;
  let entries = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++entries > DIR_ENTRY_LIMIT) return { bytes, entries: DIR_ENTRY_LIMIT, truncated: true };
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) stack.push(p);
        else if (st.isFile()) bytes += st.size;
      } catch {
        /* unreadable entry: skip */
      }
    }
  }
  return { bytes, entries, truncated: false };
}

/** Wraps one report section so a failing probe shows "error" instead of failing the route. */
async function section(title: string, body: () => string[] | Promise<string[]>): Promise<string[]> {
  let lines: string[];
  try {
    lines = await body();
  } catch (e: any) {
    lines = [`- error (${String(e?.message ?? e).replace(/[\r\n]+/g, " ").slice(0, 120)})`];
  }
  return [`## ${title}`, "", ...lines, ""];
}

async function providerRows(userId: string): Promise<string[]> {
  const rows = db.prepare("SELECT * FROM providers WHERE user_id = ? AND deleted = 0 ORDER BY seq").all(userId) as any[];
  if (!rows.length) return ["(no providers)"];
  const out = [
    "| name | kind | host | reachable | models |",
    "| --- | --- | --- | --- | --- |",
  ];
  const results = await Promise.all(rows.map(async (row) => {
    let host: string;
    if (row.kind === "dsh-bridge") {
      host = `bridge: ${String(row.base_url ?? "").trim()}`;
    } else {
      try {
        host = new URL(String(row.base_url ?? "")).host || "(invalid)";
      } catch {
        host = "(invalid)";
      }
    }
    if (row.kind !== "openai-compatible") return { host, reachable: "n/a", models: "n/a" };
    if (host === "(invalid)") return { host, reachable: "no", models: "n/a" };
    try {
      const baseUrl = String(row.base_url).trim().replace(/\/+$/, "");
      const res = await fetch(`${baseUrl}/models`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      let models = "n/a";
      if (res.ok) {
        try {
          models = String(parseModels(await res.json()).length);
        } catch {
          models = "n/a";
        }
      }
      return { host, reachable: yn(true), models };
    } catch {
      return { host, reachable: yn(false), models: "n/a" };
    }
  }));
  rows.forEach((row, i) => {
    const r = results[i];
    out.push(`| ${cell(row.name)} | ${cell(row.kind)} | ${cell(r.host)} | ${r.reachable} | ${r.models} |`);
  });
  return out;
}

async function buildReport(userId: string): Promise<string> {
  const parts: string[] = ["# OmniChat diagnostics", "", `Generated: ${new Date().toISOString()}`, ""];

  parts.push(...await section("Server", () => [
    `- Version: ${serverVersion()}`,
    `- Node: ${process.version}`,
    `- Uptime: ${Math.round(process.uptime())} s`,
    `- Platform: ${process.platform}/${process.arch}`,
    `- PORT: ${PORT}, HOST: ${HOST}`,
  ]));

  parts.push(...await section("Storage", () => {
    const lines = [`- DATA_DIR: ${DATA_DIR}`];
    if (!existsSync(DATA_DIR)) {
      lines.push("- Data dir size: missing");
    } else {
      const d = dirSize(DATA_DIR);
      lines.push(`- Data dir size: ${d.bytes} bytes (${d.entries} entries${d.truncated ? ", truncated" : ""})`);
    }
    if (DB_PATH === ":memory:") lines.push("- DB file size: in-memory");
    else {
      try {
        lines.push(`- DB file size: ${statSync(DB_PATH).size} bytes`);
      } catch {
        lines.push("- DB file size: missing");
      }
    }
    const users = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const devices = (db.prepare("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").get() as { n: number }).n;
    lines.push(`- Users: ${users}`, `- Devices (active): ${devices}`);
    return lines;
  }));

  parts.push(...await section("Providers", () => providerRows(userId)));

  parts.push(...await section("Search", async () => {
    const b = getSearchBackend();
    if (!b) return ["- configured: no", "- reachable: no"];
    const p = await b.probe(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    const lines = [`- configured: yes (${b.name}, ${b.host})`, `- reachable: ${yn(p.reachable)}`];
    if (p.error) lines.push(`- error: ${p.error.replace(/[\r\n]+/g, " ").slice(0, 200)}`);
    return lines;
  }));

  parts.push(...await section("Bridges", () => {
    const names = listBridges(userId).map((b) => b.name);
    return names.length ? names.map((n) => `- ${n} (connected)`) : ["(no bridges connected)"];
  }));

  parts.push(...await section("Config", () => {
    const settingsRows = (db.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number }).n;
    return [
      `- Registration allowed (DB or ALLOW_REGISTRATION env): ${yn(registrationAllowed())}`,
      `- CORS_ORIGIN set: ${yn(CORS_ORIGIN.length > 0)}${CORS_ORIGIN.length ? ` (${CORS_ORIGIN.length} origin(s))` : ""}`,
      `- TRUST_PROXY: ${yn(TRUST_PROXY)}`,
      `- SEARXNG_URL set: ${yn(SEARXNG_URL.trim() !== "")}`,
      `- SEARCH_MAX_RESULTS (effective): ${searchMaxResults()}`,
      `- Settings rows: ${settingsRows}`,
    ];
  }));

  parts.push(...await section("Exposure warnings / 公開時の警告", () => {
    const w = exposureWarnings({
      allowRegistration: registrationAllowed(), trustProxy: TRUST_PROXY, host: HOST, publicUrl: (process.env.OMNICHAT_PUBLIC_URL ?? "").trim(),
      forwardedSeen: seen.forwarded, tailscaleSeen: seen.tailscale, httpsSeen: seen.httpsProto,
    });
    return w.length ? w.map((x) => `- ${x}`) : ["- (none)"];
  }));

  parts.push(...await section("Recent log", () => {
    const lines = recentLogLines(LOG_LINES);
    if (!lines.length) return ["(no log lines)"];
    const longest = Math.max(0, ...(lines.join("\n").match(/`+/g) ?? []).map((m) => m.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return [fence + "text", ...lines, fence];
  }));

  return maskSecrets(parts.join("\n"));
}

/** Admin-only Markdown health report (PROTOCOL-v4 section 7). */
export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  app.get("/admin/diagnostics", async (req, reply) => {
    const userId = requireAdmin(req);
    const md = await buildReport(userId);
    return reply.header("content-type", "text/markdown; charset=utf-8").send(md);
  });
}
