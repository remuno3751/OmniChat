/**
 * Checkpoints (v0.5.6-E §3): the header button and the panel that opens under the header. The panel lists the
 * checkpoints of the conversation (newest first) and asks the host to restore one (the host confirms first).
 * The panel is a `pop` like the model picker; it closes on the same button, on Escape and on an outside click.
 */
import { button, el, svg } from "./dom";
import { createPop } from "./pop";
import { setTip } from "./tip";
import { buildCheckpointRows, type CheckpointRow } from "./checkpointModel";
import type { ChatViewState, Send } from "./types";
import { sendV056e, stringsOf, viewOf, type V056eStrings } from "./v056eTypes";

/** Panel height cap (px): the list scrolls past it. */
const PANEL_MAX_PX = 320;

const ICON_RESTORE: Array<[string, Record<string, string>]> = [
  ["path", { d: "M4 12a8 8 0 1 0 2.4-5.7" }],
  ["path", { d: "M4 4v4.5h4.5" }],
];

export interface Checkpoints {
  /** The header button (it toggles the panel). */
  button: HTMLButtonElement;
  el: HTMLElement;
  update(state: ChatViewState): void;
  close(): void;
}

function renderRow(row: CheckpointRow, S: V056eStrings, send: Send): HTMLLIElement {
  const li = el("li", "cm-cp__row");
  li.classList.toggle("cm-cp__row--dim", !row.restorable);
  li.classList.toggle("is-restoring", row.restoring);

  const when = el("span", "cm-cp__when");
  when.append(el("span", "cm-cp__time", row.time));
  if (row.dirty) when.append(el("span", "cm-cp__dirty", S.cpDirty));

  const prompt = el("span", "cm-cp__prompt", row.prompt);
  if (row.prompt !== "") setTip(prompt, row.prompt);
  const files = el("span", "cm-cp__files", row.files);

  // aria-disabled instead of disabled: disabled controls swallow the hover that shows the reason tooltip.
  const restore = button(row.restoreLabel, "cm-cp__restore", () => {
    if (restore.getAttribute("aria-disabled") !== "true") sendV056e(send, { type: "restoreCheckpoint", checkpointId: row.id });
  });
  restore.setAttribute("aria-disabled", String(row.restoreOff));
  if (row.restoreTip !== null) setTip(restore, row.restoreTip);
  else restore.removeAttribute("data-tip");

  li.append(when, prompt, files, restore);
  return li;
}

export function createCheckpoints(send: Send, container: HTMLElement): Checkpoints {
  const trigger = el("button", "ch-iconbtn");
  trigger.type = "button";
  trigger.appendChild(svg("0 0 24 24", "ch-icon", ICON_RESTORE));

  const pop = createPop(trigger, "cm-pop--cp", () => sendV056e(send, { type: "requestCheckpoints" }), {
    below: true,
    maxHeight: PANEL_MAX_PX,
    container,
  });

  const head = el("div", "cm-cp__head");
  const title = el("h2", "cm-cp__title");
  const hint = el("p", "cm-cp__hint");
  head.append(title, hint);
  const statusText = el("p", "cm-cp__status");
  const reload = button("", "cm-btn cm-cp__reload", () => sendV056e(send, { type: "requestCheckpoints" }));
  const list = el("ul", "cm-cp__list");
  list.setAttribute("role", "list");
  pop.panel.append(head, statusText, reload, list);

  // Redraw only when the visible data changed (the panel is rebuilt on each host state otherwise).
  let signature = "";

  function renderBody(state: ChatViewState, S: V056eStrings): void {
    const view = viewOf(state).checkpoints;
    const busy = state.snapshot.running || state.snapshot.sending;
    const sig = `${state.lang}\u0000${busy ? 1 : 0}\u0000${JSON.stringify(view)}`;
    if (sig === signature) return;
    signature = sig;

    const rows = view.state === "ready" ? buildCheckpointRows(view.items, { now: Date.now(), busy, restoring: view.restoring }, S) : [];
    const showList = view.state === "ready" && rows.length > 0;
    list.replaceChildren(...rows.map((row) => renderRow(row, S, send)));
    list.hidden = !showList;

    const error = view.state === "error";
    statusText.hidden = showList;
    statusText.textContent = error ? S.cpError : view.state === "ready" ? S.cpEmpty : S.cpLoading;
    reload.hidden = !error;
    reload.textContent = S.cpReload;
  }

  // A list is for one conversation: when the conversation changes while the panel is open, ask again.
  let conversation: string | null | undefined = undefined;
  return {
    button: trigger,
    el: pop.panel,
    update(state: ChatViewState) {
      const S = stringsOf(state);
      setTip(trigger, S.cpButtonTip);
      title.textContent = S.cpTitle;
      hint.textContent = S.cpHint;
      const id = state.snapshot.conversationId;
      if (id !== conversation) {
        conversation = id;
        if (pop.isOpen()) sendV056e(send, { type: "requestCheckpoints" });
      }
      renderBody(state, S);
    },
    close: pop.close,
  };
}
