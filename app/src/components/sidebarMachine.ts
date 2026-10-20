/**
 * Pure state machine for the collapsible left sidebar (wide web/desktop layout). No React, no timers:
 * the caller runs the timer when `effect` asks for one. See SidebarShell.tsx.
 *
 * - pinned && open  -> the sidebar takes layout space.
 * - otherwise       -> the sidebar is out of the layout; a hover at the left edge (hot zone) peeks it as an overlay.
 *   - `peek` is set by the hot zone and cleared by the close timer after the pointer leaves the overlay.
 *   - `open` while unpinned is an explicit "show" from the toggle button: it stays as an overlay until toggled again.
 */

/** how long the peek overlay stays after the pointer leaves it (cancelled when the pointer comes back) */
export const PEEK_CLOSE_DELAY_MS = 250;
/** the first close delay after the hot zone opened the peek: a pointer resting at the edge may not send a move event into the panel */
export const PEEK_HOT_DELAY_MS = 1200;

export interface SidebarState {
  pinned: boolean;
  /** the sidebar is wanted visible (toggle button); layout space is used only when also pinned */
  open: boolean;
  /** a hover peek is showing */
  peek: boolean;
}

export type SidebarEvent =
  /** the hide / show toggle button */
  | { type: 'toggle' }
  /** the pin button, Ctrl/Cmd+B, or a pin value synced from settings */
  | { type: 'pin'; pinned: boolean }
  /** the pointer entered the hot zone at the left edge */
  | { type: 'hotEnter' }
  /** the pointer entered the overlay panel */
  | { type: 'panelEnter' }
  /** the pointer left the overlay panel */
  | { type: 'panelLeave' }
  /** the close delay elapsed */
  | { type: 'closeTimer' };

/** what the caller must do with timers after a transition */
export type SidebarEffect = 'scheduleClose' | 'scheduleHotClose' | 'cancelClose' | null;

export function initialSidebarState(pinned: boolean): SidebarState {
  return { pinned, open: pinned, peek: false };
}

/** true when the sidebar occupies layout space */
export function sidebarInLayout(s: SidebarState): boolean {
  return s.pinned && s.open;
}

/** true when the sidebar is drawn as an overlay (peek, or an explicit show while unpinned) */
export function sidebarOverlayShown(s: SidebarState): boolean {
  return !sidebarInLayout(s) && (s.peek || s.open);
}

/** true when the left-edge hot zone should be mounted (sidebar out of the layout) */
export function sidebarHotZoneActive(s: SidebarState): boolean {
  return !sidebarInLayout(s);
}

export function reduceSidebar(s: SidebarState, e: SidebarEvent): { state: SidebarState; effect: SidebarEffect } {
  switch (e.type) {
    case 'toggle': {
      return { state: { ...s, open: !s.open, peek: false }, effect: 'cancelClose' };
    }
    case 'pin': {
      if (e.pinned === s.pinned) return { state: s, effect: null };
      // pinning shows the sidebar in the layout; unpinning hides it (it comes back as a hover peek)
      return { state: { pinned: e.pinned, open: e.pinned, peek: false }, effect: 'cancelClose' };
    }
    case 'hotEnter': {
      if (sidebarInLayout(s) || s.open || s.peek) return { state: s, effect: null };
      // the close timer also runs here: if the pointer never reaches the overlay, the peek goes away again
      return { state: { ...s, peek: true }, effect: 'scheduleHotClose' };
    }
    case 'panelEnter': {
      if (!s.peek) return { state: s, effect: null };
      return { state: s, effect: 'cancelClose' };
    }
    case 'panelLeave': {
      if (!s.peek || s.open) return { state: s, effect: null };
      return { state: s, effect: 'scheduleClose' };
    }
    case 'closeTimer': {
      if (!s.peek) return { state: s, effect: null };
      return { state: { ...s, peek: false }, effect: null };
    }
  }
  return { state: s, effect: null };
}
