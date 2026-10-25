// Pure helpers for Settings > Connections > Devices: grouping devices that share a name, finding stale ones,
// and the locally hidden device names. No React or storage imports (the screen does the I/O).
import type { Device } from './protocol';

/** A device not seen for this long is "stale" and offered for bulk revoke. */
export const STALE_DEVICE_MS = 30 * 24 * 3600_000;

export interface DeviceGroup {
  name: string;
  /** the most recently seen device with this name (the current device wins) */
  primary: Device;
  /** how many devices share this name (1 = no duplicate) */
  count: number;
  ids: string[];
}

/** Groups devices with the same name. Current device first, then the most recently seen. */
export function groupDevicesByName(devices: Device[]): DeviceGroup[] {
  const byName = new Map<string, Device[]>();
  for (const d of devices) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const out: DeviceGroup[] = [];
  for (const [name, list] of byName) {
    const sorted = [...list].sort(newestFirst);
    out.push({ name, primary: sorted[0], count: list.length, ids: list.map((d) => d.id) });
  }
  return out.sort((a, b) => newestFirst(a.primary, b.primary));
}

function newestFirst(a: Device, b: Device): number {
  return Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt;
}

/** Not the current device and not seen for STALE_DEVICE_MS or more. */
export function isStaleDevice(d: Device, now: number): boolean {
  return !d.current && now - d.lastSeenAt >= STALE_DEVICE_MS;
}

export function staleDevices(devices: Device[], now: number): Device[] {
  return devices.filter((d) => isStaleDevice(d, now));
}

/** The bridge name inside a server-made device name: "VS Code (my-pc)" -> "my-pc". Null for other devices. */
export function bridgeNameOfDevice(name: string): string | null {
  const m = /^(?:VS Code|DSH plugin) \((.+)\)$/.exec(name.trim());
  return m ? m[1] : null;
}

/** Parses the stored JSON array of hidden device names. Anything malformed gives an empty list. Never throws. */
export function parseHiddenDevices(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const x of v) if (typeof x === 'string' && x.trim() && x.length <= 200 && !out.includes(x)) out.push(x);
    return out;
  } catch {
    return [];
  }
}

/** Adds a name to the hidden list (idempotent). */
export function addHiddenDevice(list: string[], name: string): string[] {
  return list.includes(name) ? list : [...list, name];
}
