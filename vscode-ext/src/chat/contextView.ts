/**
 * Context meter view and token breakdown: pre-rendered text for the webview, so it holds no formatting
 * rules. Split from viewModel.ts to keep that file small. No `vscode` import.
 */
import type { Strings } from "../ui/strings";
import type { ChatSnapshot } from "./controllerTypes";

/** Token count for the meter: 999 -> "999", 12345 -> "12.3k", 128000 -> "128k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

/** One line of the token breakdown: a label and the pre-formatted count. */
export interface TokenRow {
  label: string;
  tokens: string;
}

/** The token breakdown shown under the meter. `lastRows` is empty when there is no finished reply yet. */
export interface TokenBreakdown {
  rows: TokenRow[];
  lastRows: TokenRow[];
  /** Cache tokens are not reported by the server. */
  cacheNote: string;
  title: string;
}

/** Context meter: pre-rendered text and the level for the bar. */
export interface ContextView {
  text: string;
  pct: number;
  level: "ok" | "warn" | "full";
  /** Present when the server sent the `used` counts. */
  breakdown?: TokenBreakdown;
}

function buildBreakdown(usage: NonNullable<ChatSnapshot["context"]>, strings: Strings): TokenBreakdown {
  const used = usage.used!;
  const row = (label: string, n: number): TokenRow => ({ label, tokens: formatTokens(n) });
  const rows: TokenRow[] = [
    row(strings.tokSystem, used.system),
    row(strings.tokHistory, used.history),
    row(strings.tokAttach, used.attachments),
    row(strings.tokTools, used.tools),
    row(strings.tokInput, used.input),
  ];
  if (usage.reasoning !== undefined) rows.push(row(strings.tokReasoning, usage.reasoning));
  rows.push({
    label: strings.tokTotal,
    tokens: usage.limit > 0 ? `${formatTokens(usage.total)} / ${formatTokens(usage.limit)}` : formatTokens(usage.total),
  });
  const last = usage.last;
  const lastRows: TokenRow[] = last
    ? [row(strings.tokPrompt, last.prompt), row(strings.tokCompletion, last.completion), row(strings.tokReasoning, last.reasoning)]
    : [];
  return { rows, lastRows, cacheNote: strings.tokCache, title: strings.tokensTitle };
}

/** Context meter view. An unknown limit (0) shows only the token count; null when there is no usage yet. Warn from 80 %, full when it does not fit. */
export function buildContextView(usage: ChatSnapshot["context"], strings: Strings): ContextView | null {
  const view = meterView(usage, strings);
  if (view === null || usage === null || usage.used === undefined) return view;
  return { ...view, breakdown: buildBreakdown(usage, strings) };
}

function meterView(usage: ChatSnapshot["context"], strings: Strings): ContextView | null {
  if (usage === null) return null;
  if (!(usage.limit > 0)) return usage.total > 0 ? { text: `${usage.estimated ? "~" : ""}${formatTokens(usage.total)} tokens`, pct: 0, level: "ok" } : null;
  const ratio = usage.total / usage.limit;
  const pct = Math.min(999, Math.round(ratio * 100));
  const level: ContextView["level"] = !usage.fits ? "full" : ratio >= 0.8 ? "warn" : "ok";
  const text = strings.contextUsage
    .replace("{approx}", usage.estimated ? "~" : "")
    .replace("{used}", formatTokens(usage.total))
    .replace("{limit}", formatTokens(usage.limit))
    .replace("{pct}", String(pct));
  return { text, pct: Math.min(100, Math.round(ratio * 100)), level };
}
