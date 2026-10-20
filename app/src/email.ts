export interface ParsedEmail { to: string; cc: string; bcc: string; subject: string; body: string; hasHeaders: boolean }

type HeaderKey = 'to' | 'cc' | 'bcc' | 'subject';

const HEADER_RE = /^(To|Cc|Bcc|Subject|宛先|件名)[ \t]*[:：][ \t]*(.*)$/i;

function keyOf(label: string): HeaderKey {
  if (label === '宛先') return 'to';
  if (label === '件名') return 'subject';
  return label.toLowerCase() as HeaderKey;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const utf8 = new TextEncoder();

/** Base64 without Buffer or btoa, so it runs in React Native and on the web. */
function base64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

/** Replaces lone surrogates so encodeURIComponent and TextEncoder never fail. */
function clean(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0xd800 && cp <= 0xdfff ? '�' : ch;
  }
  return out;
}

/** Single-line header value. */
function oneLine(s: string): string {
  return clean(s).replace(/\r\n|\r|\n/g, ' ').trim();
}

/** Body newlines as CRLF. */
function crlf(s: string): string {
  return s.replace(/\r\n|\r|\n/g, '\r\n');
}

export function parseEmail(content: string): ParsedEmail {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const h: Record<HeaderKey, string> = { to: '', cc: '', bcc: '', subject: '' };
  let headers = false;
  let last: HeaderKey | null = null;
  let bodyStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      // A blank line ends the header block (and a block must start on line 1 to count).
      bodyStart = i + 1;
      break;
    }
    const m = HEADER_RE.exec(line);
    if (m) {
      headers = true;
      last = keyOf(m[1]);
      const v = m[2].trim();
      if (last === 'subject') {
        if (!h.subject) h.subject = v;
      } else {
        h[last] = h[last] ? h[last] + ', ' + v : v;
      }
      continue;
    }
    if (headers && last && /^[ \t]/.test(line)) {
      // Continuation of the previous header (RFC 5322 unfolding).
      const v = line.trim();
      h[last] = h[last] ? h[last] + ' ' + v : v;
      continue;
    }
    bodyStart = i;
    break;
  }
  if (!headers) {
    return { to: '', cc: '', bcc: '', subject: '', body: content, hasHeaders: false };
  }
  return {
    to: h.to,
    cc: h.cc,
    bcc: h.bcc,
    subject: h.subject,
    body: lines.slice(bodyStart).join('\n'),
    hasHeaders: true,
  };
}

export function serializeEmail(e: ParsedEmail): string {
  const lines: string[] = [];
  if (e.to) lines.push('To: ' + oneLine(e.to));
  if (e.cc) lines.push('Cc: ' + oneLine(e.cc));
  if (e.bcc) lines.push('Bcc: ' + oneLine(e.bcc));
  if (e.subject) lines.push('Subject: ' + oneLine(e.subject));
  if (lines.length === 0) return e.body;
  return lines.join('\n') + '\n\n' + e.body;
}

/** The mailto: URL, with the body shortened at a code-point boundary when it would exceed maxLen. */
export function buildMailto(e: ParsedEmail, maxLen = 1800): { url: string; truncated: boolean } {
  const enc = encodeURIComponent;
  const to = oneLine(e.to);
  const cc = oneLine(e.cc);
  const bcc = oneLine(e.bcc);
  const subject = oneLine(e.subject);
  const body = crlf(clean(e.body));

  const make = (part: string): string => {
    const params: string[] = [];
    if (cc) params.push('cc=' + enc(cc));
    if (bcc) params.push('bcc=' + enc(bcc));
    if (subject) params.push('subject=' + enc(subject));
    if (part) params.push('body=' + enc(part));
    return 'mailto:' + enc(to) + (params.length ? '?' + params.join('&') : '');
  };

  const full = make(body);
  if (!body || full.length <= maxLen) return { url: full, truncated: false };

  const cps = Array.from(body);
  let lo = 0;
  let hi = cps.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (make(cps.slice(0, mid).join('')).length <= maxLen) lo = mid;
    else hi = mid - 1;
  }
  return { url: make(cps.slice(0, lo).join('')), truncated: true };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rfc5322Date(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/** RFC 2047 encoded words (UTF-8, base64). Each word stays within 75 characters. */
function encodedWordSubject(s: string): string {
  const MAX_BYTES = 45; // 45 bytes -> 60 base64 chars -> 72 chars with the 12-char wrapper
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of s) {
    const n = utf8.encode(ch).length;
    if (curBytes + n > MAX_BYTES) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur || chunks.length === 0) chunks.push(cur);
  return chunks.map((c) => '=?UTF-8?B?' + base64(utf8.encode(c)) + '?=').join('\r\n ');
}

/** A .eml (RFC 5322) text with a base64 UTF-8 body. CRLF line endings. */
export function buildEml(e: ParsedEmail, now: Date = new Date()): string {
  const subject = oneLine(e.subject);
  const subjectValue = /^[\x20-\x7e]*$/.test(subject) ? subject : encodedWordSubject(subject);
  const lines: string[] = ['Date: ' + rfc5322Date(now)];
  const to = oneLine(e.to);
  const cc = oneLine(e.cc);
  const bcc = oneLine(e.bcc);
  if (to) lines.push('To: ' + to);
  if (cc) lines.push('Cc: ' + cc);
  if (bcc) lines.push('Bcc: ' + bcc);
  lines.push('Subject: ' + subjectValue);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('X-Unsent: 1');
  const wrapped = base64(utf8.encode(crlf(clean(e.body)))).match(/.{1,76}/g) ?? [];
  return lines.join('\r\n') + '\r\n\r\n' + wrapped.map((l) => l + '\r\n').join('');
}

const PLACEHOLDER_RE = /\[(?:要確認|TODO|CHECK)[:：][^\]\r\n]*\]/gi;

/** Bracketed review markers in the body, e.g. "[要確認: 金額]" or "[TODO: date]". */
export function emailPlaceholders(body: string): string[] {
  return body.match(PLACEHOLDER_RE) ?? [];
}

export function emailAll(e: ParsedEmail): string {
  return serializeEmail(e);
}
