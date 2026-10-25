/**
 * Pinned conversations (the `/pin` command): their ids live in the extension's global state, and the history
 * list puts them first. Pure apart from the Memento it is given. No `vscode` import.
 */
import type { MementoLike } from "./favorites";

export const PINS_KEY = "omnichat.pinnedConversations";

/** Most pins kept; the oldest one is dropped beyond this. */
export const MAX_PINS = 100;

/** The pinned conversation ids. A broken value reads as empty. */
export function readPins(m: MementoLike): string[] {
  try {
    const raw = m.get<unknown>(PINS_KEY, []);
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && v !== "") : [];
  } catch {
    return [];
  }
}

/** Pins or unpins a conversation. Returns the list after the change. */
export async function togglePin(m: MementoLike, id: string): Promise<string[]> {
  const list = readPins(m);
  const next = list.includes(id) ? list.filter((k) => k !== id) : [...list, id].slice(-MAX_PINS);
  try {
    await m.update(PINS_KEY, next);
  } catch {
    // The store refused the write: the next read shows the old list.
  }
  return next;
}

/** The items with a `pinned` flag, pinned ones first. Each group keeps its order. */
export function pinFirst<T extends { id: string }>(items: readonly T[], pins: readonly string[]): Array<T & { pinned: boolean }> {
  return items
    .map((item) => ({ ...item, pinned: pins.includes(item.id) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
}
