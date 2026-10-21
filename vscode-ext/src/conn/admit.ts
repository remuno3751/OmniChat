/**
 * Run admission (docs/design/VSCODE-BRIDGE.md §2.3, §2.4): workspace trust, and whether the run's
 * roots and cwd lie inside the workspace folders the user allows. Moved out of runs.ts for its size limit.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RunFrame } from "../protocol/frames";

/** True when `child` is `dir` or lies under it. Both must be absolute. */
export function within(child: string, dir: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(dir)) return false;
  const rel = relative(resolve(dir), resolve(child));
  return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

export type Admission = { ok: true; root: string } | { ok: false; error: "untrusted_workspace" | "cwd not allowed" };

export function admitRun(f: RunFrame, workspaces: readonly string[], trusted: boolean): Admission {
  if (!trusted) return { ok: false, error: "untrusted_workspace" };
  const rootsOk = f.roots.length > 0 && f.roots.every((r) => workspaces.some((w) => within(r, w)));
  const root = f.roots.find((r) => within(f.cwd, r));
  if (!rootsOk || root === undefined || !workspaces.some((w) => within(f.cwd, w))) {
    return { ok: false, error: "cwd not allowed" };
  }
  return { ok: true, root };
}
