/** The OS in a browser user-agent, for the desktop app (a webview: its UA says Edge/Safari, which is not what the user runs). */
function osFromUa(ua: string): string {
  return /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : '';
}

/** Name for a web page: the browser, or "OmniChat Desktop (<OS>)" inside the desktop app (window.__OMNICHAT_DESKTOP__). */
export function webDeviceName(ua: string, desktop: boolean): string {
  if (desktop) { const os = osFromUa(ua); return os ? `OmniChat Desktop (${os})` : 'OmniChat Desktop'; }
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `Web (${b})`;
}
