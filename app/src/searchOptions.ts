import type { SearchMode, SearchOptions } from './protocol';

/** Defaults mirror the server (server/src). */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  searchModel: null,
  maxSites: 10,
  maxSearches: 3,
  allowDomains: [],
  denyDomains: [],
  readPages: true,
  readImages: false,
  maxImages: 3,
  visionModel: 'answer',
  guard: 'standard',
  allowPrivateUrls: false,
};

/** The old "auto" mode is gone; a stored or sent "auto" means "smart". Unknown values fall back to smart. */
export function normalizeSearchMode(v: unknown): SearchMode {
  if (v === 'off' || v === 'always' || v === 'smart') return v;
  if (v === 'auto') return 'smart';
  return 'smart';
}

/** Same as normalizeSearchMode for a nullable value (null/undefined stay null = inherit). */
export function normalizeSearchModeOrNull(v: unknown): SearchMode | null {
  return v == null ? null : normalizeSearchMode(v);
}

/** Clamp an integer into [min, max]; non-numbers give the fallback. */
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** One domain per line (or comma separated): trimmed, lower-cased, empty lines and duplicates removed. */
export function parseDomainList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\r\n,]+/)) {
    const d = raw.trim().toLowerCase();
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Inverse of parseDomainList for a text field. */
export function formatDomainList(list: string[] | null | undefined): string {
  return (list || []).join('\n');
}

/** Merge a possibly partial/absent server object over the defaults. */
export function resolveSearchOptions(s: Partial<SearchOptions> | null | undefined): SearchOptions {
  const d = DEFAULT_SEARCH_OPTIONS;
  return {
    searchModel: s?.searchModel ?? d.searchModel,
    maxSites: clampInt(s?.maxSites, 1, 30, d.maxSites),
    maxSearches: clampInt(s?.maxSearches, 1, 10, d.maxSearches),
    allowDomains: Array.isArray(s?.allowDomains) ? s!.allowDomains! : d.allowDomains,
    denyDomains: Array.isArray(s?.denyDomains) ? s!.denyDomains! : d.denyDomains,
    readPages: s?.readPages ?? d.readPages,
    readImages: s?.readImages ?? d.readImages,
    maxImages: clampInt(s?.maxImages, 1, 10, d.maxImages),
    visionModel: s?.visionModel === 'search' ? 'search' : d.visionModel,
    guard: s?.guard === 'off' || s?.guard === 'strict' || s?.guard === 'standard' ? s.guard : d.guard,
    allowPrivateUrls: s?.allowPrivateUrls ?? d.allowPrivateUrls,
  };
}

/** Text shown for a guard-blocked excerpt: capped at 200 chars with an ellipsis. */
export function truncateExcerpt(text: string, max = 200): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Source label for a guard-blocked item: title, else the URL host, else the raw URL. */
export function guardSourceLabel(item: { url: string; title?: string }): string {
  if (item.title && item.title.trim()) return item.title.trim();
  try { return new URL(item.url).host || item.url; } catch { return item.url; }
}
