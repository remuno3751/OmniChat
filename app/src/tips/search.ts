// Pure search helpers for the Tips sheet (no React, no RN imports; runs under node --import tsx --test).
import type { ResolvedTip } from './types';

/** NFKC, lowercase, katakana -> hiragana, whitespace collapsed and trimmed. */
export function normalizeText(s: string): string {
  let out = '';
  for (const ch of String(s ?? '').normalize('NFKC').toLowerCase()) {
    const cp = ch.codePointAt(0) ?? 0;
    // Katakana small/full letters U+30A1..U+30F6 -> hiragana U+3041..U+3096.
    out += cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function queryTerms(query: string): string[] {
  const q = normalizeText(query);
  return q ? q.split(' ') : [];
}

/**
 * Entries whose title/body/example/keywords contain every query term (AND, substring, normalized).
 * Empty query returns `entries` unchanged. Ranking: all terms in title, then in title+keywords, then the rest;
 * otherwise the original order is kept.
 */
export function searchTips(entries: ResolvedTip[], query: string): ResolvedTip[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return entries;
  const hits: { tip: ResolvedTip; tier: number; index: number }[] = [];
  entries.forEach((tip, index) => {
    const title = normalizeText(tip.title);
    const withKeywords = normalizeText(`${tip.title} ${tip.keywords}`);
    const all = normalizeText([tip.title, tip.body, tip.example ?? '', tip.keywords].join(' '));
    if (!terms.every((t) => all.includes(t))) return;
    const tier = terms.every((t) => title.includes(t)) ? 0 : terms.every((t) => withKeywords.includes(t)) ? 1 : 2;
    hits.push({ tip, tier, index });
  });
  hits.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return hits.map((h) => h.tip);
}

/**
 * Splits `text` into parts; parts with hit=true cover the query matches (normalized, so case, width and
 * katakana/hiragana differences are ignored). Concatenating the parts always gives back `text`.
 */
export function highlightParts(text: string, query: string): { text: string; hit: boolean }[] {
  const whole = [{ text, hit: false }];
  try {
    const terms = queryTerms(query);
    if (terms.length === 0 || text === '') return whole;

    // Fold the original text code point by code point, remembering where each folded char came from.
    let folded = '';
    const starts: number[] = [];
    const ends: number[] = [];
    let idx = 0;
    for (const ch of text) {
      const n = normalizeText(ch) || (/\s/.test(ch) ? ' ' : '');
      for (let k = 0; k < n.length; k++) {
        folded += n[k];
        starts.push(idx);
        ends.push(idx + ch.length);
      }
      idx += ch.length;
    }

    // Collect match ranges in original-text offsets.
    const ranges: [number, number][] = [];
    for (const term of terms) {
      let from = 0;
      for (;;) {
        const at = folded.indexOf(term, from);
        if (at < 0) break;
        ranges.push([starts[at], ends[at + term.length - 1]]);
        from = at + term.length;
      }
    }
    if (ranges.length === 0) return whole;

    // Merge overlapping ranges, then slice the original text.
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    const parts: { text: string; hit: boolean }[] = [];
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) parts.push({ text: text.slice(pos, s), hit: false });
      parts.push({ text: text.slice(s, e), hit: true });
      pos = e;
    }
    if (pos < text.length) parts.push({ text: text.slice(pos), hit: false });
    return parts;
  } catch {
    return whole;
  }
}

/** Tip of the day: index = days since epoch of the LOCAL date, modulo the list length. Null for an empty list. */
export function tipOfTheDay(entries: ResolvedTip[], now: Date): ResolvedTip | null {
  if (entries.length === 0) return null;
  const utcDay = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  const n = entries.length;
  return entries[((utcDay % n) + n) % n];
}

/** Newest first by ISO date ('YYYY-MM-DD'), stable for equal dates, at most n items. */
export function latestWhatsNew<T extends { date: string }>(items: T[], n = 5): T[] {
  return [...items]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, Math.max(0, n));
}
