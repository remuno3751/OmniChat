// Pure helpers for the client (app) version lines shown in Settings > General (About) and Settings > Updates.

export type ClientVersionLine = { key: 'update.appVersion' | 'update.webVersion' | 'update.desktopVersion'; version: string };

/**
 * The desktop build stamps its version through tools/set-version.mjs, which keeps a pre-release number as a bare
 * numeric suffix ("v0.5.5-beta.2" is built as "0.5.5-2", because MSI/WiX only takes numeric pre-release parts).
 * Every pre-release tag in this repo is "-beta.N", so "x.y.z-N" is shown as "x.y.z-beta.N". Other strings are kept as they are.
 */
export function normalizeDesktopVersion(v: string): string {
  const m = /^(\d+\.\d+\.\d+)-(\d+)$/.exec(v.trim());
  return m ? `${m[1]}-beta.${m[2]}` : v.trim();
}

/**
 * Which client version to show. Native builds show the app version. On the web the app is the bundle the
 * server serves, so it is labelled as the web client; when the desktop shell exposes its own version the
 * desktop version is shown instead.
 */
export function clientVersionLine(platformOs: string, appVersion: string, desktopVersion?: string | null): ClientVersionLine {
  if (platformOs !== 'web') return { key: 'update.appVersion', version: appVersion };
  if (desktopVersion) return { key: 'update.desktopVersion', version: normalizeDesktopVersion(desktopVersion) };
  return { key: 'update.webVersion', version: appVersion };
}

/**
 * Settings > General > About line. The desktop app shows its own version without a platform suffix
 * (the page runs in the webview, so Platform.OS is 'web' there).
 */
export function aboutVersionLine(platformOs: string, appVersion: string, desktopVersion?: string | null):
  { key: 'general.aboutVersion' | 'general.aboutVersionPlain'; params: Record<string, string> } {
  if (desktopVersion) return { key: 'general.aboutVersionPlain', params: { version: normalizeDesktopVersion(desktopVersion) } };
  return { key: 'general.aboutVersion', params: { version: appVersion, platform: platformOs } };
}

/** Reads the desktop shell's version from the page, if the shell provides it. */
export function desktopVersionFromWindow(win: any): string | null {
  const v = win?.__OMNICHAT_DESKTOP__?.version;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
