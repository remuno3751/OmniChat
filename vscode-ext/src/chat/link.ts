/**
 * Connection facts for the Chat view: the mean of the last ping round trips, and the scheduled
 * reconnect while the link is down. Fed from the client's latency and status callbacks. No `vscode` import.
 */
import type { ClientStatus, RetryInfo } from "../conn/client";
import { averageRtt, type LinkInfo } from "./viewModel";

/** Round trips averaged for the latency badge. */
const RTT_WINDOW = 5;

export interface LinkTracker {
  onLatency(ms: number): void;
  onStatus(state: ClientStatus, retry?: RetryInfo): void;
  info(): LinkInfo;
}

/** `onChange` runs after each latency sample (the view redraws the badge). */
export function createLinkTracker(onChange: () => void): LinkTracker {
  let rtts: number[] = [];
  let info: LinkInfo = { rttMs: null, reconnect: null };
  return {
    onLatency(ms) {
      rtts = [...rtts, ms].slice(-RTT_WINDOW);
      info = { ...info, rttMs: averageRtt(rtts) };
      onChange();
    },
    onStatus(state, retry) {
      if (state !== "online") rtts = [];
      info = {
        rttMs: state === "online" ? info.rttMs : null,
        reconnect: state === "offline" && retry ? retry : null,
      };
    },
    info: () => info,
  };
}
