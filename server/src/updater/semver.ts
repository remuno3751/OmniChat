// Minimal SemVer 2.0 parsing and precedence rules.
// Leading "v" is accepted, build metadata ("+...") is ignored for precedence.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers as written; empty for a stable release. */
  pre: string[];
}

const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Numeric identifiers may not have leading zeros; alphanumeric ones must contain a letter or "-".
const PRE_ID = /^(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/;
const BUILD = /^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/;
const NUMERIC = /^\d+$/;

/** Returns the parsed version, or null when the string is not valid SemVer. */
export function parseVersion(input: string): SemVer | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s.startsWith("v")) s = s.slice(1);

  const plus = s.indexOf("+");
  if (plus >= 0) {
    if (!BUILD.test(s.slice(plus + 1))) return null;
    s = s.slice(0, plus);
  }

  const dash = s.indexOf("-");
  const core = dash >= 0 ? s.slice(0, dash) : s;
  const m = CORE.exec(core);
  if (!m) return null;

  const pre: string[] = [];
  if (dash >= 0) {
    const preStr = s.slice(dash + 1);
    if (preStr === "") return null;
    for (const id of preStr.split(".")) {
      if (!PRE_ID.test(id)) return null;
      pre.push(id);
    }
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

function mustParse(s: string): SemVer {
  const v = parseVersion(s);
  if (!v) throw new Error(`invalid version: ${JSON.stringify(s)}`);
  return v;
}

// Compare two numeric strings without precision loss (no leading zeros by construction).
function cmpNumeric(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpPreId(a: string, b: string): -1 | 0 | 1 {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return cmpNumeric(a, b);
  if (an) return -1; // numeric identifiers sort before alphanumeric ones
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two versions by SemVer precedence. Returns -1, 0 or 1.
 * Throws Error when either input is not a valid version.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = mustParse(a);
  const vb = mustParse(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  // A release without prerelease identifiers has higher precedence than one with them.
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  const n = Math.min(va.pre.length, vb.pre.length);
  for (let i = 0; i < n; i++) {
    const c = cmpPreId(va.pre[i], vb.pre[i]);
    if (c !== 0) return c;
  }
  // A longer set of identifiers wins when all shared identifiers are equal.
  if (va.pre.length === vb.pre.length) return 0;
  return va.pre.length < vb.pre.length ? -1 : 1;
}

/** True when a has strictly higher precedence than b. Throws on invalid input. */
export function gt(a: string, b: string): boolean {
  return compareVersions(a, b) > 0;
}

/** True when the version carries prerelease identifiers. Throws on invalid input. */
export function isPrerelease(v: string): boolean {
  return mustParse(v).pre.length > 0;
}
