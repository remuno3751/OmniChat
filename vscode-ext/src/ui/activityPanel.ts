/**
 * Activity panel host (docs/design/VSCODE-BRIDGE.md §5). One WebviewPanel shows the live tool
 * activity of the current run. The view is created on `reveal()` (the command), not by `update()`,
 * so a run never opens a panel by itself. The `vscode` module is injected, never imported at
 * runtime, so this file loads under vitest.
 */
import type * as VS from "vscode";
import type { Theme } from "../config";
import { buildWebviewHtml, escapeHtml, makeNonce } from "./html";
import { skinStyles } from "./skins";
import type { ActivityState } from "./activityModel";

export type VscodeApi = typeof VS;

/** Command id that reveals the panel. Registered in extension.ts and declared in package.json. */
export const SHOW_ACTIVITY_COMMAND = "omnichat.showActivity";

export interface ActivityPanelOptions {
  vscode: VscodeApi;
  extensionUri: VS.Uri;
  getTheme: () => Theme;
}

export interface ActivityPanel {
  /** Stores the latest state and pushes it to the webview when one is open. `null` = no run. */
  update(state: ActivityState | null): void;
  /** Opens the panel (or brings it forward) and sends the latest state once the webview is ready. */
  reveal(): void;
  dispose(): void;
}

export function createActivityPanel(opts: ActivityPanelOptions): ActivityPanel {
  const { vscode } = opts;
  let latest: ActivityState | null = null;
  let panel: VS.WebviewPanel | undefined;
  let ready = false;
  let disposed = false;

  const post = (msg: unknown): void => {
    if (panel && ready) void panel.webview.postMessage(msg);
  };

  const handleMessage = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    if ((raw as { type?: unknown }).type === "ready") {
      ready = true;
      post({ type: "state", state: latest });
    }
  };

  const html = (p: VS.WebviewPanel): string => {
    const nonce = makeNonce();
    const asUri = (...parts: string[]): string =>
      p.webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, ...parts)).toString();
    const body = [
      '<main class="oc-page">',
      '<header class="oc-header"><span class="oc-plate"><span class="oc-mark"></span>OmniChat</span>',
      '<span id="oc-cwd" class="oc-activity__cwd"></span></header>',
      '<section id="oc-body" class="oc-msgs" role="region" aria-live="polite">',
      '<section id="oc-empty" class="oc-msg oc-corners">',
      '<p id="oc-empty-text" class="oc-activity__empty"></p>',
      '<p class="oc-tips"><span class="oc-tips__label">TIPS:</span><span id="oc-tips" class="oc-tips__text"></span></p>',
      "</section>",
      '<section id="oc-run" class="oc-msg oc-msg--assistant oc-corners oc-activity__run" hidden>',
      '<div class="oc-activity__head">',
      '<div class="oc-activity__phase"><span id="oc-track" class="oc-track"></span>',
      '<span id="oc-count" class="oc-track__count"></span></div>',
      '<span id="oc-phase" class="oc-activity__phase-name"></span>',
      '<span id="oc-await" class="oc-chip oc-chip--wait" hidden></span>',
      "</div>",
      '<ol id="oc-steps" class="oc-activity__steps"></ol>',
      "</section>",
      "</section>",
      "</main>",
      // Theme attributes (mode, narrow, decor) come from the shared runtime before the page script runs.
      `<script nonce="${nonce}" src="${escapeHtml(asUri("media", "webview", "theme-runtime.js"))}"></script>`,
    ].join("");
    return buildWebviewHtml({
      title: "OmniChat: 活動",
      nonce,
      cspSource: p.webview.cspSource,
      theme: opts.getTheme(),
      decorations: "auto",
      scriptUri: asUri("media", "webview", "activity.js"),
      styleUris: [
        asUri("media", "webview", "base.css"),
        asUri("media", "webview", "activity.css"),
        asUri("media", "generated", "tokens.css"),
        ...skinStyles("activity").map((s) => asUri("media", "webview", s)),
      ],
      body,
      fontUri: (name) => asUri("media", "fonts", name),
    });
  };

  const ensurePanel = (): VS.WebviewPanel => {
    if (panel) return panel;
    const p = vscode.window.createWebviewPanel(
      "omnichat.activity",
      "OmniChat: 活動",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, "media")],
      },
    );
    p.webview.html = html(p);
    const subscriptions = [
      p.webview.onDidReceiveMessage(handleMessage),
      p.onDidDispose(() => {
        for (const d of subscriptions) d.dispose();
        if (panel === p) panel = undefined;
        ready = false;
      }),
    ];
    panel = p;
    return p;
  };

  return {
    update(state) {
      if (disposed) return;
      latest = state;
      post({ type: "state", state });
    },
    reveal() {
      if (disposed) return;
      ensurePanel().reveal(undefined, false);
    },
    dispose() {
      disposed = true;
      latest = null;
      const current = panel;
      panel = undefined;
      ready = false;
      current?.dispose();
    },
  };
}
