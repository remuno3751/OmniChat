/**
 * Which Frontier skin sheets (media/webview/skin-frontier*.css) each webview loads. The sheets are
 * layers gated by `:root[data-oc-theme="frontier"]`, so they are harmless under Simple and Astral.
 * They load last, after the tokens. Pure: no `vscode` import.
 */

/** The view kinds that load skin sheets. `activity` is the live-activity panel. */
export type SkinView = "chat" | "settings" | "activity";

/** Skin sheet names under media/webview/, per part. Kept static; the tests check each file exists. */
export const SKIN_STYLES: Readonly<{ shared: readonly string[]; chat: readonly string[]; settings: readonly string[] }> = {
  shared: ["skin-frontier.css"],
  chat: ["skin-frontier-chat.css", "skin-frontier-chat2.css"],
  settings: [],
};

/** The skin sheet names (under media/webview/) a view loads, in load order. */
export function skinStyles(view: SkinView): string[] {
  if (view === "chat") return [...SKIN_STYLES.shared, ...SKIN_STYLES.chat];
  if (view === "settings") return [...SKIN_STYLES.shared, ...SKIN_STYLES.settings];
  return [...SKIN_STYLES.shared];
}
