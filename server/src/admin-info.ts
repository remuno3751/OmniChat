// Read-mostly server information for the remote admin API (PROTOCOL v7).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { AuthError } from "./auth.js";
import { CORS_ORIGIN, HOST, PORT, TRUST_PROXY } from "./config.js";
import { readGeneral } from "./server-general.js";
import { recentLogLines } from "./logring.js";
import { requestRestart } from "./updater/restart.js";
import { detectInstall } from "./updater/install-type.js";

const STARTED_AT = Date.now();

/** Same logic as static.ts pkgVersion(). */
function pkgVersion(): string {
  try {
    const root = process.env.OMNICHAT_BUNDLE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

export function adminOverview(): {
  server: { name: string; description: string; version: string; installType: string; uptimeSec: number; supervised: boolean; platform: string; node: string };
  users: { total: number; admins: number; disabled: number };
  restartPending: false;
} {
  const g = readGeneral();
  const counts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) AS admins, SUM(CASE WHEN disabled_at IS NOT NULL THEN 1 ELSE 0 END) AS disabled FROM users").get() as any;
  return {
    server: {
      name: g.serverName,
      description: g.serverDescription,
      version: pkgVersion(),
      installType: detectInstall().type,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      supervised: process.env.OMNICHAT_SUPERVISED === "1",
      platform: process.platform,
      node: process.version,
    },
    users: { total: Number(counts.total ?? 0), admins: Number(counts.admins ?? 0), disabled: Number(counts.disabled ?? 0) },
    restartPending: false,
  };
}

export function adminNetwork(): {
  host: string;
  port: number;
  exposure: "loopback" | "lan" | "all";
  trustProxy: boolean;
  corsOrigins: string[];
  tlsHint: string;
  editable: false;
} {
  const exposure: "loopback" | "lan" | "all" =
    HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost" ? "loopback" : HOST === "0.0.0.0" || HOST === "::" ? "all" : "lan";
  return {
    host: HOST,
    port: PORT,
    exposure,
    trustProxy: TRUST_PROXY,
    corsOrigins: [...CORS_ORIGIN],
    tlsHint:
      "This server speaks plain HTTP. For TLS, put a reverse proxy (for example Caddy or nginx) in front of it, or use Tailscale. Set TRUST_PROXY=1 when the server runs behind such a proxy.",
    editable: false,
  };
}

const LEVEL_TOKENS: Record<"error" | "warn" | "info" | "all", string[]> = {
  error: ["error"],
  warn: ["warn", "error"],
  info: ["info", "warn", "error"],
  all: ["log", "info", "warn", "error", "debug"],
};

export function adminLogs(level: unknown, lines: unknown): string[] {
  if (level !== undefined && level !== "all" && level !== "error" && level !== "warn" && level !== "info") {
    throw new AuthError("level must be all, error, warn or info", 400);
  }
  let n = 100;
  if (lines !== undefined) {
    // Query strings arrive as text, so a digits-only string is accepted as well as an integer.
    const v = typeof lines === "string" && /^\d+$/.test(lines) ? Number(lines) : lines;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 200) throw new AuthError("lines must be an integer from 1 to 200", 400);
    n = v;
  }
  const tokens = LEVEL_TOKENS[(level ?? "all") as keyof typeof LEVEL_TOKENS].map((t) => ` [${t}] `);
  const matched = recentLogLines(200).filter((line) => tokens.some((t) => line.includes(t)));
  return matched.slice(-n);
}

export function scheduleRestart(body: unknown, fn: (reason: string) => void = requestRestart): { ok: true; mode: "supervised" | "respawn" } {
  if (typeof body !== "object" || body === null || Array.isArray(body) || (body as { confirm?: unknown }).confirm !== true) {
    throw new AuthError("confirm must be true", 400);
  }
  const mode = process.env.OMNICHAT_SUPERVISED === "1" ? "supervised" : "respawn";
  setTimeout(() => fn("restart requested by an administrator"), 700);
  return { ok: true, mode };
}
