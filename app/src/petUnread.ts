// Unread finished runs for the desktop pet (v2). A run that ends while the user is not looking at its
// conversation stays unread until they look at it (window focused and the conversation shown), dismiss it, or
// open it. Pure reducers plus a small module store. See docs/design/V056-DESKTOP-PET.md (追加仕様 v2).
import type { PetOutcome } from './petBubble';

export interface UnreadEntry { id: string; outcome: PetOutcome; at: number }
export type UnreadMap = Record<string, UnreadEntry>;

function without(map: UnreadMap, id: string): UnreadMap {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** A run ended. `watching` = the window is focused and this conversation is on screen (then nothing stays unread). */
export function finishRun(map: UnreadMap, e: { id: string; outcome: PetOutcome; at: number }, watching: boolean): UnreadMap {
  if (watching) return without(map, e.id);
  return { ...map, [e.id]: { id: e.id, outcome: e.outcome, at: e.at } };
}

/** The window is focused and `shownId` is on screen: its unread mark goes. */
export function watchShown(map: UnreadMap, shownId: string | null, focused: boolean): UnreadMap {
  if (!focused || !shownId) return map;
  return without(map, shownId);
}

/** The user dismissed the bubble (or opened the conversation from the pet). */
export function dismissUnread(map: UnreadMap, id: string): UnreadMap {
  return without(map, id);
}

/** Unread entries, newest first. */
export function unreadList(map: UnreadMap): UnreadEntry[] {
  return Object.values(map).sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

/** Ids that were running before and are not running now. */
export function finishedIds(prev: Iterable<string>, now: Iterable<string>): string[] {
  const nowSet = new Set(now);
  const out: string[] = [];
  for (const id of prev) if (!nowSet.has(id)) out.push(id);
  return out;
}

let state: UnreadMap = {};
const subs = new Set<() => void>();

export function getUnread(): UnreadMap {
  return state;
}

export function setUnread(next: UnreadMap): void {
  if (next === state) return;
  state = next;
  subs.forEach((f) => f());
}

export function subscribeUnread(l: () => void): () => void {
  subs.add(l);
  return () => { subs.delete(l); };
}
