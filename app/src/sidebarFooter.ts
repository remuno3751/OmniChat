// Sidebar footer layout: the icons sit in the bottom row; when that row is too narrow, the lowest-priority icons
// move up to the top row (beside the user name). Pure helper, no React.

export interface FooterItem { key: string; prio: number }

export interface FooterOpts {
  /** icon button width and the gap between buttons */
  btn?: number;
  gap?: number;
  /** width kept for the user name in the top row */
  minUser?: number;
}

const capacity = (width: number, btn: number, gap: number) => Math.max(0, Math.floor((width + gap) / (btn + gap)));

/**
 * Splits `items` (in display order) into the top and bottom rows for an inner width.
 * Everything fits in the bottom row when it can; otherwise the items with the highest `prio` number move up first.
 * Each row keeps the original display order. If even both rows are full, the rest stays in the bottom row (it wraps).
 */
export function splitFooterItems<T extends FooterItem>(items: T[], width: number, opts: FooterOpts = {}): { top: T[]; bottom: T[] } {
  const btn = opts.btn ?? 36;
  const gap = opts.gap ?? 4;
  const minUser = opts.minUser ?? 96;
  const bottomCap = Math.max(1, capacity(width, btn, gap));
  if (items.length <= bottomCap) return { top: [], bottom: items };
  const topCap = capacity(width - minUser, btn, gap);
  const moveCount = Math.min(items.length - bottomCap, topCap);
  const byPrioDesc = [...items].sort((a, b) => b.prio - a.prio);
  const up = new Set(byPrioDesc.slice(0, moveCount).map((i) => i.key));
  return { top: items.filter((i) => up.has(i.key)), bottom: items.filter((i) => !up.has(i.key)) };
}
