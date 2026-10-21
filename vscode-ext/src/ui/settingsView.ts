/**
 * The "Settings" sidebar view: server and pairing state, bridge name, theme, decorations, autoSave,
 * shell, trust note, Unpair and Open log. Values are read from and written to the `omnichat.*`
 * configuration; the token lives only in SecretStorage and is never part of the state.
 * `vscode` is injected.
 */
import type * as VS from "vscode";
import type { Decorations, Theme } from "../config";
import {
  buildSettingsState,
  CONFIG_IDS,
  parseSettingsMessage,
  type SettingKey,
  type SettingsValues,
} from "./settingsModel";
import type { StatusState } from "./status";
import type { PairReason } from "../pairing";
import { stringsFor, type Lang } from "./strings";
import { createViewProvider, type ViewHandle } from "./viewProvider";

export const SETTINGS_VIEW_ID = "omnichat.settings";

export interface SettingsViewOptions {
  vscode: typeof VS;
  extensionUri: VS.Uri;
  lang: Lang;
  version: string;
  getTheme: () => Theme;
  getDecorations: () => Decorations;
  readValues: () => SettingsValues;
  isPaired: () => boolean;
  getStatus: () => StatusState;
  pair: (code: string) => Promise<PairReason | null>;
  /** Runs a contributed command, e.g. "omnichat.unpair". */
  runCommand: (id: string) => void;
}

export interface SettingsView {
  handle: ViewHandle;
  update(): void;
}

export function createSettingsView(opts: SettingsViewOptions): SettingsView {
  const { vscode } = opts;
  const s = stringsFor(opts.lang);

  const update = (): void => {
    handle.post({
      type: "state",
      state: buildSettingsState({
        lang: opts.lang,
        version: opts.version,
        paired: opts.isPaired(),
        status: opts.getStatus(),
        trusted: vscode.workspace.isTrusted,
        values: opts.readValues(),
      }),
    });
  };

  const write = async (key: SettingKey, value: string | boolean): Promise<void> => {
    try {
      await vscode.workspace.getConfiguration().update(CONFIG_IDS[key], value, vscode.ConfigurationTarget.Global);
      handle.post({ type: "notice", key, ok: true, text: s.saved });
    } catch {
      handle.post({ type: "notice", key, ok: false, text: s.errors.generic });
    }
    update();
  };

  const onMessage = (raw: unknown): void => {
    const msg = parseSettingsMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "set":
        void write(msg.key, msg.value);
        return;
      case "invalid":
        handle.post({ type: "notice", key: msg.key, ok: false, text: msg.key === "serverUrl" ? (msg.reason === "http_public" ? s.invalidUrlHttp : s.invalidUrl) : s.errors.generic });
        update();
        return;
      case "pair":
        void opts.pair(msg.code).then((reason) => {
          if (reason) handle.post({ type: "notice", key: "pair", ok: false, text: s.pairReasons[reason] ?? s.pairInvalid });
        });
        return;
      case "unpair":
        return opts.runCommand("omnichat.unpair");
      case "openLog":
        return opts.runCommand("omnichat.showLog");
      case "ready":
        return;
    }
  };

  const handle = createViewProvider(SETTINGS_VIEW_ID, {
    vscode,
    extensionUri: opts.extensionUri,
    title: `OmniChat VS: ${s.settings}`,
    script: "settings.js",
    styles: ["settings.css"],
    skin: "settings",
    getTheme: opts.getTheme,
    getDecorations: opts.getDecorations,
    onReady: update,
    onMessage,
    deferHtmlMs: 700,
  });

  return { handle, update };
}
