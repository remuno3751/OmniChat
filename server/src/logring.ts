import { format } from "node:util";

/** In-memory ring buffer of the last 200 console lines (used by GET /admin/diagnostics). */
const RING_SIZE = 200;
const ring: string[] = [];
const INSTALLED = Symbol.for("omnichat.logring.installed");

// Order matters: the Authorization pattern eats the rest of its line first.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/Authorization\s*:[^\r\n]*/gi, "Authorization: ***"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***"],
  [/(token|api[_-]?key|apikey|password|passwd|secret)(["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi, "$1$2***"],
  [/:\/\/[^\s/:@]+:[^\s/@]+@/g, "://***@"],
];

/** Masks tokens, API keys, passwords, Authorization headers and URL credentials as `***`. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function push(line: string): void {
  ring.push(maskSecrets(line));
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

/** Wraps console.log/info/warn/error/debug once; each call still prints normally and is also stored. */
export function installLogRing(): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: any[]) => {
      original(...args);
      try {
        push(`${new Date().toISOString()} [${level}] ${format(...args)}`);
      } catch {
        /* never let logging break the caller */
      }
    };
  }
}

/** The last `n` stored (already masked) log lines, oldest first. */
export function recentLogLines(n: number): string[] {
  if (!Number.isInteger(n) || n <= 0) return [];
  return ring.slice(-n);
}
