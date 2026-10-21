/**
 * Protocol version and semver helpers (pure, no vscode dependency).
 *
 * Spec: docs/design/VSCODE-BRIDGE.md §2.5 (compatibility).
 */

/**
 * Integer protocol version sent in `ready.protocol`.
 * NOTE: the spec names this value only as "protocol (integer)" and does not
 * state a number; v1 is assumed here (§3 "ツール(v1)"). Adjust if the spec differs.
 */
export const PROTOCOL_VERSION = 1;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parse a strict `x.y.z` version string. Throws on anything else. */
export function parseSemver(input: string): SemVer {
  const m = SEMVER_RE.exec(input);
  if (!m) {
    throw new Error(`invalid semver: ${JSON.stringify(input)}`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Returns -1, 0, or 1 when a is lower, equal, or higher than b. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  return 0;
}

/**
 * True when the extension version satisfies the server's minimum.
 * `serverMin` is the minimum extension version the server requires
 * (`welcome.minExtensionVersion`). Invalid versions are treated as incompatible.
 */
export function isCompatible(serverMin: string, extVersion: string): boolean {
  try {
    return compareSemver(extVersion, serverMin) >= 0;
  } catch {
    return false;
  }
}
