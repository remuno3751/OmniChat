// Pure helper for the client (app) version line shown in Settings > Updates.

export type ClientVersionLine = { key: 'update.appVersion' | 'update.webVersion' | 'update.desktopVersion'; version: string };

/**
 * Which client version to show. Native builds show the app version. On the web the app is the bundle the
 * server serves, so it is labelled as the web client; when the desktop shell exposes its own version the
 * desktop version is shown instead.
 */
export function clientVersionLine(platformOs: string, appVersion: string, desktopVersion?: string | null): ClientVersionLine {
  if (platformOs !== 'web') return { key: 'update.appVersion', version: appVersion };
  if (desktopVersion) return { key: 'update.desktopVersion', version: desktopVersion };
  return { key: 'update.webVersion', version: appVersion };
}

/** Reads the desktop shell's version from the page, if the shell provides it. */
export function desktopVersionFromWindow(win: any): string | null {
  const v = win?.__OMNICHAT_DESKTOP__?.version;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
