/**
 * Pure settings readers for the `omnichat.*` configuration (spec
 * docs/design/VSCODE-BRIDGE.md §3, §5, §6). The VS Code wiring injects
 * `getConfig`, so this module never imports `vscode`.
 */

export const THEMES = ["simple", "frontier", "astral"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "frontier";

export const DECORATIONS = ["auto", "on", "off"] as const;
export type Decorations = (typeof DECORATIONS)[number];

export interface OmniChatConfig {
  /** Trimmed server URL; empty when unset. */
  serverUrl: string;
  theme: Theme;
  /** `omnichat.decorations`: the view background ornaments (spec §5). */
  decorations: Decorations;
  /** Shell override for run_command. `undefined` means the platform default. */
  shell: string | undefined;
  /** Save after OmniChat edits (spec `omnichat.autoSave`, default true). */
  autoSave: boolean;
}

/**
 * Reads one setting by its full id, for example `"omnichat.theme"`. Returns
 * `undefined` when the setting is unset. The wiring passes
 * `(id) => vscode.workspace.getConfiguration().get(id)`.
 */
export type GetConfig = (section: string) => unknown;

/** Unknown or non-string values fall back to the default theme. */
export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : DEFAULT_THEME;
}

/** Unknown values fall back to `auto`. */
export function parseDecorations(value: unknown): Decorations {
  return typeof value === "string" && (DECORATIONS as readonly string[]).includes(value) ? (value as Decorations) : "auto";
}

export function parseServerUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A blank or non-string shell means "use the platform default". */
export function parseShell(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Non-boolean values fall back to the default (`true`). */
export function parseAutoSave(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

/** Reads and validates every `omnichat.*` setting this extension uses. */
export function readConfig(getConfig: GetConfig): OmniChatConfig {
  return {
    serverUrl: parseServerUrl(getConfig("omnichat.serverUrl")),
    theme: parseTheme(getConfig("omnichat.theme")),
    decorations: parseDecorations(getConfig("omnichat.decorations")),
    shell: parseShell(getConfig("omnichat.shell")),
    autoSave: parseAutoSave(getConfig("omnichat.autoSave")),
  };
}
