/**
 * Chat settings panel (the gear in the header): the system prompt of this chat, how it combines with the default
 * instructions, and the thinking effort. It covers the chat, not the window. Saving sends `saveSettings` and closes;
 * the host toasts the result. The draft is reloaded from the host whenever the stored settings change.
 */
import { MAX_SYSTEM_PROMPT, type ConversationSettings, type EffortLevel, type SystemMode } from "../../protocol/chat-frames-v056d";
import { button, el, svg } from "./dom";
import { EFFORT_CHOICES, effortLabel } from "./effortChip";
import { setTip } from "./tip";
import { sendExtra, settingsOf, type ChatViewState, type Part, type Send } from "./types";

const ICON_CLOSE: Array<[string, Record<string, string>]> = [["path", { d: "M6 6l12 12M18 6L6 18" }]];
const MODES: SystemMode[] = ["append", "replace"];

export interface Draft {
  systemPrompt: string;
  systemMode: SystemMode;
  effort: EffortLevel | null;
}

/** The draft a stored value starts from; with nothing stored, an empty prompt, the append mode and the default effort. */
export function draftOf(value: ConversationSettings | null): Draft {
  return { systemPrompt: value?.systemPrompt ?? "", systemMode: value?.systemMode ?? "append", effort: value?.effort ?? null };
}

export interface SettingsPanel extends Part {
  toggle(open?: boolean): void;
}

export function createSettingsPanel(send: Send, opts: { toast(text: string): void }): SettingsPanel {
  const root = el("section", "ch-cs");
  root.hidden = true;
  root.setAttribute("role", "dialog");

  const head = el("div", "ch-cs__head");
  const title = el("h2", "ch-cs__title");
  title.id = "ch-cs-title";
  root.setAttribute("aria-labelledby", title.id);
  const closeBtn = el("button", "ch-iconbtn");
  closeBtn.type = "button";
  closeBtn.appendChild(svg("0 0 24 24", "ch-icon", ICON_CLOSE));
  closeBtn.addEventListener("click", () => toggle(false));
  head.append(title, closeBtn);

  const body = el("div", "ch-cs__body");
  const promptField = el("div", "ch-cs__field");
  const promptLabel = el("label", "ch-cs__label");
  const text = el("textarea", "ch-cs__text");
  text.id = "ch-cs-prompt";
  promptLabel.htmlFor = text.id;
  text.maxLength = MAX_SYSTEM_PROMPT;
  text.spellcheck = false;
  const hint = el("p", "ch-cs__hint");
  promptField.append(promptLabel, text, hint);

  const modes = el("div", "ch-cs__modes");
  modes.setAttribute("role", "radiogroup");
  const modeInputs = new Map<SystemMode, { input: HTMLInputElement; text: HTMLElement }>();
  for (const mode of MODES) {
    const lab = el("label", "ch-cs__radio");
    const input = el("input");
    input.type = "radio";
    input.name = "ch-cs-mode";
    const span = el("span");
    lab.append(input, span);
    modes.appendChild(lab);
    modeInputs.set(mode, { input, text: span });
    input.addEventListener("change", () => {
      if (input.checked) draft.systemMode = mode;
    });
  }

  const effortField = el("div", "ch-cs__field");
  const effortLabelEl = el("div", "ch-cs__label");
  effortLabelEl.id = "ch-cs-effort-label";
  const efforts = el("div", "ch-cs__efforts");
  efforts.setAttribute("role", "group");
  efforts.setAttribute("aria-labelledby", effortLabelEl.id);
  const effortBtns = EFFORT_CHOICES.map((choice) => {
    const b = el("button", "ch-cs__eff");
    b.type = "button";
    b.addEventListener("click", () => {
      draft.effort = choice;
      renderDraft();
    });
    efforts.appendChild(b);
    return { choice, btn: b };
  });
  effortField.append(effortLabelEl, efforts);
  body.append(promptField, modes, effortField);
  const controls: Array<HTMLTextAreaElement | HTMLInputElement | HTMLButtonElement> = [
    text,
    ...Array.from(modeInputs.values(), (m) => m.input),
    ...effortBtns.map((x) => x.btn),
  ];

  const foot = el("div", "ch-cs__foot");
  const cancelBtn = button("", "ch-cs__btn", () => toggle(false));
  const saveBtn = button("", "ch-cs__btn ch-cs__btn--primary", () => save());
  foot.append(cancelBtn, saveBtn);
  root.append(head, body, foot);

  let last: ChatViewState | null = null;
  let draft: Draft = draftOf(null);
  let loadedSig = ""; // the stored settings the draft was loaded from

  const sigOf = (state: ChatViewState): string =>
    `${settingsOf(state).state}\u0000${JSON.stringify(settingsOf(state).value)}\u0000${state.snapshot.conversationId ?? ""}`;

  function renderDraft(): void {
    if (text.value !== draft.systemPrompt) text.value = draft.systemPrompt;
    for (const [mode, { input }] of modeInputs) input.checked = mode === draft.systemMode;
    for (const { choice, btn } of effortBtns) {
      const on = choice === draft.effort;
      btn.classList.toggle("ch-cs__eff--on", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  function save(): void {
    if (saveBtn.disabled) return;
    sendExtra(send, {
      type: "saveSettings",
      systemPrompt: draft.systemPrompt,
      systemMode: draft.systemMode,
      effort: draft.effort,
    });
    toggle(false);
  }

  /** Opens or closes the panel. Opening needs a conversation; without one the user gets a toast instead. */
  function toggle(next?: boolean): void {
    const open = next ?? root.hidden;
    if (open === !root.hidden) return;
    if (!open) {
      root.hidden = true;
      return;
    }
    if (!last) return;
    if (last.snapshot.conversationId === null) {
      opts.toast(last.strings.csNeedConversation);
      return;
    }
    draft = draftOf(settingsOf(last).value);
    loadedSig = sigOf(last);
    root.hidden = false;
    renderDraft();
    sendExtra(send, { type: "requestSettings" });
    text.focus();
  }

  text.addEventListener("input", () => {
    draft.systemPrompt = text.value;
  });

  return {
    el: root,
    toggle,
    update(state: ChatViewState) {
      last = state;
      const S = state.strings;
      const view = settingsOf(state);
      const loading = view.state === "loading";
      const failed = view.state === "error";

      title.textContent = S.csTitle;
      setTip(closeBtn, S.close);
      promptLabel.textContent = S.csSystemPrompt;
      hint.textContent = loading ? S.csLoading : failed ? S.csFailed : S.csSystemHint;
      text.placeholder = S.csSystemHint;
      for (const mode of MODES) {
        const m = modeInputs.get(mode);
        if (m) m.text.textContent = mode === "append" ? S.csModeAppend : S.csModeReplace;
      }
      effortLabelEl.textContent = S.csEffort;
      for (const { choice, btn } of effortBtns) btn.textContent = effortLabel(choice, S);
      cancelBtn.textContent = S.csCancel;
      saveBtn.textContent = S.csSave;
      saveBtn.disabled = loading || view.value === null;
      for (const c of controls) c.disabled = loading;

      const sig = sigOf(state);
      if (sig === loadedSig) return;
      loadedSig = sig;
      if (root.hidden) return;
      if (state.snapshot.conversationId === null) toggle(false);
      else {
        draft = draftOf(view.value);
        renderDraft();
      }
    },
  };
}
