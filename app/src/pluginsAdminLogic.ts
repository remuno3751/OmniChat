// Pure helpers for the admin plugin screen (no React Native imports, so node:test can load them).
import type { PluginSeverity } from './apiPlugins';

export const SEVERITY_ORDER: PluginSeverity[] = ['high', 'medium', 'info'];

/** Permissions the server knows; anything else is shown as the raw string. */
export const KNOWN_PERMISSIONS = ['shell', 'filesystem-read', 'filesystem-write', 'network'] as const;

export type RepoParse = { ok: true; repo: string } | { ok: false; reason: 'empty' | 'bad' };

/**
 * Accepts `owner/name`, `github.com/owner/name`, `https://github.com/owner/name`, with an optional `.git`
 * suffix and trailing slashes. Any other host is rejected (the server rejects it too).
 */
export function normalizeRepo(input: string): RepoParse {
  let s = (input || '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  s = s.replace(/^https:\/\/(www\.)?github\.com\//i, '').replace(/^(www\.)?github\.com\//i, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { ok: false, reason: 'bad' };
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return { ok: false, reason: 'bad' };
  if (s.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, reason: 'bad' };
  return { ok: true, repo: s };
}

/** Optional text field: empty or whitespace becomes undefined. */
export function optionalText(input: string): string | undefined {
  const s = (input || '').trim();
  return s ? s : undefined;
}

/**
 * Optional subfolder inside the repo. Returns '' when empty, null when it is unsafe (contains `..` or is absolute).
 */
export function normalizeSubdir(input: string): string | null {
  const s = (input || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s) return '';
  if (s.split('/').some((seg) => seg === '..')) return null;
  return s;
}

/** Stable sort: high first, then medium, then info. Unknown severities go last. */
export function sortFindings<T extends { severity: string }>(findings: T[]): T[] {
  const rank = (s: string) => {
    const i = SEVERITY_ORDER.indexOf(s as PluginSeverity);
    return i < 0 ? SEVERITY_ORDER.length : i;
  };
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f.severity) - rank(b.f.severity) || a.i - b.i)
    .map((x) => x.f);
}

/** Groups findings by severity; unknown severities count as info. */
export function groupFindings<T extends { severity: string }>(findings: T[]): Record<PluginSeverity, T[]> {
  const out: Record<PluginSeverity, T[]> = { high: [], medium: [], info: [] };
  for (const f of findings) {
    const key: PluginSeverity = (SEVERITY_ORDER as string[]).includes(f.severity) ? (f.severity as PluginSeverity) : 'info';
    out[key].push(f);
  }
  return out;
}

/** Counts findings per severity (for the scan summary). */
export function countFindings(findings: { severity: string }[]): Record<PluginSeverity, number> {
  const g = groupFindings(findings);
  return { high: g.high.length, medium: g.medium.length, info: g.info.length };
}

/** The Install button stays disabled until the typed id equals the plugin id exactly. */
export function confirmMatches(pluginId: string, typed: string): boolean {
  return !!pluginId && typed === pluginId;
}

/** True when a check-update diff has no file, tool or permission changes. */
export function diffIsEmpty(d: { added: string[]; removed: string[]; changed: string[]; toolsAdded: string[]; toolsRemoved: string[]; permissionsAdded: unknown[] }): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.toolsAdded.length && !d.toolsRemoved.length && !d.permissionsAdded.length;
}

export function shortSha(sha?: string | null): string {
  return sha ? sha.slice(0, 7) : '';
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
