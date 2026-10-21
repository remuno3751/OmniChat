import type { BridgeInfo } from './api';
import type { Conversation, Provider } from './protocol';
import { VSCODE_KIND, normCwd } from './codeGroups';
import { workspaceOptions } from './codeWorkspace';
import { compareSemver } from './updateState';

/* VS Code bridge (docs/design/VSCODE-BRIDGE.md sections 6 and 8): pure helpers, no React. */

/** Version of the bundled omnichat-vscode extension (vscode-ext/package.json; a test keeps it in step). */
export const VSCODE_EXT_VERSION = '0.2.6';
export const VSCODE_PROVIDER_NAME = 'VS Code (PC bridge)';
export const VSCODE_PROVIDER_MODEL = 'vscode';

/** File name of the extension package for a version. */
export const vsixName = (version: string): string => `omnichat-vscode-${version}.vsix`;
export const installCommand = (version: string): string => `code --install-extension ${vsixName(version)}`;

/** True for a plain version string that is safe to put in a file name and shell command. */
export const isSafeVersion = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(v);

/* ---- pairing code ---- */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** base64url (no padding) of the UTF-8 text. Own implementation: no Buffer / btoa on every platform. */
export function base64UrlEncode(text: string): string {
  const b = utf8Bytes(text);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) out += B64[(n >> 6) & 63];
    if (i + 2 < b.length) out += B64[n & 63];
  }
  return out;
}

/** Inverse of base64UrlEncode (used by tests). Returns null for malformed input. */
export function base64UrlDecode(code: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(code)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < code.length; i += 4) {
    const chunk = code.slice(i, i + 4);
    if (chunk.length === 1) return null;
    const v = [...chunk].map((c) => B64.indexOf(c));
    const n = (v[0] << 18) | (v[1] << 12) | ((v[2] ?? 0) << 6) | (v[3] ?? 0);
    bytes.push((n >> 16) & 255);
    if (chunk.length > 2) bytes.push((n >> 8) & 255);
    if (chunk.length > 3) bytes.push(n & 255);
  }
  try {
    return decodeURIComponent(bytes.map((b) => '%' + b.toString(16).padStart(2, '0')).join(''));
  } catch {
    return null;
  }
}

/** The pairing code the extension takes: base64url of JSON {s: server URL, t: device token, n: PC name}. */
export function pairingCode(serverUrl: string, token: string, name: string): string {
  return base64UrlEncode(JSON.stringify({ s: serverUrl, t: token, n: name }));
}
export const pairingLink = (code: string): string => `vscode://omnichat.omnichat-vscode/pair?code=${encodeURIComponent(code)}`;

/* ---- provider ---- */
/** True when a live vscode-bridge provider for this PC name exists. */
export function hasVscodeProvider(providers: Provider[], name: string): boolean {
  const n = name.trim();
  return providers.some((p) => p.kind === VSCODE_KIND && !p.deleted && (p.baseUrl ?? '').trim() === n);
}
/** Whether the "add provider automatically" switch should create one now. */
export function shouldAutoAddProvider(auto: boolean, providers: Provider[], name: string): boolean {
  return auto && name.trim() !== '' && !hasVscodeProvider(providers, name);
}
export const vscodeProviderBody = (name: string) => ({ name: VSCODE_PROVIDER_NAME, kind: VSCODE_KIND, baseUrl: name.trim(), model: VSCODE_PROVIDER_MODEL });

/* ---- bridge list ---- */
export const isVscodeBridge = (b: BridgeInfo): boolean => b.kind === 'vscode';
export const vscodeBridges = (bridges: BridgeInfo[] | null | undefined): BridgeInfo[] => (bridges ?? []).filter(isVscodeBridge);
/** The VS Code integration counts as enabled once any vscode bridge is known (online now or paired earlier). */
export const vscodeEnabled = (bridges: BridgeInfo[] | null | undefined): boolean => vscodeBridges(bridges).length > 0;

export type CompatState = 'ok' | 'tooOld' | 'unknown';
/** Server verdict first; without it, compare the extension version with the minimum when both are known. */
export function compatState(b: BridgeInfo): CompatState {
  if (b.compat) {
    if (!b.compat.ok) return 'tooOld';
    return 'ok';
  }
  return 'unknown';
}
/** True when a newer extension than the one the PC runs ships with this app. */
export function extensionOutdated(b: BridgeInfo, bundled: string = VSCODE_EXT_VERSION): boolean {
  if (!b.version) return false;
  try { return compareSemver(bundled, b.version) > 0; } catch { return false; }
}

/* ---- Code tab "VS Code" section ---- */
export interface VscodeDevice {
  /** the PC / bridge name */
  name: string;
  online: boolean;
  version?: string;
  /** folders to start a chat in: the ones VS Code has open (online), then folders of known chats */
  workspaces: string[];
  /** the vscode-bridge provider for this PC, null when none exists yet */
  providerId: string | null;
}

/** Devices of the VS Code section, online first then by name. Empty (section hidden) unless the integration is enabled. */
export function vscodeSection(bridges: BridgeInfo[] | null | undefined, providers: Provider[], convs: Conversation[], provMap: Record<string, Provider>): VscodeDevice[] {
  if (!vscodeEnabled(bridges)) return [];
  const out: VscodeDevice[] = vscodeBridges(bridges).map((b) => {
    const name = b.name.trim();
    const p = providers.find((x) => x.kind === VSCODE_KIND && !x.deleted && (x.baseUrl ?? '').trim() === name);
    return {
      name,
      online: !!b.online,
      version: b.version,
      workspaces: workspaceOptions(name, [b], convs, provMap, 'vscode'),
      providerId: p?.id ?? null,
    };
  });
  return out.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** What tapping a workspace does: start, or why not. */
export function startTarget(d: VscodeDevice, cwd: string): { ok: true; providerId: string | null; cwd: string } | { ok: false; reason: 'offline' } {
  if (!d.online) return { ok: false, reason: 'offline' };
  return { ok: true, providerId: d.providerId, cwd };
}

/** Folder is currently open in VS Code on this PC (only those can run; older chat folders can not). */
export function workspaceOpen(b: BridgeInfo | undefined, cwd: string): boolean {
  if (!b || !b.online) return false;
  const k = normCwd(cwd);
  return (b.workspaces ?? []).some((w) => normCwd(w) === k);
}

/** i18n key for a server error code about the VS Code bridge, or null for other codes. */
export function codeBridgeErrorKey(code: string | undefined): string | null {
  switch (code) {
    case 'workspace_not_open': return 'code.vscode.err.workspaceNotOpen';
    case 'bridge_offline':
    case 'bridge_not_connected':
    case 'no_bridge': return 'code.vscode.err.offline';
    case 'bridge_busy': return 'code.vscode.err.busy';
    case 'extension_too_old': return 'code.vscode.err.tooOld';
    default: return null;
  }
}

/* ---- pending start from the Code tab list (taken once by the new chat screen) ---- */
export interface PendingCodeStart { providerId: string; cwd: string }
let pendingStart: PendingCodeStart | null = null;
export function setPendingCodeStart(s: PendingCodeStart | null): void { pendingStart = s; }
export function takePendingCodeStart(): PendingCodeStart | null {
  const s = pendingStart;
  pendingStart = null;
  return s;
}
