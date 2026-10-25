/**
 * Generic WebviewViewProvider for the sidebar views (docs/design/VSCODE-BRIDGE.md §5). It renders the
 * shared HTML shell (strict CSP + nonce, tokens, theme runtime) around one empty `#oc-root`, and the
 * page script builds the UI from the state the host posts. `vscode` is injected, so this loads under vitest.
 */
import type * as VS from "vscode";
import type { Decorations, Theme } from "../config";
import { buildWebviewHtml, escapeHtml, makeNonce } from "./html";
import { skinStyles, type SkinView } from "./skins";

export interface ViewProviderOptions {
  vscode: typeof VS;
  extensionUri: VS.Uri;
  /** View title, used as the document title. */
  title: string;
  /** Page script under media/webview/. */
  script: string;
  /** Extra stylesheets under media/webview/, loaded after base.css. */
  styles: readonly string[];
  /** Which Frontier skin sheets to load after the tokens. Omitted: the shared sheet only. */
  skin?: Exclude<SkinView, "activity">;
  getTheme: () => Theme;
  getDecorations: () => Decorations;
  /** The webview posted `ready` (also after it was hidden and recreated): push the state now. */
  onReady: () => void;
  /** Any other message from the webview, unvalidated. */
  onMessage: (raw: unknown) => void;
  /** Waits this long before the first HTML write, so two views never load at the same instant (VS Code can fail the service worker then). */
  deferHtmlMs?: number;
}

/** A view that has not said `ready` by then is rebuilt (at most RETRIES times). */
const READY_WATCHDOG_MS = 6000;
const READY_RETRIES = 2;

export interface ViewHandle {
  provider: VS.WebviewViewProvider;
  /** Posts to the webview; dropped until it is ready. */
  post(message: unknown): void;
  /** Rebuilds the HTML (theme or decorations changed). */
  refresh(): void;
  /** Brings the view to the front (the view must be registered). */
  reveal(): void;
  isVisible(): boolean;
  readonly viewId: string;
}

/** The page options a view or panel shares (what the HTML shell and its stylesheets are built from). */
export type PageOptions = Pick<
  ViewProviderOptions,
  "vscode" | "extensionUri" | "title" | "script" | "styles" | "skin" | "getTheme" | "getDecorations"
>;

/** The HTML of a chat page for `webview`: the shared shell, the page script and stylesheets. Used by the sidebar views and the editor panel. */
export function buildPageHtml(webview: VS.Webview, opts: PageOptions): string {
  const { vscode } = opts;
  const nonce = makeNonce();
  const asUri = (...parts: string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(opts.extensionUri, ...parts)).toString();
  const body = [
    '<main id="oc-root" class="oc-page"></main>',
    `<script nonce="${nonce}" src="${escapeHtml(asUri("media", "webview", "theme-runtime.js"))}"></script>`,
  ].join("");
  return buildWebviewHtml({
    title: opts.title,
    nonce,
    cspSource: webview.cspSource,
    theme: opts.getTheme(),
    decorations: opts.getDecorations(),
    scriptUri: asUri("media", "webview", opts.script),
    styleUris: [
      asUri("media", "webview", "base.css"),
      ...opts.styles.map((s) => asUri("media", "webview", s)),
      asUri("media", "generated", "tokens.css"),
      ...skinStyles(opts.skin ?? "activity").map((s) => asUri("media", "webview", s)),
    ],
    body,
    fontUri: (name) => asUri("media", "fonts", name),
  });
}

export function createViewProvider(viewId: string, opts: ViewProviderOptions): ViewHandle {
  const { vscode } = opts;
  let view: VS.WebviewView | undefined;
  let ready = false;

  const html = (webview: VS.Webview): string => buildPageHtml(webview, opts);

  let subscriptions: VS.Disposable[] = [];
  let pendingRefresh = false;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
  const later = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms));
  };
  const dropSubscriptions = (): void => {
    for (const d of subscriptions) {
      try {
        d.dispose();
      } catch {
        // already disposed
      }
    }
    subscriptions = [];
    clearTimers();
  };

  /** Sets the HTML once per call; never touches a disposed view (VS Code can throw InvalidStateError then). */
  const setHtml = (v: VS.WebviewView): void => {
    if (view !== v) return;
    try {
      v.webview.html = html(v.webview);
    } catch {
      // the view went away between the check and the write: nothing to update
    }
  };

  const provider: VS.WebviewViewProvider = {
    resolveWebviewView(v) {
      // Idempotent: a second resolve (VS Code re-creates the view) replaces the first cleanly.
      dropSubscriptions();
      view = v;
      ready = false;
      pendingRefresh = false;
      try {
        v.webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(opts.extensionUri, "media")],
        };
      } catch {
        // options can only be set while the view is alive
      }
      const load = (retriesLeft: number): void => {
        if (view !== v) return;
        setHtml(v);
        if (retriesLeft > 0) {
          later(READY_WATCHDOG_MS, () => {
            if (view === v && !ready && v.visible) load(retriesLeft - 1);
          });
        }
      };
      if (opts.deferHtmlMs && opts.deferHtmlMs > 0) later(opts.deferHtmlMs, () => load(READY_RETRIES));
      else load(READY_RETRIES);
      subscriptions = [
        v.webview.onDidReceiveMessage((raw: unknown) => {
          if (view !== v) return;
          if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ready") {
            ready = true;
            opts.onReady();
          } else {
            opts.onMessage(raw);
          }
        }),
        v.onDidDispose(() => {
          if (view === v) {
            dropSubscriptions();
            view = undefined;
            ready = false;
            pendingRefresh = false;
          }
        }),
      ];
    },
  };

  return {
    provider,
    viewId,
    post(message) {
      if (!view || !ready) return;
      try {
        void Promise.resolve(view.webview.postMessage(message)).catch(() => undefined);
      } catch {
        // disposed view: drop the message
      }
    },
    refresh() {
      // Coalesce bursts (theme + decorations changed together) into one HTML write.
      if (!view || pendingRefresh) return;
      pendingRefresh = true;
      const target = view;
      queueMicrotask(() => {
        if (!pendingRefresh || view !== target) return;
        pendingRefresh = false;
        ready = false; // the rebuilt page sends "ready" again
        setHtml(target);
      });
    },
    reveal() {
      view?.show(false);
    },
    isVisible() {
      return view?.visible === true;
    },
  };
}
