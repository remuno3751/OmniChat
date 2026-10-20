import type { ContextUsage } from './protocol';

const limitKey = (providerId: string, model: string) => `${providerId}::${model}`;

/** Last limit seen per provider+model: shown while a fresh number is still on its way (a chat that was just created has no server value yet). */
const lastLimit = new Map<string, number>();
export function rememberLimit(providerId: string | null, model: string | null, u: ContextUsage): ContextUsage {
  if (!providerId || !model) return u;
  const k = limitKey(providerId, model);
  if (u.limit) { lastLimit.set(k, u.limit); return u; }
  const prev = lastLimit.get(k);
  if (!prev) return u;
  return { ...u, limit: prev, limitSource: 'backend', fits: u.total + u.reserve <= prev };
}
