// Voice call usage per user and local day (table voice_usage, see migrate-voice.ts), and the daily call-time limit per user
// (the common VoiceServerConfig.dailyLimitMinutes, or the user's override in userDailyMinutes; 0 = unlimited). Same local-day rule as quota.ts (its localDay).
import { db } from "./db.js";
import { localDay } from "./quota.js";
import { readUserDailyMinutes, readVoiceConfig } from "./voice-store.js";

export interface VoiceUsageTotals { callSeconds: number; turns: number; replyChars: number }
export interface VoiceUsageDay extends VoiceUsageTotals { day: string }

const DAY_MS = 24 * 60 * 60 * 1000;
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
export const emptyVoiceUsage = (): VoiceUsageTotals => ({ callSeconds: 0, turns: 0, replyChars: 0 });
const add = (t: VoiceUsageTotals, r: any): void => {
  t.callSeconds += Number(r.call_seconds) || 0;
  t.turns += Number(r.turns) || 0;
  t.replyChars += Number(r.reply_chars) || 0;
};
/** The first local day of a window of `days` days ending today. */
const sinceDay = (days: number): string => localDay(Date.now() - (Math.max(1, days) - 1) * DAY_MS);

/** Adds to today's usage. Negative or non-numeric amounts count as 0. Never throws: counting must not break a call. */
export function recordVoiceUsage(userId: string, d: { seconds?: number; turns?: number; replyChars?: number }): void {
  const s = count(d?.seconds), t = count(d?.turns), c = count(d?.replyChars);
  if (!s && !t && !c) return;
  try {
    db.prepare(`INSERT INTO voice_usage (user_id, day, call_seconds, turns, reply_chars) VALUES (?,?,?,?,?)
ON CONFLICT(user_id, day) DO UPDATE SET call_seconds = call_seconds + excluded.call_seconds, turns = turns + excluded.turns, reply_chars = reply_chars + excluded.reply_chars`)
      .run(userId, localDay(Date.now()), s, t, c);
  } catch { /* usage is best effort */ }
}

export function voiceUsageToday(userId: string): VoiceUsageTotals {
  const t = emptyVoiceUsage();
  const r = db.prepare("SELECT call_seconds, turns, reply_chars FROM voice_usage WHERE user_id = ? AND day = ?").get(userId, localDay(Date.now()));
  if (r) add(t, r);
  return t;
}

/** The user's days in the last `days` days (today included), newest first. Days without usage are left out. */
export function voiceUsageDays(userId: string, days = 30): VoiceUsageDay[] {
  const rows = db.prepare("SELECT day, call_seconds, turns, reply_chars FROM voice_usage WHERE user_id = ? AND day >= ? ORDER BY day DESC")
    .all(userId, sinceDay(days)) as any[];
  return rows.map((r) => { const t = emptyVoiceUsage(); add(t, r); return { day: String(r.day), ...t }; });
}

/** Every user's today and last-`days` totals, for the admin views. */
export function voiceUsageByUser(days = 30): Map<string, { today: VoiceUsageTotals; period: VoiceUsageTotals }> {
  const today = localDay(Date.now());
  const out = new Map<string, { today: VoiceUsageTotals; period: VoiceUsageTotals }>();
  const rows = db.prepare("SELECT user_id, day, call_seconds, turns, reply_chars FROM voice_usage WHERE day >= ?").all(sinceDay(days)) as any[];
  for (const r of rows) {
    let e = out.get(r.user_id);
    if (!e) { e = { today: emptyVoiceUsage(), period: emptyVoiceUsage() }; out.set(r.user_id, e); }
    add(e.period, r);
    if (r.day === today) add(e.today, r);
  }
  return out;
}

/** The daily call-time limit in minutes that applies to the user: their own override when set, else the common one. 0 = unlimited. */
export function voiceQuotaMinutes(userId: string): number {
  const own = readUserDailyMinutes()[userId];
  return own !== undefined ? own : readVoiceConfig().dailyLimitMinutes;
}

/** True when a limit is set and today's call time has reached it. A new call is then refused (4429 quota). */
export function voiceQuotaExceeded(userId: string): boolean {
  const m = voiceQuotaMinutes(userId);
  return m > 0 && voiceUsageToday(userId).callSeconds >= m * 60;
}
