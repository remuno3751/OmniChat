/**
 * The composer: the prompt queue (removable chips), the context meter, the textarea, an interrupt button
 * and one round button that is the OmniChat logo (send), or a stop square while a run is going and the
 * draft is empty. The draft stays in the textarea until the host takes the prompt (sent or queued).
 */
import { attachTokens } from "./tokens";
import type { Part, Send, ChatViewState } from "./types";
import { extrasOf, sendExtra } from "./types";
import { el, logoMark, stopMark } from "./dom";
import { setTip } from "./tip";
import { createAttach } from "./attach";
import { createSlash } from "./slash";
import { createToast } from "./toast";
import { appendDraft, sendAction } from "./messageActions";
import { argCommand } from "./slashLogic";
import { createEditLast } from "./editLast";
import { stringsOf } from "./v056eTypes";

/** Largest height (px) the textarea grows to before it scrolls. */
const MAX_ROWS = 8;
/** Longest queue text shown in a chip (the rest is cut by CSS and kept in the title). */
const CHIP_CHARS = 60;

/** Enter that is part of an IME composition is not a send. */
export function isComposingKey(e: Pick<KeyboardEvent, "isComposing" | "keyCode" | "key">): boolean {
  return e.isComposing || (e.keyCode === 229 && (e.isComposing || e.key === "Process"));
}

export interface ComposerOptions {
  /** The /model command (the model picker is wired by the caller). */
  onOpenModel?(): void;
}

export function createComposer(send: Send, opts: ComposerOptions = {}): Part & { toast(text: string): void; beginEdit(text: string): void } {
  const block = el("div", "cm-composer-block");

  // Queue: prompts written while a run is going, sent in order when it ends.
  const queueRow = el("div", "cm-queue");
  queueRow.setAttribute("role", "list");
  queueRow.hidden = true;

  // Context meter: a thin bar and the usage text.
  const meter = el("div", "cm-meter");
  const meterBar = el("div", "cm-meter__bar");
  const meterFill = el("div", "cm-meter__fill");
  meterBar.appendChild(meterFill);
  const meterText = el("span", "cm-meter__text");
  meter.append(meterBar, meterText);
  meter.hidden = true;
  const updateTokens = attachTokens(meter);

  const root = el("div", "cm-composer");
  const input = el("textarea", "cm-input");
  input.rows = 1;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "true");
  const interruptBtn = el("button", "cm-interrupt");
  interruptBtn.type = "button";
  interruptBtn.hidden = true;
  const sendBtn = el("button", "cm-send");
  sendBtn.type = "button";
  const toast = createToast();
  const attach = createAttach({ input, zone: root, toast: toast.show, onChange: () => refreshButton() });
  const slash = createSlash({
    input,
    send,
    toast: toast.show,
    onOpenModel: () => opts.onOpenModel?.(),
    onDone: () => afterEdit(),
  });
  // Editing the last prompt: the band above the input; cancel empties the draft (it is not restored).
  const edit = createEditLast(() => {
    input.value = "";
    afterEdit();
  });
  root.append(slash.el, toast.el, attach.button, input, interruptBtn, sendBtn, attach.overlay);
  block.append(queueRow, meter, attach.chips, edit.el, root, attach.fileInput);

  let last: ChatViewState | null = null;
  let lastConversation: string | null | undefined = undefined;
  let isStop: boolean | null = null;
  /** The text handed to the host and not yet taken; cleared once the host takes it, kept on an error. */
  let pendingText: string | null = null;
  let errorAtSubmit: string | null = null;
  /** Set on submit, cleared by the next state from the host (so a second click cannot send again). */
  let inFlight = false;
  let queued = 0;
  let queueSig = "";

  /** Grows with the text through `rows` (field-sizing in CSS does the same where supported); no inline styles (CSP). */
  function resize(): void {
    input.rows = Math.max(1, Math.min(MAX_ROWS, input.value.split("\n").length));
  }

  /** After the draft changed (typing, or a slash command cleared it): size, button, and the host's draft flag. */
  function afterEdit(): void {
    resize();
    refreshButton();
    send({ type: "draftChanged" });
  }

  /** Sends the draft. `interrupt` stops the active run first (Ctrl+Enter). Attachments go only with a text. */
  function submit(interrupt: boolean): void {
    if (!last || !last.chatEnabled || inFlight || attach.busy()) return;
    const text = input.value;
    if (text.trim() === "") return;
    // /effort, /rename and /export json carry their argument in the slash message; they are not prompts.
    const cmd = argCommand(text);
    if (cmd) {
      sendExtra(send, cmd.arg === "" ? { type: "slash", name: cmd.name } : { type: "slash", name: cmd.name, arg: cmd.arg });
      input.value = "";
      afterEdit();
      slash.refresh();
      return;
    }
    // An edit of the last prompt sends the text only (no attachments) and replaces that prompt on the host.
    const editing = edit.active();
    const attachments = editing ? [] : attach.takeAttachments();
    const extra = attachments.length > 0 ? { attachments } : {};
    const replace = editing ? { replaceLast: true as const } : {};
    sendExtra(send, interrupt ? { type: "sendInterrupt", text, ...extra, ...replace } : { type: "send", text, ...extra, ...replace });
    inFlight = true;
    pendingText = text;
    errorAtSubmit = last.errorText;
    refreshButton();
  }

  function refreshButton(): void {
    const S = last ? last.strings : null;
    const running = last ? last.snapshot.running : false;
    const busy = last ? last.snapshot.sending || running : false;
    const draft = input.value.trim() !== "";
    // While a run goes and the draft is empty the round button stops it; with a draft it queues the draft.
    const stop = running && !draft;
    if (stop !== isStop) {
      isStop = stop;
      sendBtn.className = stop ? "cm-send cm-send--stop" : "cm-send";
      if (stop) sendBtn.replaceChildren(stopMark("oc-stopmark cm-stopmark"));
      else sendBtn.replaceChildren(logoMark());
    }
    if (S) {
      const label = stop ? S.stop : S.send;
      sendBtn.setAttribute("aria-label", label);
      setTip(sendBtn, edit.active() && last ? stringsOf(last).editSendTip : label);
      interruptBtn.textContent = S.interrupt;
      setTip(interruptBtn, S.interruptHint);
      interruptBtn.setAttribute("aria-label", S.interruptHint);
    }
    interruptBtn.hidden = !(busy && draft);
    if (busy) sendBtn.setAttribute("aria-busy", "true");
    else sendBtn.removeAttribute("aria-busy");

    const chatEnabled = last ? last.chatEnabled : false;
    const reconnecting = last ? last.link.reconnect !== null : false;
    if (S && !chatEnabled && last && last.snapshot.chatSupport !== "unsupported") {
      const why = reconnecting ? S.sendReconnecting : S.sendOffline;
      setTip(sendBtn, why);
    }
    sendBtn.disabled = !chatEnabled || inFlight || (!stop && !draft);
    sendBtn.classList.toggle("cm-send--off", sendBtn.disabled);
    interruptBtn.disabled = !chatEnabled || inFlight;
  }

  /** Takes a queued prompt back: it leaves the queue and its text goes into the composer (after a newline if any). */
  function takeBack(item: { id: string; text: string }): void {
    // A locked composer (unsupported server) keeps the prompt queued rather than dropping its text.
    if (input.disabled) return;
    send({ type: "cancelQueued", id: item.id });
    input.value = appendDraft(input.value, item.text);
    afterEdit();
    input.focus();
  }

  function renderQueue(state: ChatViewState): void {
    const items = state.snapshot.queue;
    const sig = JSON.stringify(items) + state.strings.queued + state.strings.queueRun;
    if (sig === queueSig) return;
    queueSig = sig;
    const S = state.strings;
    queueRow.replaceChildren(
      ...items.map((item) => {
        const chip = el("span", "cm-queue__chip");
        chip.setAttribute("role", "listitem");
        const text = el("span", "cm-queue__text", item.text.length > CHIP_CHARS ? `${item.text.slice(0, CHIP_CHARS)}…` : item.text);
        const tag = el("span", "cm-queue__tag", S.queued);
        const run = el("button", "cm-queue__run", S.queueRun);
        run.type = "button";
        setTip(run, S.queueRunTip);
        run.setAttribute("aria-label", S.queueRun);
        run.addEventListener("click", () => sendAction(send, { type: "interruptQueued", id: item.id }));
        const x = el("button", "cm-queue__x", "×");
        x.type = "button";
        x.title = S.queueRemove;
        x.setAttribute("aria-label", S.queueRemove);
        x.addEventListener("click", () => takeBack(item));
        chip.title = `${S.queued}: ${item.text}`;
        chip.append(tag, text, run, x);
        return chip;
      }),
    );
    queueRow.hidden = items.length === 0;
  }

  function renderMeter(state: ChatViewState): void {
    const ctx = state.context;
    if (ctx === null) {
      meter.hidden = true;
      return;
    }
    meter.hidden = false;
    meter.className = `cm-meter cm-meter--${ctx.level}`;
    meter.title = state.strings.contextLabel;
    meterText.textContent = ctx.text;
    meterFill.style.setProperty("width", `${ctx.pct}%`);
    updateTokens(state);
  }

  sendBtn.addEventListener("click", () => {
    if (isStop) send({ type: "stop" });
    else submit(false);
  });
  interruptBtn.addEventListener("click", () => submit(true));

  input.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    // An open slash popup takes its keys first (Up/Down/Tab/Enter/Escape).
    if (slash.onKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e.ctrlKey || e.metaKey);
    }
  });

  input.addEventListener("input", () => {
    slash.refresh();
    afterEdit();
  });

  return {
    el: block,
    toast: toast.show,
    /** Puts the last prompt into the draft for editing (the Edit button of the transcript). */
    beginEdit(text: string) {
      edit.begin();
      input.value = text;
      afterEdit();
      input.focus();
      input.setSelectionRange(text.length, text.length);
    },
    update(state: ChatViewState) {
      const previousQueued = queued;
      last = state;
      queued = state.snapshot.queue.length;
      input.placeholder = state.strings.placeholder;
      // Typing stays possible while offline (the draft is kept); only an unsupported server locks it.
      input.disabled = state.snapshot.chatSupport === "unsupported";

      // A conversation switch or a new chat ends an edit; the draft is emptied, not restored.
      const conversation = state.snapshot.conversationId;
      if (conversation !== lastConversation) {
        lastConversation = conversation;
        if (edit.active()) {
          edit.end();
          input.value = "";
          resize();
        }
      }
      edit.update(stringsOf(state));

      if (inFlight) {
        inFlight = false;
        // The host took the prompt: it is sending, running, or queued behind a run.
        const taken = state.snapshot.sending || state.snapshot.running || queued > previousQueued;
        if (pendingText !== null && taken) {
          if (input.value === pendingText) {
            input.value = "";
            resize();
          }
          pendingText = null;
          attach.clear();
          edit.end();
        }
      }
      // A new error for a prompt that was not taken keeps the text as the draft (and its files).
      if (pendingText !== null && state.errorText !== null && state.errorText !== errorAtSubmit) pendingText = null;

      attach.update(state);
      slash.setEntries(extrasOf(state).slash);
      renderQueue(state);
      renderMeter(state);
      refreshButton();
    },
  };
}
