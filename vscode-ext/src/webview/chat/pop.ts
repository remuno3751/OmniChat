/** A floating panel opened above its trigger button (the picker bar sits at the bottom). Closes on outside click, Escape and resize. */
import { el } from "./dom";

export interface Pop {
  panel: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

const MARGIN = 8;

export interface PopOptions {
  /** Opens under the trigger (the header) instead of above it (the picker bar). */
  below?: boolean;
  /** Height cap (px) for the panel, below or above. */
  maxHeight?: number;
  /** Where the panel is appended on open (default: document.body). */
  container?: HTMLElement;
}

export function createPop(trigger: HTMLElement, cls: string, onOpen: () => void, opts: PopOptions = {}): Pop {
  const panel = el("div", `cm-pop ${cls}`);
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  let opened = false;

  /** Position with CSSOM (no inline style attributes: CSP). */
  function place(): void {
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const width = Math.min(panel.offsetWidth || 280, vw - MARGIN * 2);
    panel.style.setProperty("left", `${Math.max(MARGIN, Math.min(r.left, vw - width - MARGIN))}px`);
    if (opts.below) {
      const room = window.innerHeight - r.bottom - MARGIN - 6;
      panel.style.setProperty("top", `${r.bottom + 6}px`);
      panel.style.setProperty("bottom", "auto");
      panel.style.setProperty("max-height", `${Math.max(120, Math.min(room, opts.maxHeight ?? room))}px`);
      return;
    }
    panel.style.setProperty("bottom", `${window.innerHeight - r.top + 6}px`);
    panel.style.setProperty("max-height", `${Math.max(120, r.top - MARGIN - 6)}px`);
  }

  function onDown(e: Event): void {
    const t = e.target as Node | null;
    if (t && (panel.contains(t) || trigger.contains(t))) return;
    close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      trigger.focus();
    }
  }

  function open(): void {
    if (opened) return;
    opened = true;
    if (!panel.isConnected) (opts.container ?? document.body).appendChild(panel);
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen();
    place();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
  }
  function close(): void {
    if (!opened) return;
    opened = false;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
  }

  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => (opened ? close() : open()));
  return { panel, open, close, isOpen: () => opened };
}

/** Moves the focus through the `.cm-pop__row` buttons of `root` with Up/Down/Home/End. */
export function rowNavigation(root: HTMLElement, e: KeyboardEvent): void {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(".cm-pop__row:not([disabled])"));
  if (rows.length === 0) return;
  const i = rows.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === "ArrowDown") next = i < 0 ? 0 : Math.min(rows.length - 1, i + 1);
  else if (e.key === "ArrowUp") next = i <= 0 ? 0 : i - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = rows.length - 1;
  if (next < 0) return;
  e.preventDefault();
  rows[next].focus();
}
