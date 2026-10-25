/**
 * Outside-workspace access, granted per call by the server (`approval.outsideOk`).
 *
 * The gate uses `isOutsideVerdict` to let an outside-type protection through. The tools use
 * `outsideCandidate` and `outsideRefusal` for a path that `resolveInWorkspace` refused as outside.
 * Secret and `.git` rules still apply to such paths.
 */
import type { ProtectedVerdict } from "./protected";
import { isGitInternal, isSecretPath, normalizePath, type RealpathFn } from "./paths";

/** True for the protection rules that only mean "outside the workspace" (P1, or a command path outside). */
export function isOutsideVerdict(v: ProtectedVerdict): boolean {
  if (!v.protected) return false;
  return v.rule === "P1-outside" || (v.rule === "C-path" && v.reason.startsWith("path outside"));
}

const HOME_PREFIX = /^(~|\$HOME|%USERPROFILE%)/i;
const ABSOLUTE_NORM = /^([A-Za-z]:\/|\/\/|\/)/;

/**
 * The absolute path for an outside access, or null when there is none. Absolute input is taken as
 * given. Relative input (for example `../x`) is resolved lexically against `root`. Home-relative
 * forms are never accepted.
 */
export function outsideCandidate(root: string, raw: string): string | null {
  if (HOME_PREFIX.test(raw)) return null;
  const direct = normalizePath(raw);
  const abs = ABSOLUTE_NORM.test(direct) ? direct : normalizePath(`${normalizePath(root)}/${raw}`);
  return ABSOLUTE_NORM.test(abs) ? abs : null;
}

/**
 * Secret and `.git` checks for an outside path. `abs` is checked lexically and, when `realpath`
 * is given and resolves, through its real target too. Returns the refusal message or null.
 */
export async function outsideRefusal(abs: string, realpath: RealpathFn | undefined, write: boolean): Promise<string | null> {
  const targets = [abs];
  if (realpath) {
    try {
      const real = normalizePath(await realpath(abs));
      if (real !== abs) targets.push(real);
    } catch {
      // Missing or unreadable: the lexical check still applies.
    }
  }
  for (const p of targets) {
    if (write && isGitInternal(p)) return "write inside .git";
    if (isSecretPath(p)) return "secret-looking path";
  }
  return null;
}
