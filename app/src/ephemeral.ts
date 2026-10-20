/**
 * Pure helpers for ephemeral chats (no react-native / AsyncStorage / api imports: runs under node --test).
 * See docs/EPHEMERAL.md and docs/PROTOCOL-v7-ephemeral.md.
 */

export const EPH_PREFIX = 'eph_';
/** Max live ephemeral chats per user (server enforces it too). */
export const EPH_MAX_LIVE = 5;

export function isEphemeralId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(EPH_PREFIX);
}

export function newEphemeralId(gen: () => string): string {
  return EPH_PREFIX + gen();
}

/** A conversation row is ephemeral when its id has the prefix or it carries the flag. */
export function isEphemeralRow(row: { id?: string; ephemeral?: boolean } | null | undefined): boolean {
  return !!row && (isEphemeralId(row.id) || row.ephemeral === true);
}

/** Host part of a base URL (with or without scheme/port/path), lower-cased, brackets and trailing dot removed. */
function hostOf(baseUrl: string): string | null {
  let s = (baseUrl ?? '').trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const end = s.search(/[\/?#]/);
  let auth = end >= 0 ? s.slice(0, end) : s;
  const at = auth.lastIndexOf('@');
  if (at >= 0) auth = auth.slice(at + 1);
  let host: string;
  if (auth.startsWith('[')) {
    const close = auth.indexOf(']');
    if (close < 0) return null;
    host = auth.slice(1, close);
  } else {
    const parts = auth.split(':');
    host = parts.length === 2 ? parts[0] : auth;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  return host || null;
}

function ipv4Octets(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function isLocalIPv4(o: number[]): boolean {
  const [a, b] = o;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function isLocalIPv6(h: string): boolean {
  const addr = h.split('%')[0];
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) {
    const o = ipv4Octets(mapped[1]);
    return !!o && isLocalIPv4(o);
  }
  const first = addr.split(':')[0];
  // fc00::/7 (unique local) and fe80::/10 (link-local)
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true;
  if (/^fe[89ab][0-9a-f]?$/.test(first)) return true;
  return false;
}

function isLocalHost(h: string): boolean {
  if (h.includes(':')) return isLocalIPv6(h);
  const o = ipv4Octets(h);
  if (o) return isLocalIPv4(o);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (!h.includes('.')) return true; // single-label name: a LAN/host alias
  return /\.(local|lan|internal)$/.test(h);
}

/**
 * True when the provider's host is NOT loopback / LAN (so the chat text may leave the local network).
 * Unparsable input counts as remote (the safe side for the warning).
 */
export function isRemoteProviderUrl(baseUrl: string): boolean {
  const h = hostOf(baseUrl);
  if (!h) return true;
  return !isLocalHost(h);
}

/** True when the value is an ephemeral conversation (prefix or flag). */
export function ephemeralConvIds(conversations: Record<string, { id?: string; ephemeral?: boolean }>): string[] {
  return Object.keys(conversations).filter((k) => isEphemeralRow(conversations[k]) || isEphemeralId(k));
}

/**
 * Copy of `conversations` / `messages` without the ephemeral entries.
 * With `ids`: removes only those conversation ids (and their buckets); without: removes all ephemeral ones.
 * Message buckets are keyed by conversation id.
 */
export function dropEphemeralFrom<C extends { id?: string; ephemeral?: boolean }, M>(
  conversations: Record<string, C>,
  messages: Record<string, Record<string, M>>,
  ids?: Set<string>,
): { conversations: Record<string, C>; messages: Record<string, Record<string, M>> } {
  const drop = (k: string) => (ids ? ids.has(k) : isEphemeralRow(conversations[k]) || isEphemeralId(k));
  const outConvs: Record<string, C> = {};
  for (const k of Object.keys(conversations)) if (!drop(k)) outConvs[k] = conversations[k];
  const outMsgs: Record<string, Record<string, M>> = {};
  for (const k of Object.keys(messages)) {
    const hit = ids ? ids.has(k) : isEphemeralId(k) || isEphemeralRow(conversations[k]);
    if (!hit) outMsgs[k] = messages[k];
  }
  return { conversations: outConvs, messages: outMsgs };
}

/**
 * For persistence: a copy of the state without ephemeral conversations and their message buckets.
 * The input is not mutated.
 */
export function stripEphemeral<T extends { conversations: Record<string, any>; messages: Record<string, any> }>(s: T): T {
  const r = dropEphemeralFrom(s.conversations, s.messages);
  return { ...s, conversations: r.conversations, messages: r.messages };
}
