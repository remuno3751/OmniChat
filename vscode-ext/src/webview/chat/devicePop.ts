/** Device and folder picker: the OmniChat logo opens a popup with this PC's folders, pinned folders (star) and other devices. */
import { el, logoMark, svg } from "./dom";
import { createPop, rowNavigation } from "./pop";
import type { ChatViewState, Send } from "./types";

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

/** Pinned entries first (in pin order), then the rest in their own order. */
export function pinnedFirst<T>(items: readonly T[], key: (t: T) => string, pinned: readonly string[]): T[] {
  const rank = (t: T): number => {
    const i = pinned.indexOf(key(t));
    return i < 0 ? pinned.length : i;
  };
  return items.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
}

function starIcon(on: boolean): SVGSVGElement {
  return svg("0 0 24 24", "cm-star", [
    ["path", { d: "M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8z", fill: on ? "currentColor" : "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linejoin": "round" }],
  ]);
}

export function createDevicePicker(send: Send): { el: HTMLElement; update(state: ChatViewState): void } {
  const btn = el("button", "ch-pill ch-folder-btn");
  btn.type = "button";
  const label = el("span", "ch-pill__text");
  btn.append(logoMark("oc-logo ch-pill__logo"), label);
  const pop = createPop(btn, "cm-pop--device", () => {
    send({ type: "requestDevices" });
    render();
    pop.panel.querySelector<HTMLElement>(".cm-pop__row:not([disabled])")?.focus();
  });
  let last: ChatViewState | null = null;

  function star(state: ChatViewState, kind: "device" | "folder", key: string, on: boolean): HTMLButtonElement {
    const s = el("button", "cm-pop__star");
    s.type = "button";
    const tip = on ? state.strings.folderUnpin : state.strings.folderPin;
    s.setAttribute("aria-label", tip);
    s.setAttribute("aria-pressed", String(on));
    s.dataset.tip = tip;
    s.classList.toggle("cm-pop__star--on", on);
    s.appendChild(starIcon(on));
    s.addEventListener("click", (e) => {
      e.stopPropagation();
      send({ type: "toggleFavorite", kind, key });
    });
    return s;
  }

  function folderRow(state: ChatViewState, path: string, isOpen: boolean, pinned: boolean): HTMLElement {
    const wrap = el("div", "cm-pop__line");
    const b = el("button", "cm-pop__row");
    b.type = "button";
    b.title = path;
    b.disabled = !isOpen;
    const current = isOpen && path === state.snapshot.cwd;
    b.classList.toggle("cm-pop__row--on", current);
    b.append(el("span", "cm-pop__name", basename(path)), el("span", "cm-pop__tag cm-pop__tag--dim", isOpen ? path : state.strings.folderNotOpen));
    b.addEventListener("click", () => {
      send({ type: "setCwd", cwd: path });
      pop.close();
      btn.focus();
    });
    wrap.append(b, star(state, "folder", path, pinned));
    return wrap;
  }

  function render(): void {
    if (!last) return;
    const state = last;
    const S = state.strings;
    const snap = state.snapshot;
    const fav = state.extras.favorites;
    const out: HTMLElement[] = [];

    out.push(el("div", "cm-pop__group", S.deviceThis));
    const open = pinnedFirst(snap.cwds, (c) => c, fav.folders);
    for (const c of open) out.push(folderRow(state, c, true, fav.folders.includes(c)));
    const pinnedClosed = fav.folders.filter((f) => !snap.cwds.includes(f));
    if (pinnedClosed.length > 0) {
      out.push(el("div", "cm-pop__group", S.folderPinned));
      for (const f of pinnedClosed) out.push(folderRow(state, f, false, true));
    }
    if (open.length === 0 && pinnedClosed.length === 0) out.push(el("div", "cm-pop__empty", S.folderNone));

    out.push(el("div", "cm-pop__group", S.deviceOthers));
    const dev = state.extras.devices;
    if (dev.state === "loading") out.push(el("div", "cm-pop__empty", S.deviceLoading));
    else if (dev.state === "error") out.push(el("div", "cm-pop__empty", S.deviceError));
    else {
      const others = pinnedFirst(dev.items.filter((d) => !d.self), (d) => d.name, fav.devices);
      for (const d of others) {
        const wrap = el("div", "cm-pop__line");
        const b = el("button", "cm-pop__row");
        b.type = "button";
        b.disabled = true;
        b.title = d.workspaces.join("\n");
        const dot = el("span", `cm-pop__dot${d.online ? " cm-pop__dot--on" : ""}`);
        b.append(dot, el("span", "cm-pop__name", d.name), el("span", "cm-pop__tag cm-pop__tag--dim", d.kind === "vscode" ? "VS Code" : "DSH"));
        wrap.append(b, star(state, "device", d.name, fav.devices.includes(d.name)));
        out.push(wrap);
      }
      out.push(el("div", "cm-pop__note", S.deviceOtherHint));
    }
    pop.panel.replaceChildren(...out);
  }

  pop.panel.addEventListener("keydown", (e) => rowNavigation(pop.panel, e));

  return {
    el: btn,
    update(state) {
      last = state;
      label.textContent = state.snapshot.cwd ? basename(state.snapshot.cwd) : state.strings.deviceLabel;
      btn.setAttribute("aria-label", state.strings.deviceLabel);
      btn.dataset.tip = state.snapshot.cwd ?? state.strings.deviceLabel;
      btn.disabled = !state.chatEnabled;
      if (pop.isOpen()) render();
    },
  };
}
