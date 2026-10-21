/**
 * Entry of the Chat webview (bundled to media/webview/chat.js as an IIFE). Builds the page skeleton once,
 * then routes each host state to the parts. Host -> webview: {type:"state", state} | {type:"notice", text}.
 */
import type { ChatViewState, Part, Send } from "./types";
import { button, el, logoMark } from "./dom";
import { createApprovals } from "./cards";
import { createHeader } from "./header";
import { createHistory } from "./history";
import { createPickers } from "./pickers";
import { createMessageList } from "./messages";
import { createComposer } from "./composer";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
const send: Send = (msg) => {
  if (vscode) vscode.postMessage(msg);
};

/** Pairing card shown instead of the chat while the extension is not paired. */
function createPairing(): Part & { notice(text: string): void } {
  const root = el("section", "cm-pair");
  const card = el("div", "cm-pair__card");
  const logo = logoMark("oc-logo cm-pair__logo");
  const title = el("h2", "cm-pair__title");
  const body = el("p", "cm-pair__body");
  const row = el("div", "cm-pair__row");
  const code = el("input", "cm-pair__input");
  code.type = "password";
  code.autocomplete = "off";
  code.spellcheck = false;
  const pairBtn = button("", "cm-btn cm-btn--primary", () => doPair());
  const note = el("div", "cm-pair__note");
  note.setAttribute("role", "status");
  const settings = button("", "cm-btn", () => send({ type: "openSettings" }));
  row.append(code, pairBtn);
  card.append(logo, title, body, row, note, settings);
  root.appendChild(card);

  function doPair(): void {
    const value = code.value.trim();
    if (value === "") return;
    note.textContent = "";
    send({ type: "pair", code: value });
    code.value = "";
  }
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doPair();
  });

  return {
    el: root,
    update(state: ChatViewState) {
      const S = state.strings;
      title.textContent = S.pairTitle;
      body.textContent = S.pairBody;
      code.setAttribute("aria-label", S.pairCode);
      code.placeholder = S.pairCode;
      pairBtn.textContent = S.pairButton;
      settings.textContent = S.settings;
    },
    notice(text: string) {
      note.textContent = text;
    },
  };
}

function safe(name: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[omnichat] ${name} failed`, err);
  }
}

function build(rootEl: HTMLElement) {
  const header = createHeader(send, { onToggleHistory: () => historyPanel?.toggle() });
  const banner = el("div", "cm-banner");
  banner.setAttribute("role", "status");
  banner.hidden = true;
  const errorBar = el("div", "cm-error");
  errorBar.setAttribute("role", "alert");
  const errorText = el("span", "cm-error__text");
  const dismiss = button("×", "cm-error__close", () => send({ type: "dismissError" }));
  errorBar.append(errorText, dismiss);
  errorBar.hidden = true;

  const approvals = createApprovals(send);
  const messages = createMessageList(send);
  const pickers = createPickers(send);
  const composer = createComposer(send);
  const pairing = createPairing();
  const historyPanel = createHistory(send);

  rootEl.replaceChildren(header.el, banner, errorBar, approvals.el, messages.el, pickers.el, composer.el, pairing.el, historyPanel.el);
  rootEl.className = "oc-page";

  return {
    header,
    banner,
    errorBar,
    errorText,
    dismiss,
    approvals,
    messages,
    pickers,
    composer,
    pairing,
    historyPanel,
  };
}

const rootEl = document.getElementById("oc-root");
let ui: ReturnType<typeof build> | null = null;
let historyPanel: ReturnType<typeof createHistory> | null = null;

function render(state: ChatViewState): void {
  const u = ui;
  if (!u) return;
  const paired = state.paired;

  u.pairing.el.hidden = paired;
  for (const part of [u.approvals, u.messages, u.pickers, u.composer]) part.el.hidden = !paired;
  if (!paired) historyPanel?.toggle(false);

  if (state.banner) {
    u.banner.hidden = false;
    u.banner.textContent = state.banner.text;
    const warn = state.banner.kind === "unsupported" || state.banner.kind === "no_models";
    u.banner.className = `cm-banner cm-banner--${state.banner.kind}${warn ? " cm-banner--warn" : ""}`;
  } else {
    u.banner.hidden = true;
    u.banner.textContent = "";
  }

  u.errorBar.hidden = state.errorText === null;
  u.errorText.textContent = state.errorText ?? "";
  u.dismiss.setAttribute("aria-label", state.strings.close);
  u.dismiss.title = state.strings.close;

  const parts: Array<[string, Part]> = [
    ["header", u.header],
    ["approvals", u.approvals],
    ["messages", u.messages],
    ["pickers", u.pickers],
    ["composer", u.composer],
    ["pairing", u.pairing],
    ["history", u.historyPanel],
  ];
  for (const [name, part] of parts) safe(name, () => part.update(state));
}

function start(): void {
  if (!rootEl) {
    console.error("[omnichat] #oc-root not found");
    return;
  }
  ui = build(rootEl);
  historyPanel = ui.historyPanel;

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as { type?: unknown; state?: ChatViewState; text?: unknown } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state" && msg.state) {
      render(msg.state);
    } else if (msg.type === "notice" && typeof msg.text === "string") {
      ui?.pairing.notice(msg.text);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") historyPanel?.toggle(false);
  });

  send({ type: "ready" });
}

start();
