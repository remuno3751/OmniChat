/**
 * Opening a file from the Chat view: the path the webview names is resolved inside a workspace root, refused
 * when it is protected or inside .git, and opened in the editor. Split out of chatView.ts to keep that file small.
 * `vscode` is injected.
 */
import { promises as fsp } from "node:fs";
import type * as VS from "vscode";
import { checkProtected } from "../guard/protected";
import { isGitInternal, normalizePath, resolveInWorkspace, type RealpathFn } from "../guard/paths";

/** Resolves a path from the webview to a file inside one of the roots that is not protected. */
export async function resolveOpenFile(
  path: string,
  roots: readonly string[],
  realpath: RealpathFn = (p) => fsp.realpath(p),
): Promise<{ ok: true; abs: string } | { ok: false }> {
  for (const root of roots) {
    const r = await resolveInWorkspace(root, path, realpath);
    if (!r.ok) continue;
    const verdict = await checkProtected(
      { tool: "read_file", args: { path: r.abs } },
      { roots: [...roots], cwd: root, realpath, platform: process.platform === "win32" ? "win32" : "posix" },
    );
    // The read rules let .git files through; an editor should not open them from the chat either.
    const inside = normalizePath(r.abs).slice(normalizePath(root).length).replace(/^\/+/, "");
    if (verdict.protected || isGitInternal(inside)) return { ok: false };
    return { ok: true, abs: r.abs };
  }
  return { ok: false };
}

/** Opens a workspace file in the editor at `line` (1-based), keeping focus where it is. Refusals show `refused`. */
export async function openWorkspaceFile(
  vscode: typeof VS,
  roots: readonly string[],
  path: string,
  line: number | undefined,
  refused: string,
): Promise<void> {
  const target = await resolveOpenFile(path, roots);
  if (!target.ok) {
    void vscode.window.showWarningMessage(`OmniChat: ${refused}`);
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.abs));
    const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { preserveFocus: false, selection: new vscode.Range(at, at) });
  } catch {
    void vscode.window.showWarningMessage(`OmniChat: ${refused}`);
  }
}
