/**
 * Status bar item for the connection state (spec docs/design/VSCODE-BRIDGE.md §5).
 * Stock VS Code UI: codicon + text. Clicking it opens the OmniChat view in the activity bar. While a run is
 * active on an online connection, it shows "running" with a spinner codicon.
 */
import type * as VS from "vscode";
import type { ClientStatus } from "../conn/client";

/** Connection states plus "unpaired" (no token stored). */
export type StatusState = ClientStatus | "unpaired";

export const SHOW_LOG_COMMAND = "omnichat.showLog";
/** Clicking the status item opens the Chat view (where pending approvals are shown). */
export const OPEN_CHAT_COMMAND = "omnichat.openChat";

const LABELS: Record<StatusState, { icon: string; text: string }> = {
  connecting: { icon: "$(sync~spin)", text: "connecting" },
  online: { icon: "$(plug)", text: "online" },
  offline: { icon: "$(debug-disconnect)", text: "offline" },
  incompatible: { icon: "$(warning)", text: "incompatible" },
  unauthorized: { icon: "$(error)", text: "unauthorized" },
  closed: { icon: "$(circle-slash)", text: "closed" },
  unpaired: { icon: "$(key)", text: "not paired" },
};

const RUNNING_LABEL = { icon: "$(loading~spin)", text: "running" };

export interface StatusView {
  text: string;
  tooltip: string;
}

/**
 * Pure formatter. `running` only applies while the connection is online, because a run
 * cannot continue across a disconnect. `detail` appears in the tooltip only.
 */
export function formatStatus(state: StatusState, running: boolean, detail?: string, pending = 0): StatusView {
  const active = running && state === "online";
  const label = active ? RUNNING_LABEL : LABELS[state];
  const waiting = pending > 0 ? `, ${pending} waiting for approval` : "";
  const text = `${label.icon} OmniChat: ${label.text}${waiting}`;
  if (active && pending === 0) return { text, tooltip: "OmniChat: running. Click to open OmniChat." };
  const tooltip = detail
    ? `OmniChat: ${label.text}${waiting} (${detail})`
    : `OmniChat: ${label.text}${waiting}. Click to open OmniChat.`;
  return { text, tooltip };
}

export interface StatusItem {
  set(state: StatusState, detail?: string): void;
  /** True while a run is active. Shown only when the connection is online. */
  setRunning(running: boolean): void;
  /** Number of tool calls waiting for an approval in the VS Code panel. */
  setPending(count: number): void;
  dispose(): void;
}

/** `detail` is shown in the tooltip only. Callers pass no secrets. */
export function createStatusItem(vscode: typeof VS): StatusItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = OPEN_CHAT_COMMAND;
  let state: StatusState = "unpaired";
  let detail: string | undefined;
  let running = false;
  let pending = 0;

  const render = (): void => {
    const view = formatStatus(state, running, detail, pending);
    item.text = view.text;
    item.tooltip = view.tooltip;
    item.show();
  };

  return {
    set(next, nextDetail) {
      state = next;
      detail = nextDetail;
      render();
    },
    setRunning(next) {
      running = next;
      render();
    },
    setPending(count) {
      pending = count;
      render();
    },
    dispose() {
      item.dispose();
    },
  };
}
