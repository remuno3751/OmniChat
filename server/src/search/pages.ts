/* Safe page reading for search results: SSRF-guarded GET (every hop re-validated, connection pinned to the validated IP, size and time limits), readable text and candidate image extraction. */

import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export interface FetchLimits { timeoutMs: number; maxBytes: number; maxRedirects: number; allowPrivate: boolean; signal?: AbortSignal }
export const DEFAULT_PAGE_LIMITS: FetchLimits = { timeoutMs: 8000, maxBytes: 1_500_000, maxRedirects: 3, allowPrivate: false };

const IMAGE_MAX_BYTES = 5_000_000;
const USER_AGENT = "Mozilla/5.0 (compatible; OmniChat)";
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif;q=0.9";
const DEFAULT_TEXT_CHARS = 6000;
const MAX_IMAGES = 12;
const MIN_CONTENT_CHARS = 200;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface PageImage { url: string; alt: string; width?: number; height?: number }
export interface PageText { url: string; title: string; text: string; images: PageImage[]; truncated: boolean }
export interface FetchedImage { url: string; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; bytes: number; base64: string }

// ---------- address checks ----------

function parseV4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p: [number, number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return p.every((x) => x <= 255) ? p : null;
}

function privateV4(v4: [number, number, number, number]): boolean {
  const [a, b, c, d] = v4;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local and cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (Tailscale)
    (a === 100 && b === 100 && c === 100 && d === 200) || // Alibaba metadata
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Parses an IPv6 literal (with optional embedded dotted IPv4) into 8 groups; null if malformed. */
function parseV6(input: string): number[] | null {
  let s = input;
  let tail: number[] = [];
  if (s.includes(".")) {
    const i = s.lastIndexOf(":");
    const v = parseV4(s.slice(i + 1));
    if (!v) return null;
    tail = [(v[0] << 8) | v[1], (v[2] << 8) | v[3]];
    s = s.slice(0, i + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head.some(Number.isNaN) || rest.some(Number.isNaN)) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  if (tail.length) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

/** Pure. True for any address that must not be reached from a fetched page. Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  let s = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = parseV4(s);
  if (v4) return privateV4(v4);
  const g = parseV6(s);
  if (!g) return true;
  const embeddedV4 = (): [number, number, number, number] => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
  // IPv4-mapped (::ffff:a.b.c.d, ::ffff:7f00:1) and IPv4-compatible (::a.b.c.d) forms
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embeddedV4());
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embeddedV4()); // NAT64 well-known prefix
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

async function resolveAll(host: string): Promise<{ address: string; family: number }[]> {
  const literal = isIP(host);
  if (literal) return [{ address: host, family: literal }];
  return dnsLookup(host, { all: true });
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, "");
}

/** Throws UnsafeUrlError for non-http(s), credentials, or private resolved addresses (unless allowPrivate). */
export async function assertPublicUrl(url: string, limits: Partial<FetchLimits> = {}): Promise<URL> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UnsafeUrlError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UnsafeUrlError(`unsupported scheme: ${u.protocol}`);
  if (u.username || u.password) throw new UnsafeUrlError("URL must not contain credentials");
  if (limits.allowPrivate) return u;
  const host = bareHost(u);
  if (!host) throw new UnsafeUrlError("missing host");
  const addrs = await resolveAll(host);
  if (addrs.length === 0) throw new UnsafeUrlError(`no address for ${host}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new UnsafeUrlError(`${host} resolves to a non-public address`);
  }
  return u;
}

// ---------- transport ----------

function limitsOf(o: Partial<FetchLimits> | undefined, base: FetchLimits = DEFAULT_PAGE_LIMITS): FetchLimits {
  return {
    timeoutMs: o?.timeoutMs ?? base.timeoutMs,
    maxBytes: o?.maxBytes ?? base.maxBytes,
    maxRedirects: o?.maxRedirects ?? base.maxRedirects,
    allowPrivate: o?.allowPrivate ?? base.allowPrivate,
    signal: o?.signal,
  };
}

/** Resolves the host once more, rejects if any address is private, and returns the address to connect to. */
async function pinAddress(u: URL, limits: FetchLimits): Promise<{ address: string; family: number }> {
  const addrs = await resolveAll(bareHost(u));
  if (addrs.length === 0) throw new Error(`no address for ${bareHost(u)}`);
  if (!limits.allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError(`${bareHost(u)} resolves to a non-public address`);
  }
  return addrs[0];
}

function requestPinned(u: URL, pin: { address: string; family: number }, accept: string, signal: AbortSignal): Promise<IncomingMessage> {
  const host = bareHost(u);
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  // custom lookup: the connection can only reach the address that was just validated (defeats DNS rebinding)
  const lookup = (_host: string, options: unknown, callback: unknown) => {
    const done = (typeof options === "function" ? options : callback) as (...a: unknown[]) => void;
    const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    if (wantAll) done(null, [{ address: pin.address, family: pin.family }]);
    else done(null, pin.address, pin.family);
  };
  return new Promise((resolve, reject) => {
    const req = send(
      {
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: {
          Host: u.host,
          "User-Agent": USER_AGENT,
          Accept: accept,
          "Accept-Encoding": "gzip, deflate, br",
        },
        servername: isIP(host) ? undefined : host,
        lookup,
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

class TooLarge extends Error {}

async function readBody(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const enc = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  let raw = 0;
  // cap compressed bytes as they arrive
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      raw += chunk.length;
      if (raw > maxBytes) return cb(new TooLarge(`response exceeds ${maxBytes} bytes`));
      cb(null, chunk);
    },
  });
  const chunks: Buffer[] = [];
  let total = 0;
  // cap decoded bytes too (decompression bombs)
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxBytes) return cb(new TooLarge(`response exceeds ${maxBytes} bytes`));
      chunks.push(chunk);
      cb();
    },
  });
  if (enc === "gzip" || enc === "x-gzip") await pipeline(res, counter, createGunzip(), sink, { signal });
  else if (enc === "br") await pipeline(res, counter, createBrotliDecompress(), sink, { signal });
  else if (enc === "deflate") await pipeline(res, counter, createInflate(), sink, { signal });
  else await pipeline(res, counter, sink, { signal });
  return Buffer.concat(chunks);
}

/** GET with manual, re-validated redirects, pinned connection, and total timeout / size limits. */
export async function safeFetch(
  url: string,
  opts: Partial<FetchLimits> & { accept?: string; validate?: (url: string) => Promise<URL> } = {},
): Promise<{ finalUrl: string; status: number; contentType: string; body: Buffer }> {
  const limits = limitsOf(opts);
  const validate = opts.validate ?? ((u: string) => assertPublicUrl(u, limits));
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, limits.timeoutMs);
  const onExternal = () => ac.abort();
  if (limits.signal) {
    if (limits.signal.aborted) ac.abort();
    else limits.signal.addEventListener("abort", onExternal, { once: true });
  }
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      const u = await validate(current);
      const pin = await pinAddress(u, limits);
      const res = await requestPinned(u, pin, opts.accept ?? HTML_ACCEPT, ac.signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (hop >= limits.maxRedirects) throw new Error("too many redirects");
        try {
          current = new URL(location, u).href;
        } catch {
          throw new Error("bad redirect location");
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        throw new Error(`HTTP ${status}`);
      }
      const body = await readBody(res, limits.maxBytes, ac.signal);
      return { finalUrl: u.href, status, contentType: String(res.headers["content-type"] ?? ""), body };
    }
  } catch (e) {
    if (timedOut) throw new Error(`timeout after ${limits.timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", onExternal);
  }
}

// ---------- HTML decoding and extraction ----------

const NAMED_ENTITIES = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["ndash", "–"], ["mdash", "—"], ["hellip", "…"], ["lsquo", "‘"], ["rsquo", "’"],
  ["ldquo", "“"], ["rdquo", "”"], ["laquo", "«"], ["raquo", "»"], ["copy", "©"],
  ["reg", "®"], ["trade", "™"], ["middot", "·"], ["bull", "•"], ["times", "×"],
  ["eacute", "é"], ["egrave", "è"], ["agrave", "à"], ["auml", "ä"], ["ouml", "ö"],
  ["uuml", "ü"], ["szlig", "ß"], ["ccedil", "ç"], ["ntilde", "ñ"],
]);

function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
    }
    return NAMED_ENTITIES.get(e) ?? NAMED_ENTITIES.get(e.toLowerCase()) ?? all;
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function decodeWith(label: string, body: Buffer): string {
  try {
    return new TextDecoder(label.trim().toLowerCase()).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function decodeHtml(body: Buffer, contentType: string): string {
  let charset = /charset\s*=\s*["']?([^";'\s]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 4096).toString("latin1");
    charset = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1];
  }
  return decodeWith(charset ?? "utf-8", body);
}

const NOISE_TAGS = ["script", "style", "noscript", "svg", "iframe", "form", "nav", "header", "footer", "aside", "template", "object", "head"];
const NOISE_RE = new RegExp(`<(${NOISE_TAGS.join("|")})(?=[\\s>/])[^>]*?(?:\\/>|>[\\s\\S]*?(?:<\\/\\1\\s*>|$))`, "gi");

function stripNoise(html: string): string {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(NOISE_RE, " ");
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const DENSE_TAGS = new Set(["div", "section", "td"]);
const SEMANTIC_TAGS = new Set(["article", "main"]);

interface Box { name: string; start: number; end: number; text: number; link: number; semantic: boolean }

/** One linear pass: every candidate element with its character span and visible / link text lengths. */
function findBoxes(html: string): Box[] {
  const boxes: Box[] = [];
  const stack: Box[] = [];
  let linkDepth = 0;
  const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(html))) {
    const tok = m[0];
    if (m[2] === undefined) {
      const len = tok.trim().length;
      if (!len || tok.startsWith("<!--")) continue;
      for (const b of stack) {
        b.text += len;
        if (linkDepth) b.link += len;
      }
      continue;
    }
    const name = m[2].toLowerCase();
    if (m[1] === "/") {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name !== name) continue;
        while (stack.length > i) {
          const b = stack.pop()!;
          b.end = m.index + tok.length;
          if (b.name === "a") linkDepth--;
        }
        break;
      }
      continue;
    }
    if (VOID_TAGS.has(name) || /\/\s*$/.test(m[3])) continue;
    const semantic = SEMANTIC_TAGS.has(name) || /role\s*=\s*["']?main\b/i.test(m[3]);
    const box: Box = { name, start: m.index, end: html.length, text: 0, link: 0, semantic };
    stack.push(box);
    if (name === "a") linkDepth++;
    if (semantic || DENSE_TAGS.has(name)) boxes.push(box);
  }
  return boxes;
}

/** Prefers the longest article/main/role=main; else the densest div/section/td; else the whole document. */
function pickContainer(html: string): { start: number; end: number } {
  let semantic: Box | undefined;
  let dense: Box | undefined;
  for (const b of findBoxes(html)) {
    if (b.semantic) {
      if (b.text >= MIN_CONTENT_CHARS && (!semantic || b.text > semantic.text)) semantic = b;
    } else if (b.text - b.link >= MIN_CONTENT_CHARS && (!dense || b.text - b.link > dense.text - dense.link)) {
      dense = b;
    }
  }
  return semantic ?? dense ?? { start: 0, end: html.length };
}

const BLOCK_TAG_RE = /<\/?(?:p|div|h[1-6]|li|tr|td|th|section|article|blockquote|pre|ul|ol|table|dl|dt|dd|figure|figcaption|main|header|footer|address|hr)\b[^>]*>/gi;

/** Fragment HTML to readable text: blocks become paragraph breaks, inline tags vanish, entities decoded. */
function toText(fragment: string): string {
  const withBreaks = fragment.replace(/<br\b[^>]*>/gi, "\n").replace(BLOCK_TAG_RE, "\n").replace(/<[^>]*>/g, "");
  return decodeEntities(withBreaks)
    .split("\n")
    .map(collapse)
    .filter((l) => l.length > 0)
    .join("\n\n");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

function num(s: string | undefined): number | undefined {
  const n = parseInt(s ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const OG_IMAGE_KEYS = /^(og:image|og:image:url|og:image:secure_url|twitter:image)$/i;
const NOISE_IMAGE = /logo|icon|sprite|avatar|pixel|banner/i;

function imageFrom(src: string | undefined, alt: string, width: number | undefined, height: number | undefined, baseUrl: string): PageImage | null {
  const s = (src ?? "").trim();
  if (!s || /^data:/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s, baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/\.svg$/i.test(u.pathname)) return null;
  if ((width !== undefined && width < 100) || (height !== undefined && height < 100)) return null;
  if (NOISE_IMAGE.test(u.pathname + u.search)) return null;
  const out: PageImage = { url: u.href, alt: collapse(alt).slice(0, 200) };
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  return out;
}

function collectImages(html: string, region: string, baseUrl: string): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();
  const add = (img: PageImage | null) => {
    if (img && !seen.has(img.url) && out.length < MAX_IMAGES) {
      seen.add(img.url);
      out.push(img);
    }
  };
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = attr(m[0], "property") ?? attr(m[0], "name");
    if (key && OG_IMAGE_KEYS.test(key)) add(imageFrom(attr(m[0], "content"), "", undefined, undefined, baseUrl));
  }
  for (const m of region.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, "src") ?? attr(tag, "data-src") ?? attr(tag, "data-original") ?? attr(tag, "data-lazy-src");
    add(imageFrom(src, attr(tag, "alt") ?? "", num(attr(tag, "width")), num(attr(tag, "height")), baseUrl));
  }
  return out;
}

/** Pure. Title, main readable text (paragraph breaks kept) and candidate content images. */
export function extractReadable(html: string, baseUrl: string): { title: string; text: string; images: PageImage[] } {
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  let title = collapse(decodeEntities(rawTitle ?? ""));
  if (!title) {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      if (attr(m[0], "property") === "og:title") title = collapse(attr(m[0], "content") ?? "");
      if (title) break;
    }
  }
  const stripped = stripNoise(html);
  const box = pickContainer(stripped);
  const region = stripped.slice(box.start, box.end);
  return { title, text: toText(region), images: collectImages(html, region, baseUrl) };
}

// ---------- page and image fetchers ----------

/** Fetches an HTML page and returns its readable text (capped at maxChars), title and candidate images. */
export async function fetchPageText(url: string, opts: Partial<FetchLimits> & { maxChars?: number } = {}): Promise<PageText> {
  const { maxChars = DEFAULT_TEXT_CHARS, ...limits } = opts;
  const res = await safeFetch(url, { ...limits, accept: HTML_ACCEPT });
  const mime = res.contentType.split(";")[0].trim().toLowerCase();
  if (mime !== "text/html" && mime !== "application/xhtml+xml") throw new Error(`unsupported content type: ${mime || "(none)"}`);
  const doc = extractReadable(decodeHtml(res.body, res.contentType), res.finalUrl);
  const truncated = doc.text.length > maxChars;
  return {
    url: res.finalUrl,
    title: doc.title,
    text: truncated ? doc.text.slice(0, maxChars) : doc.text,
    images: doc.images,
    truncated,
  };
}

function sniffImage(b: Buffer): FetchedImage["mime"] | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6) {
    const sig = b.toString("latin1", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** Fetches a raster image; the type is decided by magic bytes, never by Content-Type. SVG, HTML and anything else is rejected. */
export async function fetchImage(url: string, opts: Partial<FetchLimits> = {}): Promise<FetchedImage> {
  const res = await safeFetch(url, { ...opts, maxBytes: opts.maxBytes ?? IMAGE_MAX_BYTES, accept: IMAGE_ACCEPT });
  const mime = sniffImage(res.body);
  if (!mime) throw new Error(`unsupported image data (declared ${res.contentType || "unknown"})`);
  return { url: res.finalUrl, mime, bytes: res.body.length, base64: res.body.toString("base64") };
}
