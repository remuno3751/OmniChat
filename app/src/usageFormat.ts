/**
 * Pure helpers for the Usage screen and the /usage slash command (no React, no i18n).
 * Time: `tz` is minutes EAST of UTC (= -new Date().getTimezoneOffset()); all epoch values are milliseconds.
 */

export type UsagePeriodKey = '7d' | '30d' | '90d' | 'all';
/** Periods of the /usage slash command. */
export type SlashPeriod = 'today' | 'week' | 'month' | 'all';
export type UsageLang = 'en' | 'ja';
export interface UsageRange { from: number | null; to: null }

const MS_MIN = 60000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact token count: 987 -> '987', 1234 -> '1.2k', 9999 -> '10k', 12345 -> '12.3k', 123456 -> '123k',
 * 1200000 -> '1.2M'. Negative, NaN or infinite -> '0'.
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 999500) {
    const v = n / 1000;
    // one decimal below 100k, integer from 100k up
    return n < 100000 ? `${Math.round(v * 10) / 10}k` : `${Math.round(v)}k`;
  }
  return `${Math.round((n / 1e6) * 10) / 10}M`;
}

/** Minutes east of UTC for the given moment (0 for UTC, never -0). */
export function tzOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset() || 0;
}

export function periodDays(p: UsagePeriodKey): number {
  return p === '7d' ? 7 : p === '30d' ? 30 : p === '90d' ? 90 : 0;
}

/** Epoch ms of local midnight (in tz) `daysBack` days before the local date of `now`. */
function localMidnight(now: number, tz: number, daysBack: number): number {
  const sh = new Date(now + tz * MS_MIN);
  return Date.UTC(sh.getUTCFullYear(), sh.getUTCMonth(), sh.getUTCDate() - daysBack) - tz * MS_MIN;
}

/** Period start for the Usage screen: local midnight of today - (days - 1); `from` null for 'all'. */
export function periodRange(p: UsagePeriodKey, now: number, tz: number): UsageRange {
  const d = periodDays(p);
  return { from: d ? localMidnight(now, tz, d - 1) : null, to: null };
}

/** Period start for the /usage slash command: today = local midnight today, week = 7 days incl. today, month = 30 days incl. today. */
export function slashPeriodRange(p: SlashPeriod, now: number, tz: number): UsageRange {
  const d = p === 'today' ? 1 : p === 'week' ? 7 : p === 'month' ? 30 : 0;
  return { from: d ? localMidnight(now, tz, d - 1) : null, to: null };
}

/** Axis label of a 'YYYY-MM-DD' day: en 'Oct 18', ja '10/18'. Unparseable input is returned unchanged. */
export function dayLabel(day: string, lang: UsageLang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return day;
  return lang === 'ja' ? `${mo}/${d}` : `${MONTHS[mo - 1]} ${d}`;
}

/** Date of an epoch ms in tz: en 'Oct 18, 2026', ja '2026/10/18'. '-' for a missing (0 / NaN) time. */
export function shortDate(ms: number, tz: number, lang: UsageLang): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-';
  const sh = new Date(ms + tz * MS_MIN);
  const y = sh.getUTCFullYear();
  const mo = sh.getUTCMonth() + 1;
  const d = sh.getUTCDate();
  return lang === 'ja' ? `${y}/${mo}/${d}` : `${MONTHS[mo - 1]} ${d}, ${y}`;
}

/**
 * Pixel heights of one stacked bar (input bottom, output, thinking top are the caller's layout choice).
 * Values: input = promptTokens, thinking = reasoningTokens, output = completionTokens - reasoningTokens.
 * Scaled to `max` = `height`. Each non-zero part is at least 1px; the parts always sum to <= height.
 */
export function segmentHeights(
  day: { promptTokens: number; completionTokens: number; reasoningTokens: number },
  max: number,
  height: number,
): { input: number; output: number; thinking: number } {
  const input = Math.max(0, day.promptTokens || 0);
  const thinking = Math.max(0, day.reasoningTokens || 0);
  const output = Math.max(0, (day.completionTokens || 0) - thinking);
  const vals = [input, output, thinking];
  if (!(height > 0) || !(max > 0)) return { input: 0, output: 0, thinking: 0 };
  const h = vals.map((v) => (v > 0 ? Math.max(1, Math.floor((v * height) / max)) : 0));
  const sum = () => h[0] + h[1] + h[2];
  while (sum() > height) {
    let big = 0;
    for (let i = 1; i < 3; i++) if (h[i] > h[big]) big = i;
    if (h[big] <= 0) break;
    h[big]--;
  }
  return { input: h[0], output: h[1], thinking: h[2] };
}

/** Rounds a positive value up to 1, 2 or 5 times a power of ten (y-axis maximum). Non-positive -> 1. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Share as a fraction (0..1) to text: 0.45 -> '45%', below 1% -> '<1%', none -> '0%'. */
export function sharePct(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const p = share * 100;
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}
