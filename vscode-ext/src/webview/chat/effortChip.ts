/** Effort chip in the picker bar: the thinking effort of this chat (default, low, medium, high, max). Picking a level sends `setEffort`. */
import type { EffortLevel } from "../../protocol/chat-frames-v056d";
import { EFFORT_LEVELS } from "../../protocol/chat-frames-v056d";
import { el } from "./dom";
import { createPop, rowNavigation } from "./pop";
import { sendExtra, settingsOf, type ChatViewState, type Send } from "./types";
import { setTip } from "./tip";
import type { V056dStrings } from "../../ui/stringsV056d";

/** Chip text for an effort: null is the model default. */
export function effortLabel(
  level: EffortLevel | null,
  S: Pick<V056dStrings, "csEffortDefault" | "csEffortOff" | "csEffortLow" | "csEffortMedium" | "csEffortHigh" | "csEffortMax">,
): string {
  switch (level) {
    case "off":
      return S.csEffortOff;
    case "low":
      return S.csEffortLow;
    case "medium":
      return S.csEffortMedium;
    case "high":
      return S.csEffortHigh;
    case "max":
      return S.csEffortMax;
    default:
      return S.csEffortDefault;
  }
}

/** The menu rows in order: null (the default) first, then the levels (off, low, medium, high, max). */
export const EFFORT_CHOICES: ReadonlyArray<EffortLevel | null> = [null, ...EFFORT_LEVELS];

export function createEffortChip(send: Send): { el: HTMLElement; update(state: ChatViewState): void } {
  const btn = el("button", "ch-pill ch-effort-btn");
  btn.type = "button";
  const label = el("span", "ch-pill__text");
  btn.appendChild(label);
  const pop = createPop(btn, "cm-pop--effort", () => render());
  const list = el("div", "cm-pop__list");
  list.setAttribute("role", "listbox");
  pop.panel.append(list);
  let last: ChatViewState | null = null;

  function choose(level: EffortLevel | null): void {
    sendExtra(send, { type: "setEffort", effort: level });
    pop.close();
    btn.focus();
  }

  function render(): void {
    if (!last) return;
    const S = last.strings;
    const current = settingsOf(last).value?.effort ?? null;
    const rows = EFFORT_CHOICES.map((level) => {
      const selected = level === current;
      const b = el("button", "cm-pop__row");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(selected));
      b.classList.toggle("cm-pop__row--on", selected);
      b.appendChild(el("span", "cm-pop__name", effortLabel(level, S)));
      b.addEventListener("click", () => choose(level));
      return b;
    });
    list.replaceChildren(...rows);
  }

  pop.panel.addEventListener("keydown", (e) => rowNavigation(pop.panel, e));

  return {
    el: btn,
    update(state) {
      last = state;
      const S = state.strings;
      const effort = settingsOf(state).value?.effort ?? null;
      label.textContent = effortLabel(effort, S);
      btn.classList.toggle("ch-effort-btn--set", effort !== null);
      setTip(btn, S.effortChipTip);
      btn.disabled = !state.chatEnabled || state.snapshot.conversationId === null;
      btn.setAttribute("aria-haspopup", "dialog");
      if (pop.isOpen()) render();
    },
  };
}
