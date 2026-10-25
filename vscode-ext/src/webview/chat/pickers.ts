/** Composer picker bar: folder, model and approval-mode controls (the app's pills and segmented switch). */
import type { ApprovalModeId, SearchMode } from "../../protocol/chat-frames";
import { el } from "./dom";
import { createDevicePicker } from "./devicePop";
import { createEffortChip } from "./effortChip";
import { createModelPicker } from "./modelPop";
import type { ChatViewState, Part, Send } from "./types";

const MODES: ApprovalModeId[] = ["manual", "auto", "full"];
const SEARCH_MODES: SearchMode[] = ["off", "smart", "always"];

export function createPickers(send: Send): Part & { openModel(): void } {
  const root = el("div", "ch-pickers");

  const device = createDevicePicker(send);
  const model = createModelPicker(send);
  const effort = createEffortChip(send);

  const seg = el("div", "ch-seg");
  seg.setAttribute("role", "radiogroup");
  const segOpts = new Map<ApprovalModeId, HTMLButtonElement>();
  let currentMode: ApprovalModeId = "manual";

  function choose(mode: ApprovalModeId): void {
    if (mode !== currentMode) send({ type: "setApprovalMode", mode });
  }

  for (const mode of MODES) {
    const b = el("button", "ch-seg__opt");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => choose(mode));
    segOpts.set(mode, b);
    seg.appendChild(b);
  }

  // Arrow keys move through the radio group and select the option (roving tabindex).
  seg.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = MODES[(MODES.indexOf(currentMode) + step + MODES.length) % MODES.length];
    segOpts.get(next)?.focus();
    choose(next);
  });

  // Search: off / smart / always, the policy of the next prompt (inherits the conversation when unset).
  const searchWrap = el("div", "ch-search");
  const searchLabel = el("span", "ch-search__label");
  const searchSeg = el("div", "ch-seg ch-seg--search");
  searchSeg.setAttribute("role", "radiogroup");
  const searchOpts = new Map<SearchMode, HTMLButtonElement>();
  let currentSearch: SearchMode = "smart";
  for (const mode of SEARCH_MODES) {
    const b = el("button", "ch-seg__opt");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => {
      if (mode !== currentSearch) send({ type: "setSearchMode", mode });
    });
    searchOpts.set(mode, b);
    searchSeg.appendChild(b);
  }
  searchWrap.append(searchLabel, searchSeg);

  root.append(device.el, model.el, effort.el, seg, searchWrap);

  function update(state: ChatViewState): void {
    const S = state.strings;
    const snap = state.snapshot;

    device.update(state);
    model.update(state);
    effort.update(state);

    // Approval mode: always mirrors the snapshot, the host confirms changes.
    currentMode = snap.approvalMode;
    seg.setAttribute("aria-label", S.modeLabel);
    for (const mode of MODES) {
      const b = segOpts.get(mode);
      if (!b) continue;
      const on = mode === currentMode;
      const label = mode === "auto" ? S.modeAuto : mode === "full" ? S.modeFull : S.modeManual;
      const hint = mode === "auto" ? S.modeAutoHint : mode === "full" ? S.modeFullHint : S.modeManualHint;
      b.textContent = label;
      b.title = hint;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = !state.chatEnabled;
    }
    seg.classList.toggle("ch-seg--disabled", !state.chatEnabled);

    // Search mode: an unset conversation shows the default (smart).
    currentSearch = snap.searchMode ?? "smart";
    searchLabel.textContent = S.searchLabel;
    searchSeg.setAttribute("aria-label", S.searchLabel);
    for (const mode of SEARCH_MODES) {
      const b = searchOpts.get(mode);
      if (!b) continue;
      const on = mode === currentSearch;
      b.textContent = mode === "off" ? S.searchOff : mode === "always" ? S.searchAlways : S.searchSmart;
      b.title = S.searchHint;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = !state.chatEnabled;
    }
    searchSeg.classList.toggle("ch-seg--disabled", !state.chatEnabled);
  }

  return { el: root, update, openModel: model.open };
}
