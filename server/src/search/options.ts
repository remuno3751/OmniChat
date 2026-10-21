/* Per-user web search options (stored inside the settings JSON as `search`). Pure: no DB access. */

export type SearchGuardLevel = "off" | "standard" | "strict";
export const GUARD_LEVELS: readonly SearchGuardLevel[] = ["off", "standard", "strict"];

export interface SearchOptions {
  /** "<providerId>::<model>" that plans searches / reads pages / describes images / judges injections; null = the answer model does it */
  searchModel: string | null;
  /** sites (search results + pages) one answer may use, de-duplicated by URL (1..30) */
  maxSites: number;
  /** search calls one answer may make (1..10) */
  maxSearches: number;
  /** only these domains (and their subdomains) are used; empty = every site */
  allowDomains: string[];
  /** these domains (and their subdomains) are never used */
  denyDomains: string[];
  /** fetch the pages behind the results and give the model their text */
  readPages: boolean;
  /** also fetch images found on those pages and let a vision model look at them */
  readImages: boolean;
  /** images per answer (1..10) */
  maxImages: number;
  /** which model looks at the images: the answer model, or the search model */
  visionModel: "answer" | "search";
  /** prompt-injection guard for everything that comes from the web */
  guard: SearchGuardLevel;
  /** may the server fetch pages on private / LAN addresses (SSRF guard off for them) */
  allowPrivateUrls: boolean;
}

export const SEARCH_SITES_RANGE: [number, number] = [1, 30];
export const SEARCH_CALLS_RANGE: [number, number] = [1, 10];
export const SEARCH_IMAGES_RANGE: [number, number] = [1, 10];

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  searchModel: null,
  maxSites: 10,
  maxSearches: 3,
  allowDomains: [],
  denyDomains: [],
  readPages: true,
  readImages: false,
  maxImages: 3,
  visionModel: "answer",
  guard: "standard",
  allowPrivateUrls: false,
};

const int = (v: unknown, [lo, hi]: [number, number], dflt: number): number =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : dflt;

/** "https://www.Example.com/path" / " *.example.com " -> "example.com"; null when it is not a plausible host name. */
export function normalizeDomain(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/^www\./, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) && s.length <= 253 ? s : null;
}

export function domainList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const d = normalizeDomain(x);
    if (d && !out.includes(d)) out.push(d);
    if (out.length >= 200) break;
  }
  return out;
}

/** Always returns a complete, valid object (unknown / invalid fields fall back to the defaults). */
export function sanitizeSearchOptions(v: unknown): SearchOptions {
  const j = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const d = DEFAULT_SEARCH_OPTIONS;
  const model = typeof j.searchModel === "string" && j.searchModel.includes("::") && j.searchModel.length <= 600 ? j.searchModel : null;
  return {
    searchModel: model,
    maxSites: int(j.maxSites, SEARCH_SITES_RANGE, d.maxSites),
    maxSearches: int(j.maxSearches, SEARCH_CALLS_RANGE, d.maxSearches),
    allowDomains: domainList(j.allowDomains),
    denyDomains: domainList(j.denyDomains),
    readPages: typeof j.readPages === "boolean" ? j.readPages : d.readPages,
    readImages: typeof j.readImages === "boolean" ? j.readImages : d.readImages,
    maxImages: int(j.maxImages, SEARCH_IMAGES_RANGE, d.maxImages),
    visionModel: j.visionModel === "search" ? "search" : "answer",
    guard: (GUARD_LEVELS as readonly unknown[]).includes(j.guard) ? (j.guard as SearchGuardLevel) : d.guard,
    allowPrivateUrls: typeof j.allowPrivateUrls === "boolean" ? j.allowPrivateUrls : d.allowPrivateUrls,
  };
}

/** Does `host` equal `domain` or end with ".domain"? */
export const hostMatches = (host: string, domain: string): boolean => host === domain || host.endsWith("." + domain);

/** Allow/deny decision for one URL. Deny wins; a non-empty allow list admits only its domains. */
export function urlAllowed(url: string, o: Pick<SearchOptions, "allowDomains" | "denyDomains">): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return false; }
  if (o.denyDomains.some((d) => hostMatches(host, d))) return false;
  return !o.allowDomains.length || o.allowDomains.some((d) => hostMatches(host, d));
}
