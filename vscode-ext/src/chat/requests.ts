/**
 * The request frames the controller sends besides the list and conversation ones: the context usage,
 * the device list and compaction. Each is tracked by requestId, so a silent server times out. Split
 * from controller.ts to keep it small. No `vscode` import.
 */
import type { Frame } from "../protocol/frames";
import type { CompactOutcome } from "./controllerTypes";
import type { RequestTracker } from "./pending";
import { createSettingsRequests, settingsViewOf, type SettingsRequests } from "./chatSettings";
import type { ChatState, ContextUsage } from "./state";
import type { ChatSupport } from "./support";

/** Compaction runs a model call on the server, so it gets more time than the list requests. */
export const COMPACT_TIMEOUT_MS = 120_000;

export interface RequestDeps {
  st: ChatState;
  send: (frame: Frame) => boolean;
  pending: RequestTracker;
  nextId: (prefix: string) => string;
  timeoutMs: number;
  support: () => ChatSupport;
  emit: () => void;
}

export interface ExtraRequests {
  /** Asks for the context usage of the open conversation. Silent when offline or no conversation is open. */
  context(onUsage?: (usage: ContextUsage) => void): void;
  /** Asks for the online bridges; the state goes to `st.devices`. */
  devices(): void;
  /** Asks the server to compact the open conversation. `onResult` is called once. */
  compact(onResult?: (r: CompactOutcome) => void): void;
  /** Conversation settings and history search (chatSettings.ts). */
  settings: SettingsRequests;
  /** The `settings` and `search` fields of the snapshot. */
  view: () => ReturnType<typeof settingsViewOf>;
}

export function createExtraRequests(d: RequestDeps): ExtraRequests {
  const { st } = d;
  return {
    settings: createSettingsRequests(d),
    view: () => settingsViewOf(st),
    context(onUsage) {
      if (!st.online || st.conversationId === null || d.support() === "unsupported") return;
      const conversationId = st.conversationId;
      d.pending.drop((r) => r.kind === "context");
      const requestId = d.nextId("c");
      if (!d.send({ type: "context_request", requestId, conversationId })) return;
      d.pending.track(requestId, { kind: "context", conversationId, ...(onUsage ? { onUsage } : {}) }, d.timeoutMs);
    },
    devices() {
      if (!st.online || d.support() === "unsupported") {
        st.devices = { state: "error", items: [] };
        d.emit();
        return;
      }
      d.pending.drop((r) => r.kind === "devices");
      const requestId = d.nextId("d");
      if (!d.send({ type: "devices_request", requestId })) {
        st.devices = { state: "error", items: [] };
        d.emit();
        return;
      }
      d.pending.track(requestId, { kind: "devices" }, d.timeoutMs);
      st.devices = { state: "loading", items: st.devices.items };
      d.emit();
    },
    compact(onResult) {
      const conversationId = st.conversationId;
      if (!st.online || conversationId === null || d.support() === "unsupported") {
        onResult?.({ ok: false });
        return;
      }
      const requestId = d.nextId("k");
      if (!d.send({ type: "compact_request", requestId, conversationId })) {
        onResult?.({ ok: false });
        return;
      }
      d.pending.track(requestId, { kind: "compact", conversationId, ...(onResult ? { onCompact: onResult } : {}) }, COMPACT_TIMEOUT_MS);
    },
  };
}
