/**
 * Pure formatting helpers for the Chat view (relative times, durations, titles). No `vscode` import.
 * English month names are fixed so the output does not depend on Intl or the host locale.
 */
import type { Lang } from "../ui/strings";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Start of the local calendar day containing `ts`, in ms. */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Relative time for a conversation list: "just now", "5m ago" / "たった今", "3時間前", "yesterday" /
 * "昨日", "4d ago" / "4日前" (under a week), then the date ("Oct 3" / "10/3"). Future times read as now.
 */
export function relativeTime(ts: number, now: number, lang: Lang): string {
  const diff = now - ts;
  if (diff < MINUTE) return lang === "ja" ? "たった今" : "just now";
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return lang === "ja" ? `${m}分前` : `${m}m ago`;
  }
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  if (dayDiff <= 0) {
    const h = Math.floor(diff / HOUR);
    return lang === "ja" ? `${h}時間前` : `${h}h ago`;
  }
  if (dayDiff === 1) return lang === "ja" ? "昨日" : "yesterday";
  if (dayDiff < 7) return lang === "ja" ? `${dayDiff}日前` : `${dayDiff}d ago`;
  const d = new Date(ts);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return lang === "ja" ? `${month}/${day}` : `${EN_MONTHS[d.getMonth()]} ${day}`;
}

/** Tool and run durations: "250ms", "1.2s", "1m 05s". Negative or non-finite values read as "0ms". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Shortens a title to `max` characters (code points), adding an ellipsis when cut. */
export function truncateTitle(s: string, max: number): string {
  const chars = Array.from(s.trim());
  if (chars.length <= max) return chars.join("");
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${chars.slice(0, max - 1).join("")}…`;
}
