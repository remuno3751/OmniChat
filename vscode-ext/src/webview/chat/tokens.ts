/** Token breakdown: the context meter becomes a button that opens a small panel (system / history / ... and the last reply). */
import { el } from "./dom";
import { createPop } from "./pop";
import { setTip } from "./tip";
import type { ChatViewState } from "./types";

export interface Breakdown {
  title: string;
  rows: Array<{ label: string; tokens: string }>;
  lastRows: Array<{ label: string; tokens: string }>;
  cacheNote: string;
}

function table(rows: Breakdown["rows"]): HTMLElement {
  const t = el("div", "cm-tok__table");
  for (const r of rows) t.append(el("span", "cm-tok__k", r.label), el("span", "cm-tok__v", r.tokens));
  return t;
}

/** Makes `meter` open the breakdown panel above it. Returns the updater to call with each state. */
export function attachTokens(meter: HTMLElement): (state: ChatViewState) => void {
  meter.tabIndex = 0;
  meter.setAttribute("role", "button");
  const pop = createPop(meter, "cm-pop--tokens", () => render());
  meter.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      meter.click();
    }
  });
  let last: ChatViewState | null = null;

  function render(): void {
    const b = (last?.context as { breakdown?: Breakdown } | null | undefined)?.breakdown;
    if (!last || !b) {
      pop.panel.replaceChildren(el("div", "cm-pop__empty", last ? last.strings.slashContextUnknown : ""));
      return;
    }
    pop.panel.replaceChildren(
      el("div", "cm-pop__group", b.title),
      table(b.rows),
      ...(b.lastRows.length > 0 ? [el("div", "cm-pop__group", last.strings.tokLast), table(b.lastRows)] : []),
      el("div", "cm-pop__note", b.cacheNote),
    );
  }

  return (state) => {
    last = state;
    const b = (state.context as { breakdown?: Breakdown } | null)?.breakdown;
    meter.classList.toggle("cm-meter--btn", b !== undefined);
    if (b) setTip(meter, b.title);
    if (pop.isOpen()) render();
  };
}
