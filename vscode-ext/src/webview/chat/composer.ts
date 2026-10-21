/**
 * The message composer: a growing textarea and one round button that is the OmniChat logo (send), or a stop
 * square while a reply is running. The draft lives in the textarea and is never reset by a state update.
 */
import type { Part, Send, ChatViewState } from "./types";
import { el, logoMark, stopMark } from "./dom";

/** Largest height (px) the textarea grows to before it scrolls. */
const MAX_ROWS = 8;

export function createComposer(send: Send): Part {
  const root = el("div", "cm-composer");
  const input = el("textarea", "cm-input");
  input.rows = 1;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "true");
  const sendBtn = el("button", "cm-send");
  sendBtn.type = "button";
  root.append(input, sendBtn);

  let last: ChatViewState | null = null;
  let isStop: boolean | null = null;
  /** Text handed to the host and not yet confirmed; restored if the host reports an error for it. */
  let pendingText: string | null = null;
  let errorAtSubmit: string | null = null;

  /** Grows with the text through `rows` (field-sizing in CSS does the same where supported); no inline styles (CSP). */
  function resize(): void {
    input.rows = Math.max(1, Math.min(MAX_ROWS, input.value.split("\n").length));
  }

  function submit(): void {
    if (!last || !last.chatEnabled || last.snapshot.sending) return;
    const text = input.value;
    if (text.trim() === "") return;
    send({ type: "send", text });
    pendingText = text;
    errorAtSubmit = last.errorText;
    input.value = "";
    resize();
    refreshButton();
  }

  function refreshButton(): void {
    const S = last ? last.strings : null;
    const running = last ? last.snapshot.running : false;
    const sending = last ? last.snapshot.sending : false;
    const stop = running && !sending;
    if (stop !== isStop) {
      isStop = stop;
      sendBtn.className = stop ? "cm-send cm-send--stop" : "cm-send";
      if (stop) sendBtn.replaceChildren(stopMark("oc-stopmark cm-stopmark"));
      else sendBtn.replaceChildren(logoMark());
    }
    if (S) {
      const label = stop ? S.stop : S.send;
      sendBtn.setAttribute("aria-label", label);
      sendBtn.title = label;
    }
    if (sending) sendBtn.setAttribute("aria-busy", "true");
    else sendBtn.removeAttribute("aria-busy");
    const chatEnabled = last ? last.chatEnabled : false;
    sendBtn.disabled = !chatEnabled || sending || (!stop && input.value.trim() === "");
    sendBtn.classList.toggle("cm-send--off", sendBtn.disabled);
  }

  sendBtn.addEventListener("click", () => {
    if (isStop) send({ type: "stop" });
    else submit();
  });

  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  input.addEventListener("input", () => {
    resize();
    refreshButton();
  });

  return {
    el: root,
    update(state: ChatViewState) {
      last = state;
      input.placeholder = state.strings.placeholder;
      input.disabled = !state.chatEnabled;

      // The host accepted the prompt once it is sending or running; drop the pending copy.
      if (pendingText !== null && (state.snapshot.sending || state.snapshot.running)) pendingText = null;
      // A new error for a prompt that was not accepted gives the text back, unless the user has typed since.
      if (pendingText !== null && state.errorText !== null && state.errorText !== errorAtSubmit) {
        if (input.value === "") {
          input.value = pendingText;
          resize();
        }
        pendingText = null;
      }

      refreshButton();
    },
  };
}
