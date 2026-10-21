/** History drawer: the recent-conversation list that covers the page under the header. */
import { el, svg } from "./dom";
import type { ChatViewState, Part, Send } from "./types";

const ICON_REFRESH: Array<[string, Record<string, string>]> = [
  ["path", { d: "M20 12a8 8 0 1 1-2.3-5.6" }],
  ["path", { d: "M20 4v4h-4" }],
];
const ICON_CLOSE: Array<[string, Record<string, string>]> = [["path", { d: "M6 6l12 12M18 6L6 18" }]];

function iconButton(icon: SVGSVGElement, onClick: () => void): HTMLButtonElement {
  const b = el("button", "ch-iconbtn");
  b.type = "button";
  b.appendChild(icon);
  b.addEventListener("click", onClick);
  return b;
}

export function createHistory(send: Send): Part & { toggle(open?: boolean): void } {
  const root = el("section", "ch-history");
  root.hidden = true;

  const head = el("div", "ch-history__head");
  const heading = el("h2", "ch-history__title");
  const refreshBtn = iconButton(svg("0 0 24 24", "ch-icon", ICON_REFRESH), () => send({ type: "refreshHistory" }));
  const closeBtn = iconButton(svg("0 0 24 24", "ch-icon", ICON_CLOSE), () => toggle(false));
  head.append(heading, refreshBtn, closeBtn);

  const note = el("p", "ch-history__note");
  const list = el("ul", "ch-history__list");
  root.append(head, note, list);

  /** Opens or closes the drawer; opening also asks the host for a fresh list. */
  function toggle(next?: boolean): void {
    const open = next ?? root.hidden;
    if (open === !root.hidden) return;
    root.hidden = !open;
    if (open) {
      send({ type: "refreshHistory" });
      closeBtn.focus();
    }
  }

  // Last rendered list, so the rows (and the focused one) are only rebuilt when something changed.
  let signature = "";

  function renderList(state: ChatViewState): void {
    const sig = `${state.lang}\u0000${JSON.stringify(state.recent)}`;
    if (sig === signature) return;
    signature = sig;
    list.replaceChildren();
    for (const c of state.recent) {
      const row = el("li", "ch-history__row");
      const item = el("button", "ch-history__item");
      item.type = "button";
      if (c.current) item.setAttribute("aria-current", "true");
      const name = el("span", "ch-history__name", c.title);
      name.title = c.title;
      const meta = el("span", "ch-history__meta");
      meta.append(el("span", "ch-history__time", c.relative), el("span", `ch-chip ch-chip--${c.approvalMode}`, c.approvalLabel));
      item.append(name, meta);
      item.addEventListener("click", () => {
        send({ type: "openConversation", id: c.id });
        toggle(false);
      });
      row.appendChild(item);
      list.appendChild(row);
    }
  }

  function update(state: ChatViewState): void {
    const S = state.strings;
    heading.textContent = S.recentTitle;
    refreshBtn.title = S.refresh;
    refreshBtn.setAttribute("aria-label", S.refresh);
    closeBtn.title = S.close;
    closeBtn.setAttribute("aria-label", S.close);

    renderList(state);
    const empty = state.recent.length === 0;
    list.hidden = empty;
    note.hidden = !empty;
    if (empty) {
      note.textContent = state.snapshot.conversationsState === "loading" ? S.loadingConversation : S.noHistory;
    }
  }

  return { el: root, update, toggle };
}
