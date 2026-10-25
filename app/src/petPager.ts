// Which pet bubble is shown when several chats are active (pure). The pager shows one item with < > buttons;
// the stack shows the items above the pet. See docs/design/V056-DESKTOP-PET.md (追加仕様 v2).
import type { PetMode } from './petState';
import type { PetItem } from './petItems';

/** Height of one stacked bubble (px) and of the whole pet window (px). */
export const STACK_ROW_PX = 52;
export const PET_WINDOW_H = 360;

/** A running item: not unread and not idle. */
export function isLive(item: PetItem): boolean {
  return !item.unread && item.mode !== 'idle';
}

/** The newest item of a list (largest `at`), optionally among those matching `pred`. */
function newest(items: PetItem[], pred: (i: PetItem) => boolean = () => true): PetItem | null {
  let best: PetItem | null = null;
  for (const i of items) if (pred(i) && (!best || i.at > best.at)) best = i;
  return best;
}

/** Initial selection: the newest unread item, else the newest running item, else the first item. */
export function pickInitial(items: PetItem[]): string | null {
  if (!items.length) return null;
  return (newest(items, (i) => i.unread) ?? newest(items, isLive) ?? items[0]).id;
}

/**
 * Selection after the items changed. The selection stays while its item exists (new items do not move it).
 * When the selected item disappears, the nearest item that is left in the old order is taken.
 */
export function reconcileSelection(prevSel: string | null, prevItems: PetItem[], items: PetItem[]): string | null {
  if (!items.length) return null;
  if (prevSel && items.some((i) => i.id === prevSel)) return prevSel;
  if (!prevSel) return pickInitial(items);
  const idx = prevItems.findIndex((i) => i.id === prevSel);
  if (idx >= 0) {
    for (let k = 1; k < prevItems.length; k++) {
      for (const j of [idx + k, idx - k]) {
        if (j < 0 || j >= prevItems.length) continue;
        const cand = prevItems[j].id;
        if (items.some((i) => i.id === cand)) return cand;
      }
    }
  }
  return pickInitial(items);
}

/** The item `dir` steps away from the selection (clamped at the ends). */
export function stepSelection(sel: string | null, items: PetItem[], dir: -1 | 1): string | null {
  if (!items.length) return null;
  const idx = Math.max(0, items.findIndex((i) => i.id === sel));
  const next = Math.min(items.length - 1, Math.max(0, idx + dir));
  return items[next].id;
}

/** "k/N" for the pager (1-based). */
export function pageLabel(sel: string | null, items: PetItem[]): string {
  const idx = Math.max(0, items.findIndex((i) => i.id === sel));
  return `${idx + 1}/${items.length}`;
}

/** Sprite mode: the selected item while it runs (pager), else the newest running item (stack). Idle otherwise. */
export function petSpriteMode(items: PetItem[], view: 'pager' | 'stack', sel: string | null): PetMode {
  if (view === 'pager') {
    const s = items.find((i) => i.id === sel);
    return s && isLive(s) ? s.mode : 'idle';
  }
  return newest(items, isLive)?.mode ?? 'idle';
}

/** How many stacked bubbles fit above the pet (at least one). */
export function stackCapacity(spriteH: number): number {
  return Math.max(1, Math.floor((PET_WINDOW_H - spriteH - 16) / STACK_ROW_PX));
}

/**
 * Items to draw in the stack (newest first, nearest the pet). When they do not fit, the last slot becomes
 * the "+N" bubble, so `more` is the number of items it stands for.
 */
export function stackVisible(items: PetItem[], spriteH: number): { shown: PetItem[]; more: number } {
  const cap = stackCapacity(spriteH);
  if (items.length <= cap) return { shown: items, more: 0 };
  const keep = Math.max(0, cap - 1);
  return { shown: items.slice(0, keep), more: items.length - keep };
}
