/**
 * A short notice above the composer (host `toast` messages and the webview's own, such as /help). It stays for about
 * 4 s; a newer toast replaces the shown one. Multi-line text keeps its line breaks.
 */
import { el } from "./dom";

const SHOW_MS = 4000;

export interface Toast {
  el: HTMLElement;
  show(text: string): void;
}

export function createToast(): Toast {
  const root = el("div", "cm-toast");
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.hidden = true;
  let timer: number | null = null;

  function hide(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    root.hidden = true;
    root.textContent = "";
  }

  return {
    el: root,
    show(text: string) {
      if (timer !== null) clearTimeout(timer);
      root.textContent = text;
      root.hidden = false;
      timer = window.setTimeout(hide, SHOW_MS);
    },
  };
}
