// Pure helpers for the login screen's "Server URL" field.
// The web build served by the OmniChat server itself talks to its own origin, so the field is redundant there.

export type LocationLike = { origin?: string; protocol?: string; port?: string } | null | undefined;

/** Expo dev servers (web on 8081 / 19006) are not the OmniChat server, so the URL field stays for them. */
export function isExpoDevPort(port: string | undefined): boolean {
  return port === '8081' || port === '19006';
}

/**
 * The origin of the page when it is served by the OmniChat server itself, or null when the page is not
 * served over http(s) or runs on an Expo dev server.
 */
export function serverOriginForPage(loc: LocationLike): string | null {
  if (!loc || !loc.origin || !loc.protocol || !/^https?:$/.test(loc.protocol)) return null;
  if (isExpoDevPort(loc.port)) return null;
  return loc.origin;
}

/**
 * Show the Server URL field unless this is the web build served by the server itself.
 * Native (android / ios) always shows it.
 */
export function shouldShowServerUrlField(platformOs: string, loc: LocationLike): boolean {
  if (platformOs !== 'web') return true;
  return serverOriginForPage(loc) === null;
}
