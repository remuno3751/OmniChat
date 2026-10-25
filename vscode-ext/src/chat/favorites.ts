/**
 * Pinned devices and folders of the Chat view's device popover, kept in the extension's global state
 * (one string array per kind). Pure apart from the Memento it is given. No `vscode` import.
 */

/** The part of `vscode.Memento` the favourites need. */
export interface MementoLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type FavoriteKind = "device" | "folder";

export const FAV_KEYS: Record<"devices" | "folders", string> = {
  devices: "omnichat.fav.devices",
  folders: "omnichat.fav.folders",
};

export interface Favorites {
  devices: string[];
  folders: string[];
}

/** Most favourites kept per kind; the oldest one is dropped beyond this. */
export const MAX_FAVORITES = 100;

const keyOf = (kind: FavoriteKind): string => (kind === "device" ? FAV_KEYS.devices : FAV_KEYS.folders);

/** Reads one list, keeping only non-empty strings. A broken value reads as empty. */
function readList(m: MementoLike, key: string): string[] {
  try {
    const raw = m.get<unknown>(key, []);
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v !== "") : [];
  } catch {
    return [];
  }
}

export function readFavorites(m: MementoLike): Favorites {
  return { devices: readList(m, FAV_KEYS.devices), folders: readList(m, FAV_KEYS.folders) };
}

/** Pins or unpins `key`. Returns the list after the change. */
export async function toggleFavorite(m: MementoLike, kind: FavoriteKind, key: string): Promise<string[]> {
  const storeKey = keyOf(kind);
  const list = readList(m, storeKey);
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key].slice(-MAX_FAVORITES);
  try {
    await m.update(storeKey, next);
  } catch {
    // The store refused the write: the next read shows the old list.
  }
  return next;
}
