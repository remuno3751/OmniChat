import type { BridgeInfo } from './api';
import type { Conversation, Provider } from './protocol';
import { bridgeKindOfProvider, deviceOf, normCwd } from './codeGroups';

/* Code tab, new chat: which device and workspace the first message goes to. Pure; docs/design/CODE-WORKSPACES.md. */

export interface CodeDevice {
  providerId: string;
  /** bridge name */
  name: string;
  online: boolean;
  /** the bridge reports workspaces (plugin >= 0.9.0): the picker can send a cwd */
  workspaces: boolean;
  /** which kind of bridge: DeepSeek Harness or the VS Code extension */
  kind: 'dsh' | 'vscode';
}

const MAX_OPTIONS = 30;

/** The user's PCs: one entry per live dsh-bridge provider, sorted by name. Online state comes from GET /bridges (offline when absent). */
export function codeDevices(providers: Provider[], bridges: BridgeInfo[] | null): CodeDevice[] {
  const out: CodeDevice[] = [];
  const seen = new Set<string>();
  for (const p of providers) {
    const kind = bridgeKindOfProvider(p.kind);
    if (!kind || p.deleted) continue;
    const name = (p.baseUrl ?? '').trim();
    if (!name || seen.has(kind + '\u0000' + name)) continue;
    seen.add(kind + '\u0000' + name);
    const b = bridges?.find((x) => x.name === name && x.online && (x.kind ?? 'dsh') === kind);
    // a VS Code extension always reports its workspaces
    out.push({ providerId: p.id, name, online: !!b, workspaces: b?.workspacesSupported === true || (kind === 'vscode' && !!b), kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
}

/**
 * Folders offered for a device: the ones its bridge reported (most recent first), then folders of its known conversations
 * (newest first; they also cover a bridge that is offline). Duplicates by normalized path are dropped.
 */
export function workspaceOptions(device: string, bridges: BridgeInfo[] | null, convs: Conversation[], providers: Record<string, Provider>, kind?: 'dsh' | 'vscode'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | null | undefined) => {
    if (!p) return;
    const k = normCwd(p);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  const b = bridges?.find((x) => x.name === device && x.online && (!kind || (x.kind ?? 'dsh') === kind));
  for (const w of b?.workspaces ?? []) add(w);
  for (const c of [...convs].sort((x, y) => y.updatedAt - x.updatedAt)) if (deviceOf(c, providers) === device) add(c.cwd);
  return out.slice(0, MAX_OPTIONS);
}

/** What the picker chose: device (provider) and folder; cwd null = the bridge's default (the folder last used in the DSH GUI). */
export interface WorkspaceChoice { providerId: string | null; cwd: string | null }

/** Show the picker? Only for a new Code chat whose bridge is online and knows workspaces. */
export function pickerAvailable(device: CodeDevice | undefined): boolean {
  return !!device && device.online && device.workspaces;
}

/** The cwd to send with the first message: only a folder picked from the options of an online, workspace-aware bridge. */
export function cwdToSend(choice: WorkspaceChoice, device: CodeDevice | undefined, options: string[]): string | undefined {
  if (!choice.cwd || !pickerAvailable(device)) return undefined;
  const k = normCwd(choice.cwd);
  return options.some((o) => normCwd(o) === k) ? choice.cwd : undefined;
}

/** A device change keeps the folder only if the new device also offers it (otherwise back to the default). */
export function changeDevice(choice: WorkspaceChoice, providerId: string, options: string[]): WorkspaceChoice {
  const keep = choice.cwd && options.some((o) => normCwd(o) === normCwd(choice.cwd));
  return { providerId, cwd: keep ? choice.cwd : null };
}
