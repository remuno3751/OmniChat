/**
 * Chat support detection: whether the connected server answers the chat frames. Pure, no `vscode`.
 * `protocol/version.ts` stays strict; the prerelease-aware comparison lives here.
 */

/** First server version that answers chat frames. */
export const CHAT_MIN_SERVER = "0.5.4-beta.2";

export type ChatSupport = "ok" | "unsupported" | "unknown";

interface ParsedVersion {
  core: [number, number, number];
  pre: string[] | null; // prerelease identifiers, null for a release
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_RE = /^(0|[1-9]\d*)$/;

function parseVersion(text: string): ParsedVersion | null {
  const m = VERSION_RE.exec(text.trim());
  if (m === null) return null;
  const pre = m[4] === undefined ? null : m[4].split(".");
  if (pre !== null && pre.some((id) => id === "" || (/^\d+$/.test(id) && !NUMERIC_RE.test(id)))) {
    return null; // empty or leading-zero numeric identifiers are invalid
  }
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // shorter set has lower precedence
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Semver precedence: returns -1, 0 or 1 for a < b, a == b, a > b. Null when either side is not a
 * valid version. Build metadata is ignored.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i] - pb.core[i];
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // a release is above its prereleases
  if (pb.pre === null) return -1;
  const c = comparePre(pa.pre, pb.pre);
  return c < 0 ? -1 : c > 0 ? 1 : 0;
}

/**
 * Decides whether a server supports chat. `features` (when the server sends it) is authoritative;
 * otherwise the server version decides. `null` info means not connected yet, so "unknown".
 */
export function chatSupport(info: { serverVersion?: string; features?: readonly string[] } | null): ChatSupport {
  if (info === null) return "unknown";
  if (Array.isArray(info.features)) return info.features.includes("chat") ? "ok" : "unsupported";
  if (typeof info.serverVersion !== "string") return "unknown";
  const cmp = compareVersions(info.serverVersion, CHAT_MIN_SERVER);
  if (cmp === null) return "unknown";
  return cmp >= 0 ? "ok" : "unsupported";
}
