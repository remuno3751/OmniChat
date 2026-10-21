/**
 * Pure view-model for the Settings view: the state posted to the webview and validation of the
 * messages coming back. No `vscode` import. The token is never part of the state.
 */
import { DECORATIONS, THEMES, type Decorations, type Theme } from "../config";
import { checkServerUrl, normalizeServerUrl } from "../pairing";
import type { StatusState } from "./status";
import { stringsFor, type Lang, type Strings } from "./strings";

export interface SettingsValues {
  serverUrl: string;
  deviceName: string;
  theme: Theme;
  decorations: Decorations;
  autoSave: boolean;
  shell: string;
}

export interface ThemeOption {
  id: Theme;
  label: string;
}

/** The theme picker entries, Frontier first (the default), with display names for the view language. */
export function THEME_OPTIONS(strings: Strings): ThemeOption[] {
  return [
    { id: "frontier", label: strings.themeFrontier },
    { id: "simple", label: strings.themeSimple },
    { id: "astral", label: strings.themeAstral },
  ];
}

export interface SettingsViewState extends SettingsValues {
  lang: Lang;
  strings: Strings;
  version: string;
  paired: boolean;
  status: StatusState;
  trusted: boolean;
  /** The theme picker entries in display order (`theme` stays the selected id). */
  themeOptions: ThemeOption[];
}

export function buildSettingsState(input: {
  lang: Lang;
  version: string;
  paired: boolean;
  status: StatusState;
  trusted: boolean;
  values: SettingsValues;
}): SettingsViewState {
  const strings = stringsFor(input.lang);
  return {
    ...input.values,
    lang: input.lang,
    strings,
    version: input.version,
    paired: input.paired,
    status: input.status,
    trusted: input.trusted,
    themeOptions: THEME_OPTIONS(strings),
  };
}

export type SettingKey = keyof SettingsValues;

/** The `omnichat.*` configuration id for each editable setting. */
export const CONFIG_IDS: Readonly<Record<SettingKey, string>> = {
  serverUrl: "omnichat.serverUrl",
  deviceName: "omnichat.deviceName",
  theme: "omnichat.theme",
  decorations: "omnichat.decorations",
  autoSave: "omnichat.autoSave",
  shell: "omnichat.shell",
};

export type SettingsMessage =
  | { type: "ready" }
  | { type: "unpair" }
  | { type: "openLog" }
  | { type: "pair"; code: string }
  | { type: "set"; key: SettingKey; value: string | boolean }
  /** The value failed validation; the view shows `strings.invalidUrl` or reverts the field. */
  | { type: "invalid"; key: SettingKey; reason?: "http_public" };

const MAX_NAME_CHARS = 64;
const MAX_SHELL_CHARS = 512;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Validates one value. `null` means invalid. An empty server URL is allowed (it clears the setting). */
export function validateSetting(key: SettingKey, value: unknown): string | boolean | null {
  switch (key) {
    case "serverUrl": {
      if (typeof value !== "string") return null;
      return value.trim() === "" ? "" : normalizeServerUrl(value);
    }
    case "deviceName":
    case "shell": {
      const max = key === "deviceName" ? MAX_NAME_CHARS : MAX_SHELL_CHARS;
      if (typeof value !== "string") return null;
      const v = value.trim();
      return v.length <= max && !CONTROL.test(v) ? v : null;
    }
    case "theme":
      return typeof value === "string" && (THEMES as readonly string[]).includes(value) ? value : null;
    case "decorations":
      return typeof value === "string" && (DECORATIONS as readonly string[]).includes(value) ? value : null;
    case "autoSave":
      return typeof value === "boolean" ? value : null;
  }
}

export function parseSettingsMessage(raw: unknown): SettingsMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "unpair":
    case "openLog":
      return { type: m.type };
    case "pair":
      return typeof m.code === "string" && m.code.length > 0 && m.code.length <= 8192
        ? { type: "pair", code: m.code }
        : null;
    case "set": {
      if (typeof m.key !== "string" || !Object.hasOwn(CONFIG_IDS, m.key)) return null;
      const key = m.key as SettingKey;
      const value = validateSetting(key, m.value);
      if (value !== null) return { type: "set", key, value };
      if (key === "serverUrl") {
        const r = checkServerUrl(m.value);
        if (!r.ok && r.reason === "http_public") return { type: "invalid", key, reason: "http_public" };
      }
      return { type: "invalid", key };
    }
    default:
      return null;
  }
}
