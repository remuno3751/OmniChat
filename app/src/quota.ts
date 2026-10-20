// Usage quotas for shared providers (docs/PROTOCOL-v7-quotas.md). Pure helpers and types for the usage card and the admin form.
// The HTTP calls are in apiAdmin.ts (adminApi.quotas*, getQuotaStatus).

/** GET /quota: the caller's own usage. limit null = unlimited. */
export interface QuotaWindow { used: number; limit: number | null; resetsAt: string }
export interface QuotaStatus { enabled: boolean; applies: boolean; daily: QuotaWindow; monthly: QuotaWindow }

/** GET/PUT /admin/quotas: the server defaults. 0 = unlimited. */
export interface QuotaSettings { enabled: boolean; dailyTokens: number; monthlyTokens: number }

/** A per-user override. null = follow the default; 0 = unlimited for this user. */
export interface UserQuota { dailyTokens: number | null; monthlyTokens: number | null }

/** One row of GET /admin/quotas/users. */
export interface AdminQuotaUser {
  userId: string;
  username: string;
  isAdmin: boolean;
  override: UserQuota | null;
  limits: { daily: number | null; monthly: number | null };
  usedToday: number;
  usedThisMonth: number;
}

export const QUOTA_MAX = 1_000_000_000_000;

/** The usage card is shown for users the quota applies to (ordinary users with a shared provider). */
export function showUsageCard(s: Pick<QuotaStatus, 'applies'> | null | undefined): boolean {
  return !!s && s.applies === true;
}

/** Share of the limit used, 0..1 (capped), or null when the window is unlimited. */
export function usageRatio(used: number, limit: number | null): number | null {
  if (limit === null || !(limit > 0)) return null;
  const r = used / limit;
  if (!Number.isFinite(r) || r < 0) return 0;
  return Math.min(1, r);
}

/** True once the used amount has reached a limit (the next turn is refused). */
export function isExhausted(used: number, limit: number | null): boolean {
  return limit !== null && limit > 0 && used >= limit;
}

/** 12345 -> "12,345". Non-finite or negative values print as 0. */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Parses a limit typed in a form. Blank: null when `blankIsDefault` (an override that follows the default), else invalid.
 * Digits only, at most QUOTA_MAX. Returns 'invalid' for anything else.
 */
export function parseLimitInput(text: string, blankIsDefault: boolean): number | null | 'invalid' {
  const s = text.trim();
  if (s === '') return blankIsDefault ? null : 'invalid';
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n > QUOTA_MAX) return 'invalid';
  return n;
}

/** The reset time as a short local string (the browser's locale), or '' when the value is not a date. */
export function formatResetAt(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Whether the admin override draft changed compared with the saved override (null = none). */
export function overrideChanged(saved: UserQuota | null, draft: UserQuota): boolean {
  const a = saved ?? { dailyTokens: null, monthlyTokens: null };
  return a.dailyTokens !== draft.dailyTokens || a.monthlyTokens !== draft.monthlyTokens;
}
