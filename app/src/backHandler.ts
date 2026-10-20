/**
 * Central Android back-button policy (pure registry; wired to BackHandler in ui/useBack.ts).
 * Components register a "closable" with a priority while they are open. A back press runs the highest priority handler first
 * (ties: the most recently registered). A handler returns false to pass the press on to the next one; anything else = handled.
 */
export const BACK_PRIORITY = {
  /** popups, menus, dialogs, pickers (anything layered over everything else) */
  POPUP: 100,
  /** image / artifact side panel */
  PANEL: 80,
  /** slash command menu */
  SLASH: 70,
  /** navigation drawer / sidebar */
  DRAWER: 60,
  /** settings sub-page -> settings list */
  SUBPAGE: 50,
  /** whole screens (settings list, search, sessions, usage ...) -> chat */
  SCREEN: 40,
  /** root chat screen with nothing open: the exit confirmation */
  ROOT: 0,
} as const;

export interface BackEntry { id: number; priority: number; onBack: () => boolean | void }

let entries: BackEntry[] = [];
let nextId = 1;

/** Registers a handler; returns the unregister function. */
export function registerBack(priority: number, onBack: () => boolean | void): () => void {
  const e: BackEntry = { id: nextId++, priority, onBack };
  entries = [...entries, e];
  return () => { entries = entries.filter((x) => x !== e); };
}

/** Handlers in the order they are tried. */
export function backOrder(): BackEntry[] {
  return [...entries].sort((a, b) => b.priority - a.priority || b.id - a.id);
}

/** Runs one back press. Returns true if some handler handled it (the caller then consumes the event). */
export function runBack(): boolean {
  for (const e of backOrder()) {
    let r: boolean | void;
    try { r = e.onBack(); } catch { r = undefined; }
    if (r !== false) return true;
  }
  return false;
}

export const backDepth = () => entries.length;
export function resetBackForTests() { entries = []; nextId = 1; }
