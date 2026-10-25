/**
 * The editor-area chat: the same chat page as the sidebar view, in a WebviewPanel (one at a time).
 * The owner (chatView.ts) posts every message to the sidebar and to this panel, and both views' messages
 * go to the same onMessage. The page is built by buildPageHtml, so both show the same markup.
 * `vscode` is injected.
 */
import type * as VS from "vscode";
import { buildPageHtml, type PageOptions } from "./viewProvider";

export const CHAT_PANEL_TYPE = "omnichat.chatPanel";

export interface ChatPanelOptions extends PageOptions {
  /** The page posted `ready` (also after it was reloaded): push the state now. */
  onReady: () => void;
  /** Any other message from the page, unvalidated. */
  onMessage: (raw: unknown) => void;
}

export interface ChatPanel {
  /** Posts to the open panel; dropped when it is closed or its page is not ready yet. */
  post(message: unknown): void;
  /** Opens the panel beside the editor, or reveals the one already open. */
  open(): void;
  /** Rebuilds the page (theme or decorations changed). */
  refresh(): void;
  isOpen(): boolean;
  dispose(): void;
}

function isReady(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ready";
}

export function createChatPanel(opts: ChatPanelOptions): ChatPanel {
  const { vscode } = opts;
  let panel: VS.WebviewPanel | undefined;
  let ready = false;

  /** Sets the page once. The page sends `ready` again, so `ready` is cleared until then. */
  const setHtml = (p: VS.WebviewPanel): void => {
    ready = false;
    try {
      p.webview.html = buildPageHtml(p.webview, opts);
    } catch {
      // the panel went away between the check and the write
    }
  };

  return {
    post(message) {
      if (!panel || !ready) return;
      try {
        void Promise.resolve(panel.webview.postMessage(message)).catch(() => undefined);
      } catch {
        // disposed panel: drop the message
      }
    },
    open() {
      if (panel) {
        panel.reveal(undefined, false);
        return;
      }
      // retainContextWhenHidden is off: a hidden panel reloads its page, which sends `ready` again.
      const p = vscode.window.createWebviewPanel(CHAT_PANEL_TYPE, opts.title, vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, "media")],
      });
      panel = p;
      setHtml(p);
      p.webview.onDidReceiveMessage((raw: unknown) => {
        if (panel !== p) return;
        if (isReady(raw)) {
          ready = true;
          opts.onReady();
        } else {
          opts.onMessage(raw);
        }
      });
      p.onDidDispose(() => {
        if (panel !== p) return;
        panel = undefined;
        ready = false;
      });
    },
    refresh() {
      if (panel) setHtml(panel);
    },
    isOpen: () => panel !== undefined,
    dispose() {
      panel?.dispose();
    },
  };
}
