/**
 * Chat header: OmniChat mark, conversation title (cut with an ellipsis; the full title is the tooltip), connection
 * chip, latency badge, and the icon buttons (history, new, this chat's settings). "Open in editor" and "move to the right side
 * bar" live in the VS Code view title bar, so the header does not repeat them.
 */
import { el, logoMark, svg } from "./dom";
import { setTip } from "./tip";
import type { ChatViewState, Part, Send } from "./types";

const ICON_CLOCK: Array<[string, Record<string, string>]> = [
  ["circle", { cx: "12", cy: "12", r: "9" }],
  ["path", { d: "M12 7v5l3 2" }],
];
const ICON_PLUS: Array<[string, Record<string, string>]> = [["path", { d: "M12 5v14M5 12h14" }]];
const ICON_GEAR: Array<[string, Record<string, string>]> = [
  ["path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }],
  ["circle", { cx: "15", cy: "7", r: "2" }],
  ["circle", { cx: "9", cy: "17", r: "2" }],
];

/** Latency colour bands (ms), the same as the app's badge. */
const LAT_GOOD_MS = 150;
const LAT_SLOW_MS = 500;

function iconButton(icon: SVGSVGElement, onClick: () => void): HTMLButtonElement {
  const b = el("button", "ch-iconbtn");
  b.type = "button";
  b.appendChild(icon);
  b.addEventListener("click", onClick);
  return b;
}

/** Maps the connection state to the colour of the status dot. */
function tone(status: ChatViewState["status"]): "good" | "warn" | "danger" {
  if (status === "online") return "good";
  return status === "connecting" ? "warn" : "danger";
}

/** Latency band: off when not connected, otherwise good / slow / bad by the round trip. */
export function latencyBand(online: boolean, rttMs: number | null): "off" | "good" | "slow" | "bad" {
  if (!online) return "off";
  if (rttMs === null) return "good";
  return rttMs < LAT_GOOD_MS ? "good" : rttMs <= LAT_SLOW_MS ? "slow" : "bad";
}

export function createHeader(send: Send, opts: { onToggleHistory(): void; onToggleSettings(): void; checkpointBtn?: HTMLElement }): Part {
  const root = el("header", "ch-header");

  const brand = el("div", "ch-header__brand");
  const title = el("h1", "ch-header__title");
  brand.append(logoMark("oc-logo"), title);

  const chip = el("span", "ch-status");
  chip.setAttribute("role", "status");
  const dot = el("span", "ch-status__dot");
  const chipText = el("span", "ch-status__text");
  chip.append(dot, chipText);

  const latency = el("span", "ch-latency", "-- ms");

  const tools = el("div", "ch-header__tools");
  let historyOpen = false;
  const historyBtn = iconButton(svg("0 0 24 24", "ch-icon", ICON_CLOCK), () => {
    historyOpen = !historyOpen;
    historyBtn.setAttribute("aria-expanded", String(historyOpen));
    opts.onToggleHistory();
  });
  historyBtn.setAttribute("aria-expanded", "false");
  const newBtn = iconButton(svg("0 0 24 24", "ch-icon", ICON_PLUS), () => send({ type: "newConversation" }));
  // The gear opens this chat's settings panel (settingsPanel.ts); the window-level settings stay on the pairing card.
  const settingsBtn = iconButton(svg("0 0 24 24", "ch-icon", ICON_GEAR), () => opts.onToggleSettings());
  settingsBtn.classList.add("ch-cs-open");
  tools.append(historyBtn, newBtn, settingsBtn);
  // The checkpoint button (checkpoints.ts) sits between history and new chat.
  if (opts.checkpointBtn) tools.insertBefore(opts.checkpointBtn, newBtn);

  root.append(brand, chip, latency, tools);

  function update(state: ChatViewState): void {
    const S = state.strings;
    title.textContent = state.title;
    title.title = state.title;

    const label = S.status[state.status];
    chipText.textContent = label;
    dot.className = `ch-status__dot ch-status__dot--${tone(state.status)}`;
    const version = state.snapshot.serverVersion;
    if (version) chip.title = version;
    else chip.removeAttribute("title");

    const band = latencyBand(state.status === "online", state.link.rttMs);
    latency.textContent = band === "off" || state.link.rttMs === null ? "-- ms" : `${state.link.rttMs} ms`;
    latency.className = `ch-latency ch-latency--${band}`;
    latency.title = S.latencyLabel;
    latency.setAttribute("aria-label", `${S.latencyLabel}: ${latency.textContent}`);

    tools.hidden = !state.paired;
    for (const [btn, text] of [
      [historyBtn, S.history],
      [newBtn, S.newConversation],
      [settingsBtn, S.csOpen],
    ] as const) {
      setTip(btn, text);
    }
  }

  return { el: root, update };
}
