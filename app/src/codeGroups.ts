import type { Conversation, Provider } from './protocol';
import { bridgeNameOfDevice } from './deviceList';

/* Code tab: grouping by workspace (working folder) and device (PC / bridge). Pure; docs/design/CODE-WORKSPACES.md. */

/** Grouping key of a folder: `\` -> `/`, no trailing `/`, lower case for Windows-style paths. Same rule as the server and the plugin. */
export function normCwd(p: string | null | undefined): string {
  if (typeof p !== 'string' || !p) return '';
  let r = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(r) || p.includes('\\')) r = r.toLowerCase();
  return r;
}

/** Folder segments of a path (empty segments dropped). */
const segments = (p: string): string[] => p.replace(/\\/g, '/').split('/').filter(Boolean);

/** The folder name shown for a path ("C:\\work\\app\\" -> "app"). A bare root keeps the root. */
export function cwdLabel(p: string): string {
  const s = segments(p);
  return s.length ? s[s.length - 1] : p;
}

/** Provider kinds that run Code on a PC: the DeepSeek Harness plugin and the VS Code extension (baseUrl = the bridge / PC name). */
export const DSH_KIND = 'dsh-bridge';
export const VSCODE_KIND = 'vscode-bridge';
export const isAgentBridgeKind = (k: string | null | undefined): boolean => k === DSH_KIND || k === VSCODE_KIND;
/** The GET /bridges `kind` a provider kind talks to (null for a non-bridge provider). */
export const bridgeKindOfProvider = (k: string | null | undefined): 'dsh' | 'vscode' | null => (k === DSH_KIND ? 'dsh' : k === VSCODE_KIND ? 'vscode' : null);

/** The device (bridge name) a conversation runs on: its dsh-bridge / vscode-bridge provider's baseUrl; null when it has none. */
export function deviceOf(c: Conversation, providers: Record<string, Provider>): string | null {
  const p = c.providerId ? providers[c.providerId] : undefined;
  if (!p || !isAgentBridgeKind(p.kind)) return null;
  return (p.baseUrl ?? '').trim() || null;
}

/** The distinct devices of these conversations, sorted by name. */
export function devicesOf(convs: Conversation[], providers: Record<string, Provider>): string[] {
  const set = new Set<string>();
  for (const c of convs) { const d = deviceOf(c, providers); if (d) set.add(d); }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface CodeGroup {
  /** stable id for the collapsed state ("ws:<device>|<normalized folder>"; folder empty = Other) */
  key: string;
  /** folder name; '' for the Other group (the UI shows its own label) */
  label: string;
  /** full path as last reported, null for Other */
  path: string | null;
  device: string | null;
  /** newest updatedAt in the group */
  latest: number;
  convs: Conversation[];
}
export interface DeviceGroup {
  key: string;
  device: string | null;
  latest: number;
  groups: CodeGroup[];
}

export const workspaceKey = (device: string | null, cwd: string | null | undefined): string => `ws:${device ?? ''}|${normCwd(cwd)}`;
export const deviceKey = (device: string | null): string => `dev:${device ?? ''}`;

/**
 * Groups conversations by working folder. Groups are ordered by their newest conversation (the Other group, without a known folder, last),
 * conversations inside by updatedAt. Two folders with the same name get their parent added to the label.
 * `byDevice`: workspaces of different devices are separate groups (same folder on two PCs); pass false when there is one device.
 */
export function groupByWorkspace(convs: Conversation[], providers: Record<string, Provider>, byDevice = true): CodeGroup[] {
  const map = new Map<string, CodeGroup>();
  for (const c of convs) {
    const device = byDevice ? deviceOf(c, providers) : null;
    const key = workspaceKey(device, c.cwd);
    let g = map.get(key);
    if (!g) {
      g = { key, label: c.cwd ? cwdLabel(c.cwd) : '', path: c.cwd || null, device, latest: 0, convs: [] };
      map.set(key, g);
    }
    g.convs.push(c);
    if (c.updatedAt > g.latest) { g.latest = c.updatedAt; if (c.cwd) g.path = c.cwd; }
  }
  const groups = [...map.values()];
  for (const g of groups) g.convs.sort((a, b) => b.updatedAt - a.updatedAt);
  // same folder name in different places: show "parent/name"
  const byLabel = new Map<string, CodeGroup[]>();
  for (const g of groups) if (g.path) byLabel.set(g.label + '\u0000' + (g.device ?? ''), [...(byLabel.get(g.label + '\u0000' + (g.device ?? '')) ?? []), g]);
  for (const same of byLabel.values()) {
    if (same.length < 2) continue;
    for (const g of same) { const s = segments(g.path!); if (s.length >= 2) g.label = `${s[s.length - 2]}/${s[s.length - 1]}`; }
  }
  return groups.sort((a, b) => (a.path === null ? 1 : 0) - (b.path === null ? 1 : 0) || b.latest - a.latest);
}

/** Two levels: device first (newest first, conversations without a device last), then its workspaces. */
export function groupByDevice(convs: Conversation[], providers: Record<string, Provider>): DeviceGroup[] {
  const per = new Map<string, Conversation[]>();
  for (const c of convs) {
    const d = deviceOf(c, providers) ?? '';
    per.set(d, [...(per.get(d) ?? []), c]);
  }
  const out: DeviceGroup[] = [];
  for (const [d, list] of per) {
    const groups = groupByWorkspace(list, providers, false).map((g) => ({ ...g, key: workspaceKey(d || null, g.path), device: d || null }));
    out.push({ key: deviceKey(d || null), device: d || null, latest: Math.max(...list.map((c) => c.updatedAt)), groups });
  }
  return out.sort((a, b) => (a.device === null ? 1 : 0) - (b.device === null ? 1 : 0) || b.latest - a.latest);
}

/** Per device name: the normalized folders its Code chats run in. Those folders are already a workspace group on the Code tab. */
export function codeChatFolders(convs: Conversation[], providers: Record<string, Provider>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const c of convs) {
    if (c.deleted || (c.mode ?? 'chat') !== 'code' || !c.cwd) continue;
    const dev = deviceOf(c, providers);
    if (!dev) continue;
    const set = out.get(dev) ?? new Set<string>();
    set.add(normCwd(c.cwd));
    out.set(dev, set);
  }
  return out;
}

/** Why a new Code chat cannot start in a workspace group ('offline' PC, folder not open in VS Code, or no folder picker); null = it can. */
export type StartBlock = 'offline' | 'notOpen' | 'unavailable';
export function startBlock(dev: { online: boolean; kind: 'dsh' | 'vscode'; workspaces: boolean } | undefined, openHere: boolean): StartBlock | null {
  if (!dev) return 'unavailable';
  if (!dev.online) return 'offline';
  if (!dev.workspaces) return 'unavailable';
  if (dev.kind === 'vscode' && !openHere) return 'notOpen';
  return null;
}

/**
 * Splits the conversations of hidden devices off a Code list. `hiddenNames` are the device names the Devices screen
 * stored when a revoke chose "hide" ("VS Code (my-pc)"); a conversation belongs to a hidden device when its bridge
 * name (`deviceOf`) is the bridge name inside one of them. Nothing hidden gives every conversation as shown.
 */
export function splitHiddenDeviceChats(convs: Conversation[], providers: Record<string, Provider>, hiddenNames: string[]): { shown: Conversation[]; hidden: Conversation[] } {
  const bridges = new Set<string>();
  for (const n of hiddenNames) { const b = bridgeNameOfDevice(n); if (b) bridges.add(b); }
  if (bridges.size === 0) return { shown: convs, hidden: [] };
  const shown: Conversation[] = [];
  const hidden: Conversation[] = [];
  for (const c of convs) {
    const d = deviceOf(c, providers);
    (d !== null && bridges.has(d) ? hidden : shown).push(c);
  }
  return { shown, hidden };
}
