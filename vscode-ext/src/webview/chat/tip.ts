/**
 * Tooltips for the chat webview. Any element with `data-tip` shows one shared `div.cm-tip` after 2 s of hover, or
 * after 2 s of keyboard focus. Leave, click, focus loss and Escape hide it. Positions go through CSSOM, never inline
 * style attributes (CSP).
 */
import { el } from "./dom";

const SHOW_DELAY_MS = 2000;
/** Gap (px) between the element and the tip. */
const GAP_PX = 6;

let tipEl: HTMLDivElement | null = null;
let timer: number | null = null;
let current: HTMLElement | null = null;

/** Sets the tooltip text of an element and drops the native `title`, so the two never show together. */
export function setTip(target: HTMLElement, text: string): void {
  target.setAttribute("data-tip", text);
  target.setAttribute("aria-label", text);
  target.removeAttribute("title");
}

function hide(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  current = null;
  if (tipEl) tipEl.hidden = true;
}

function place(target: HTMLElement): void {
  if (!tipEl) return;
  const rect = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const maxLeft = Math.max(0, window.innerWidth - w - 4);
  const left = Math.min(Math.max(4, rect.left + rect.width / 2 - w / 2), maxLeft);
  const below = rect.bottom + GAP_PX;
  const top = below + h <= window.innerHeight ? below : Math.max(4, rect.top - h - GAP_PX);
  tipEl.style.setProperty("left", `${Math.round(left)}px`);
  tipEl.style.setProperty("top", `${Math.round(top)}px`);
}

function schedule(target: HTMLElement, keyboard: boolean): void {
  if (current === target) return;
  hide();
  current = target;
  timer = window.setTimeout(() => {
    timer = null;
    // A keyboard-triggered tip only shows while the element holds focus as a keyboard target.
    if (current !== target || !target.isConnected) return hide();
    if (keyboard && !target.matches(":focus-visible")) return hide();
    const text = target.getAttribute("data-tip");
    if (!text || !tipEl) return hide();
    tipEl.textContent = text;
    tipEl.hidden = false;
    place(target);
  }, SHOW_DELAY_MS);
}

function tipTarget(node: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  const found = node.closest<HTMLElement>("[data-tip]");
  return found && root.contains(found) ? found : null;
}

/** Installs the shared tooltip under `root` (call once at start). */
export function installTips(root: HTMLElement): void {
  if (tipEl) return;
  const doc = root.ownerDocument;
  tipEl = el("div", "cm-tip");
  tipEl.setAttribute("role", "tooltip");
  tipEl.hidden = true;
  root.appendChild(tipEl);

  root.addEventListener("mouseover", (e) => {
    const target = tipTarget(e.target, root);
    if (target) schedule(target, false);
  });
  root.addEventListener("mouseout", (e) => {
    if (current && !current.contains(e.relatedTarget as Node | null)) hide();
  });
  root.addEventListener("focusin", (e) => {
    const target = tipTarget(e.target, root);
    if (target) schedule(target, true);
  });
  root.addEventListener("focusout", () => hide());
  root.addEventListener("pointerdown", () => hide());
  root.addEventListener("scroll", () => hide(), true);
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
}
