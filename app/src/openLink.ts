// Pure planning for opening an external or custom-scheme link (the VS Code pairing link) from the web UI.
// Why: window.open / Linking.openURL of a custom scheme opens a blank tab on the web, and the desktop shell (WebView2)
// ignores custom-scheme navigations. The desktop shell therefore offers window.__OMNICHAT_DESKTOP__.openExternal(url).

export type LinkPlan = 'desktop' | 'location' | 'window-open' | 'linking' | 'none';

export const MAX_LINK_CHARS = 8192;

/** Same limits as the shell: non-empty, at most 8192 characters, no control characters, a parseable scheme. */
export function isOpenableLink(url: string): boolean {
  return typeof url === 'string' && url.length > 0 && url.length <= MAX_LINK_CHARS && !/[\u0000-\u001f\u007f]/.test(url) && /^[a-z][a-z0-9+.-]*:/i.test(url);
}

const isWebScheme = (url: string): boolean => /^https?:/i.test(url);

/**
 * How to open `url`:
 * - 'desktop': the desktop shell's openExternal bridge (inside the desktop app);
 * - 'location': `window.location.href = url` in the click handler (web, custom scheme: no blank tab);
 * - 'window-open': a new tab (web, http/https);
 * - 'linking': React Native Linking.openURL (iOS / Android);
 * - 'none': not a usable link.
 */
export function openLinkPlan(platform: string, hasDesktopBridge: boolean, url: string): LinkPlan {
  if (!isOpenableLink(url)) return 'none';
  if (platform === 'web') {
    if (hasDesktopBridge) return 'desktop';
    return isWebScheme(url) ? 'window-open' : 'location';
  }
  return 'linking';
}
