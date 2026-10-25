/**
 * The "open chat in editor" and "open chat in the right side bar" commands, and the refresh of the editor panel when the theme or the
 * decorations change. Kept out of extension.ts, which is at its size limit. `vscode` is injected.
 */
import type * as VS from "vscode";
import { CHAT_RIGHT_VIEW_ID, type ChatView } from "./chatView";

export function registerChatCommands(vscode: typeof VS, context: VS.ExtensionContext, chat: ChatView): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("omnichat.openChatInEditor", () => chat.panel.open()),
    // The right side bar is a view container the extension contributes (secondarySidebar): focusing its view opens it.
    vscode.window.registerWebviewViewProvider(CHAT_RIGHT_VIEW_ID, chat.right.provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("omnichat.moveToSecondarySideBar", () => chat.focusRight()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("omnichat.theme") || e.affectsConfiguration("omnichat.decorations")) chat.panel.refresh();
    }),
    { dispose: () => chat.panel.dispose() },
  );
}
