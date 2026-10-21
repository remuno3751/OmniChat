/** Composer picker bar: folder, model and approval-mode controls (the app's pills and segmented switch). */
import type { ApprovalModeId } from "../../protocol/chat-frames";
import { el } from "./dom";
import type { ChatViewState, Part, Send } from "./types";

const MODES: ApprovalModeId[] = ["manual", "auto", "full"];

interface Option {
  value: string;
  label: string;
  title?: string;
  disabled?: boolean;
}

/** Last option list per select, so options are only rebuilt when they really changed. */
const signatures = new WeakMap<HTMLSelectElement, string>();

function syncSelect(sel: HTMLSelectElement, options: Option[], value: string): void {
  const sig = JSON.stringify(options);
  if (signatures.get(sel) !== sig) {
    signatures.set(sel, sig);
    sel.replaceChildren(
      ...options.map((o) => {
        const op = el("option", undefined, o.label);
        op.value = o.value;
        if (o.title) op.title = o.title;
        if (o.disabled) op.disabled = true;
        return op;
      }),
    );
  }
  // Never move the selection under a user who is looking at the list.
  if (document.activeElement !== sel && sel.value !== value) sel.value = value;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

export function createPickers(send: Send): Part {
  const root = el("div", "ch-pickers");

  const folder = el("select", "ch-select ch-folder");
  folder.addEventListener("change", () => send({ type: "setCwd", cwd: folder.value }));

  const model = el("select", "ch-select ch-model");
  model.addEventListener("change", () => send({ type: "setModel", ref: model.value === "" ? null : model.value }));

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

  root.append(folder, model, seg);

  function update(state: ChatViewState): void {
    const S = state.strings;
    const snap = state.snapshot;

    // Folder: only when the window has more than one workspace root.
    folder.hidden = snap.cwds.length < 2;
    folder.title = S.folder;
    folder.setAttribute("aria-label", S.folder);
    folder.disabled = !state.chatEnabled;
    syncSelect(
      folder,
      snap.cwds.map((c) => ({ value: c, label: basename(c), title: c })),
      snap.cwd ?? "",
    );

    // Model: a leading "default" option exists only when the server names a default model.
    const noModels = snap.models.length === 0;
    const modelOptions: Option[] = noModels
      ? [{ value: "", label: snap.defaultModel ?? S.selectModel, disabled: true }]
      : [
          ...(snap.defaultModel !== null ? [{ value: "", label: S.defaultModel }] : []),
          ...snap.models.map((m) => ({ value: m.ref, label: m.provider ? `${m.label} (${m.provider})` : m.label })),
        ];
    model.title = S.modelLabel;
    model.setAttribute("aria-label", S.modelLabel);
    model.disabled = noModels || !state.chatEnabled;
    const modelValue = noModels ? "" : (snap.model ?? (snap.defaultModel !== null ? "" : (snap.effectiveModel ?? "")));
    syncSelect(model, modelOptions, modelValue);

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
  }

  return { el: root, update };
}
