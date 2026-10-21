// Pure helpers for the desktop client update controls (Settings > Updates). The desktop shell exposes the bridge
// window.__OMNICHAT_DESKTOP__.{checkUpdate, openUpdate, getUpdateChannel, setUpdateChannel} (see desktop/src-tauri/src/lib.rs).
import type { Channel } from './updateTypes';
import { updateErrorText } from './updateState';

export interface DesktopCheckResult {
  status: 'available' | 'latest' | 'error';
  current: string;
  latest?: string;
  channel: Channel;
  canInstall: boolean;
  error?: string;
}

export interface DesktopUpdateBridge {
  checkUpdate: () => Promise<unknown>;
  openUpdate: () => Promise<unknown>;
  getUpdateChannel?: () => Promise<unknown>;
  setUpdateChannel?: (ch: Channel) => Promise<unknown>;
}

/** The shell's update bridge, or null (plain browser, older shell without the bridge). */
export function desktopUpdateBridge(win: any): DesktopUpdateBridge | null {
  const d = win?.__OMNICHAT_DESKTOP__;
  if (d && typeof d.checkUpdate === 'function' && typeof d.openUpdate === 'function') return d as DesktopUpdateBridge;
  return null;
}

export function asChannel(v: unknown): Channel | null {
  return v === 'stable' || v === 'prerelease' ? v : null;
}

/** Tolerant parse of what the shell returned; anything unusable becomes an "error" result. Never throws. */
export function parseCheckResult(raw: unknown): DesktopCheckResult {
  const o: any = raw && typeof raw === 'object' ? raw : {};
  const status = o.status === 'available' || o.status === 'latest' || o.status === 'error' ? o.status : 'error';
  const res: DesktopCheckResult = {
    status,
    current: typeof o.current === 'string' ? o.current : '',
    channel: asChannel(o.channel) ?? 'stable',
    canInstall: o.canInstall === true,
  };
  if (typeof o.latest === 'string' && o.latest) res.latest = o.latest;
  if (status === 'error') res.error = typeof o.error === 'string' && o.error ? o.error : 'other';
  if (status === 'available' && !res.latest) return { ...res, status: 'error', error: 'other' };
  return res;
}

export interface CheckResultText {
  key: string;
  params: Record<string, string | number>;
  danger: boolean;
}

/** i18n key + params for the result line. Errors reuse the update.err.* keys of the server update system. */
export function checkResultText(r: DesktopCheckResult): CheckResultText {
  if (r.status === 'available') return { key: 'update.desktop.available', params: { version: r.latest ?? '' }, danger: false };
  if (r.status === 'latest') return { key: 'update.desktop.latest', params: { version: r.current }, danger: false };
  const e = updateErrorText({ code: r.error ?? 'other' });
  return { key: e.key, params: e.params, danger: true };
}

/** A version with a pre-release part (contains a hyphen) is a pre-release. */
export function isPrereleaseVersion(v: string | undefined): boolean {
  return !!v && v.includes('-');
}

/** Hint under the Update button: Windows installs in place; other systems open the release page. */
export function updateActionHintKey(r: DesktopCheckResult): string | null {
  if (r.status !== 'available') return null;
  return r.canInstall ? 'update.desktop.installHint' : 'update.desktop.pageHint';
}
