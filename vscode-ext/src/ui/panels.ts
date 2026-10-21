/**
 * Approval helpers (spec docs/design/VSCODE-BRIDGE.md §4.2, §5). The approval cards live in the Chat
 * view (`chatView.ts`); card content comes from `approvalModel.ts`. The `vscode` module is injected,
 * never imported at runtime, so this file loads under vitest.
 */
import type * as VS from "vscode";
import { hasDiffContent, type ApprovalInput } from "./approvalModel";

export type VscodeApi = typeof VS;

/**
 * Opens VS Code's native diff editor for the frame's before/after text. Both sides are untitled
 * documents, so nothing is written to disk.
 */
export async function openNativeDiff(vscode: VscodeApi, frame: ApprovalInput): Promise<void> {
  if (!hasDiffContent(frame)) return;
  const [left, right] = await Promise.all([
    vscode.workspace.openTextDocument({ content: frame.before as string }),
    vscode.workspace.openTextDocument({ content: frame.after as string }),
  ]);
  await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, `${frame.path} (OmniChat)`);
}
