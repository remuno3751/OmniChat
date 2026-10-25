/**
 * Wording for the v0.5.5 connection and composer features: reconnecting banner, send guard hints,
 * the prompt queue and interrupt, search mode, the context meter, latency and the open-file refusal.
 * Merged into `Strings` in strings.ts (both languages must have the same keys).
 */
export interface ConnStrings {
  /** Banner while the link is down and a retry is scheduled. `{sec}` is replaced by the seconds left. */
  reconnecting: string;
  sendOffline: string;
  sendReconnecting: string;
  queued: string;
  queueRemove: string;
  interrupt: string;
  interruptHint: string;
  searchLabel: string;
  searchOff: string;
  searchSmart: string;
  searchAlways: string;
  searchHint: string;
  contextLabel: string;
  /** `{approx}`, `{used}`, `{limit}` and `{pct}` are replaced. */
  contextUsage: string;
  contextOver: string;
  latencyLabel: string;
  openFileRefused: string;
}

export const connJa: ConnStrings = {
  reconnecting: "再接続中… ({sec}秒後に再試行)",
  sendOffline: "オフラインのため送信できません",
  sendReconnecting: "再接続中のため送信できません",
  queued: "送信待ち",
  queueRemove: "送信待ちから削除",
  interrupt: "割り込み",
  interruptHint: "実行を止めて送信 (Ctrl+Enter)",
  searchLabel: "検索",
  searchOff: "オフ",
  searchSmart: "スマート",
  searchAlways: "常に",
  searchHint: "Web検索の使い方",
  contextLabel: "コンテキスト",
  contextUsage: "{approx}{used} / {limit} ({pct}%)",
  contextOver: "上限を超えています",
  latencyLabel: "通信遅延",
  openFileRefused: "このファイルは開けません",
};

export const connEn: ConnStrings = {
  reconnecting: "Reconnecting… (retry in {sec} s)",
  sendOffline: "Cannot send while offline",
  sendReconnecting: "Cannot send while reconnecting",
  queued: "Queued",
  queueRemove: "Remove from queue",
  interrupt: "Interrupt",
  interruptHint: "Stop the run and send (Ctrl+Enter)",
  searchLabel: "Search",
  searchOff: "Off",
  searchSmart: "Smart",
  searchAlways: "Always",
  searchHint: "How web search is used",
  contextLabel: "Context",
  contextUsage: "{approx}{used} / {limit} ({pct}%)",
  contextOver: "Over the context limit",
  latencyLabel: "Latency",
  openFileRefused: "This file cannot be opened",
};
