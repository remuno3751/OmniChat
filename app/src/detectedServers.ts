import type { LocalServer } from './protocol';

// Pure helpers for auto-detected local servers. No React Native imports, so node tests can load this file.

/** Canonical form of a base URL for comparison: trimmed, no trailing slashes, lowercase. */
export function normalizeUrl(u: string): string {
  return u.trim().replace(/[/]+$/, '').toLowerCase();
}

/** Servers not already configured as providers, deduplicated by normalized baseUrl (first wins). */
export function visibleServers(found: LocalServer[], providers: { baseUrl: string }[]): LocalServer[] {
  const known = new Set<string>();
  if (Array.isArray(providers)) {
    for (const p of providers) {
      if (typeof p?.baseUrl === 'string') known.add(normalizeUrl(p.baseUrl));
    }
  }
  const seen = new Set<string>();
  const out: LocalServer[] = [];
  if (!Array.isArray(found)) return out;
  for (const s of found) {
    if (typeof s?.baseUrl !== 'string') continue;
    const key = normalizeUrl(s.baseUrl);
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Model to pre-select when adding a detected server: first non-embedding/non-rerank model, else first, else 'default'. */
export function pickAddModel(s: LocalServer): string {
  const ids = Array.isArray(s?.modelIds) ? s.modelIds.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  const chat = ids.find((m) => !/embed|rerank/i.test(m));
  return chat ?? ids[0] ?? 'default';
}
