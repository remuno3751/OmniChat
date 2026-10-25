/**
 * Entry of the Chat webview (bundled to media/webview/chat.js as an IIFE). Builds the page skeleton once,
 * then routes each host state to the parts. Host -> webview: {type:"state", state} | {type:"notice", text}.
 */
import type { ChatViewState, Part, Send } from "./types";
import { button, el, logoMark } from "./dom";
import { createApprovals } from "./cards";
import { createHeader } from "./header";
import { createHistory } from "./history";
import { createSettingsPanel } from "./settingsPanel";
import { createCheckpoints } from "./checkpoints";
import { createPickers } from "./pickers";
import { createMessageList } from "./messages";
import { createComposer } from "./composer";
import { installTips, setTip } from "./tip";

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
  const checkpoints = createCheckpoints(send, rootEl);
  const header = createHeader(send, {
    onToggleHistory: () => historyPanel?.toggle(),
    onToggleSettings: () => settingsPanel?.toggle(),
    checkpointBtn: checkpoints.button,
  });
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
  // The Edit button of the last prompt fills the composer (see editLast.ts).
  const messages = createMessageList(send, { onEdit: (text) => composer.beginEdit(text) });
  const pickers = createPickers(send);
  const composer = createComposer(send, { onOpenModel: () => pickers.openModel() });
  const pairing = createPairing();
  const historyPanel = createHistory(send);
  const settingsPanel = createSettingsPanel(send, { toast: (text) => composer.toast(text) });

  rootEl.replaceChildren(
    header.el,
    banner,
    errorBar,
    approvals.el,
    messages.el,
    pickers.el,
    composer.el,
    pairing.el,
    historyPanel.el,
    settingsPanel.el,
  );
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
    settingsPanel,
    checkpoints,
  };
}

const rootEl = document.getElementById("oc-root");
let ui: ReturnType<typeof build> | null = null;
let historyPanel: ReturnType<typeof createHistory> | null = null;
let settingsPanel: ReturnType<typeof createSettingsPanel> | null = null;
/** Last state and when it arrived: the reconnect countdown is redrawn from them every second. */
let lastState: ChatViewState | null = null;
let lastAt = 0;

function closeCheckpoints(): void {
  ui?.checkpoints.close();
}

function render(state: ChatViewState): void {
  const u = ui;
  if (!u) return;
  lastState = state;
  lastAt = Date.now();
  const paired = state.paired;

  u.pairing.el.hidden = paired;
  for (const part of [u.approvals, u.messages, u.pickers, u.composer]) part.el.hidden = !paired;
  if (!paired) {
    historyPanel?.toggle(false);
    settingsPanel?.toggle(false);
    closeCheckpoints();
  }

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
  setTip(u.dismiss, state.strings.close);

  const parts: Array<[string, Part]> = [
    ["header", u.header],
    ["approvals", u.approvals],
    ["messages", u.messages],
    ["pickers", u.pickers],
    ["composer", u.composer],
    ["pairing", u.pairing],
    ["history", u.historyPanel],
    ["settings", u.settingsPanel],
    ["checkpoints", u.checkpoints],
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
  settingsPanel = ui.settingsPanel;
  installTips(rootEl);

  // The reconnect banner counts down between host updates.
  setInterval(() => {
    const u = ui;
    const st = lastState;
    if (!u || !st || st.banner?.kind !== "reconnecting" || st.link.reconnect === null) return;
    const left = st.link.reconnect.retryInMs - (Date.now() - lastAt);
    u.banner.textContent = st.strings.reconnecting.replace("{sec}", String(Math.max(1, Math.ceil(left / 1000))));
  }, 1000);

  window.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as { type?: unknown; state?: ChatViewState; text?: unknown; id?: unknown } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state" && msg.state) {
      render(msg.state);
    } else if (msg.type === "notice" && typeof msg.text === "string") {
      ui?.pairing.notice(msg.text);
    } else if (msg.type === "toast" && typeof msg.text === "string") {
      ui?.composer.toast(msg.text);
    } else if (msg.type === "scrollToMessage" && typeof msg.id === "string") {
      ui?.messages.scrollTo(msg.id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      historyPanel?.toggle(false);
      settingsPanel?.toggle(false);
    }
  });

  send({ type: "ready" });
}

start();
