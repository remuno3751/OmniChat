/**
 * Editing the last prompt (v0.5.6-E §3 "編集と再送"). The pure part says which user item may be edited; the banner
 * sits above the composer while an edit is pending. The composer owns the draft and the send; this module only
 * keeps the edit flag and draws the band.
 */
import { button, el } from "./dom";
import type { V056eStrings } from "./v056eTypes";

/** The id of the last user item of the transcript, or null when there is none. */
export function lastUserItemId(items: readonly { id?: string; kind: string }[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === "user") return items[i].id ?? null;
  }
  return null;
}

/** The Edit button is offered only on the last user item, and never while a run or a prompt is going. */
export function canEditItem(items: readonly { id?: string; kind: string }[], itemId: string, busy: boolean): boolean {
  if (busy || itemId === "") return false;
  return lastUserItemId(items) === itemId;
}

export interface EditLast {
  el: HTMLElement;
  active(): boolean;
  begin(): void;
  end(): void;
  update(S: V056eStrings): void;
}

/** `onCancel` runs after the banner has closed the edit (the composer then empties its draft). */
export function createEditLast(onCancel: () => void): EditLast {
  const root = el("div", "cm-edit-banner");
  root.setAttribute("role", "status");
  root.hidden = true;
  const text = el("span", "cm-edit-banner__text");
  const cancel = button("", "cm-edit-banner__cancel", () => {
    end();
    onCancel();
  });
  root.append(text, cancel);

  let on = false;
  function begin(): void {
    on = true;
    root.hidden = false;
  }
  function end(): void {
    if (!on) return;
    on = false;
    root.hidden = true;
  }

  return {
    el: root,
    active: () => on,
    begin,
    end,
    update(S) {
      text.textContent = S.editBannerText;
      cancel.textContent = S.editCancel;
    },
  };
}
