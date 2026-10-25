/** Model picker: a pill that opens a searchable list grouped by provider (name, context length, vision), like the app's picker. */
import type { ModelItem } from "../../protocol/chat-frames";
import { el } from "./dom";
import { createPop, rowNavigation } from "./pop";
import type { ChatViewState, Send } from "./types";

/** Groups models by provider keeping the server order; a filter matches the label or the provider. */
export function groupModels(models: readonly ModelItem[], query: string): Array<{ provider: string; items: ModelItem[] }> {
  const q = query.trim().toLowerCase();
  const out: Array<{ provider: string; items: ModelItem[] }> = [];
  for (const m of models) {
    if (q !== "" && !m.label.toLowerCase().includes(q) && !m.provider.toLowerCase().includes(q)) continue;
    let g = out.find((x) => x.provider === m.provider);
    if (!g) out.push((g = { provider: m.provider, items: [] }));
    g.items.push(m);
  }
  return out;
}

/** 131072 -> "128", 8192 -> "8" (thousands of tokens, rounded as the app does). */
export function ctxK(n: number): string {
  return String(n >= 1000 ? Math.round(n / 1024) : n);
}

export function createModelPicker(send: Send): { el: HTMLElement; update(state: ChatViewState): void; open(): void } {
  const btn = el("button", "ch-pill ch-model-btn");
  btn.type = "button";
  const label = el("span", "ch-pill__text");
  btn.appendChild(label);
  const pop = createPop(btn, "cm-pop--model", () => {
    search.value = "";
    render();
    search.focus();
  });
  const search = el("input", "cm-pop__search");
  search.type = "search";
  search.setAttribute("autocomplete", "off");
  const list = el("div", "cm-pop__list");
  list.setAttribute("role", "listbox");
  pop.panel.append(search, list);
  let last: ChatViewState | null = null;

  function choose(ref: string | null): void {
    send({ type: "setModel", ref });
    pop.close();
    btn.focus();
  }

  function row(m: ModelItem | null, state: ChatViewState, selected: boolean): HTMLButtonElement {
    const S = state.strings;
    const b = el("button", "cm-pop__row");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(selected));
    b.classList.toggle("cm-pop__row--on", selected);
    const name = el("span", "cm-pop__name", m ? m.label : S.defaultModel);
    b.appendChild(name);
    if (m) {
      if (m.vision === "yes") b.appendChild(el("span", "cm-pop__tag", S.modelVision));
      if (m.contextLength && m.contextLength > 0) b.appendChild(el("span", "cm-pop__tag cm-pop__tag--dim", S.modelCtx.replace("{n}", ctxK(m.contextLength))));
    } else if (state.snapshot.defaultModel) {
      b.appendChild(el("span", "cm-pop__tag cm-pop__tag--dim", state.snapshot.defaultModel));
    }
    b.addEventListener("click", () => choose(m ? m.ref : null));
    return b;
  }

  function render(): void {
    if (!last) return;
    const state = last;
    const snap = state.snapshot;
    search.placeholder = state.strings.modelSearch;
    search.setAttribute("aria-label", state.strings.modelSearch);
    const current = snap.model ?? (snap.defaultModel !== null ? null : snap.effectiveModel);
    const rows: HTMLElement[] = [];
    if (snap.defaultModel !== null && search.value.trim() === "") rows.push(row(null, state, current === null));
    for (const g of groupModels(snap.models, search.value)) {
      rows.push(el("div", "cm-pop__group", g.provider || "—"));
      for (const m of g.items) rows.push(row(m, state, m.ref === current));
    }
    if (rows.length === 0) rows.push(el("div", "cm-pop__empty", state.strings.modelNone));
    list.replaceChildren(...rows);
  }

  search.addEventListener("input", render);
  pop.panel.addEventListener("keydown", (e) => {
    if (e.target === search && e.key !== "ArrowDown" && e.key !== "Escape") return;
    rowNavigation(pop.panel, e);
  });

  return {
    el: btn,
    open: pop.open,
    update(state) {
      last = state;
      const snap = state.snapshot;
      const cur = snap.models.find((m) => m.ref === (snap.model ?? snap.effectiveModel));
      label.textContent = cur ? cur.label : (snap.defaultModel ?? state.strings.selectModel);
      btn.setAttribute("aria-label", state.strings.modelLabel);
      btn.dataset.tip = state.strings.modelLabel;
      btn.disabled = snap.models.length === 0 || !state.chatEnabled;
      if (pop.isOpen()) render();
    },
  };
}
