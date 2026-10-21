/**
 * Pairing codes (spec docs/design/VSCODE-BRIDGE.md §6). Pure: no `vscode` import.
 *
 * A code is base64url JSON `{"s":<serverUrl>,"t":<token>,"n":<name>}`. The same code
 * may also arrive inside `vscode://omnichat.omnichat-vscode/pair?code=...`.
 * Nothing here throws: bad input yields `null` or a failure reason.
 */

export interface Pairing {
  serverUrl: string;
  token: string;
  name: string;
}

export const PAIRING_URI_HOST = "omnichat.omnichat-vscode";
export const PAIRING_URI_PATH = "/pair";

const MAX_CODE_CHARS = 8192;
const MAX_SERVER_URL_CHARS = 2048;
const MAX_TOKEN_CHARS = 512;
const MAX_NAME_CHARS = 64;

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const TOKEN = /^[\x21-\x7e]+$/; // printable ASCII, no spaces
const CONTROL = /[\u0000-\u001f\u007f]/;
const INVISIBLE = /[​-‏⁠﻿­]/g;

export type ServerUrlReason = "server_url" | "http_public";
export type PairReason =
  | "empty"
  | "too_long"
  | "uri"
  | "format"
  | "decode"
  | "shape"
  | ServerUrlReason
  | "credential"
  | "device_name";

export type ServerUrlResult = { ok: true; url: string } | { ok: false; reason: ServerUrlReason };
export type PairResult = { ok: true; pairing: Pairing } | { ok: false; reason: PairReason };

/** True for hosts where plain http is acceptable: loopback, private LAN, link-local, Tailscale, local names. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "") return false;
  if (h.startsWith("[")) return isPrivateIpv6(h.slice(1, -1));
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (!h.includes(".")) return true; // single-label name, for example my-pc or localhost
  return [".localhost", ".local", ".lan", ".home.arpa", ".ts.net", ".internal"].some((suffix) => h.endsWith(suffix));
}

function isPrivateIpv6(addr: string): boolean {
  if (addr === "::1") return true;
  const first = addr.split(":")[0] ?? "";
  if (first === "") return false;
  const n = parseInt(first, 16);
  if (Number.isNaN(n)) return false;
  return (n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80; // ULA fc00::/7, link-local fe80::/10
}

/**
 * Validates a server base URL and returns it normalized (no query, fragment or trailing
 * slash). https is always accepted. http is accepted only for loopback, private LAN,
 * link-local, Tailscale (CGNAT) and local-name hosts; public hosts need https.
 */
export function checkServerUrl(input: unknown): ServerUrlResult {
  try {
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_SERVER_URL_CHARS) {
      return { ok: false, reason: "server_url" };
    }
    const u = new URL(input.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "server_url" };
    if (u.hostname === "" || u.username !== "" || u.password !== "") return { ok: false, reason: "server_url" };
    if (u.protocol === "http:" && !isPrivateHost(u.hostname)) return { ok: false, reason: "http_public" };
    u.search = "";
    u.hash = "";
    return { ok: true, url: u.toString().replace(/\/+$/, "") };
  } catch {
    return { ok: false, reason: "server_url" };
  }
}

/** Like {@link checkServerUrl} but returns just the URL, or `null` when invalid. */
export function normalizeServerUrl(input: unknown): string | null {
  const r = checkServerUrl(input);
  return r.ok ? r.url : null;
}

/** Maps a normalized http(s) server URL to the ws(s) URL the client connects to. `null` if invalid. */
export function toWsUrl(serverUrl: string): string | null {
  const normalized = normalizeServerUrl(serverUrl);
  return normalized === null ? null : normalized.replace(/^http/, "ws");
}

/** Forgiving cleanup of pasted text: invisible chars, surrounding quotes/brackets, line wraps. */
export function cleanPastedCode(input: string): string {
  let t = input.replace(INVISIBLE, "").trim();
  for (let i = 0; i < 3; i++) {
    const m = /^(["'`“‘「<(\[])([\s\S]*?)(["'`”’」>)\]])$/.exec(t);
    if (!m) break;
    t = (m[2] ?? "").trim();
  }
  return t.replace(/[\r\n]+/g, "");
}

/** Parses a pairing code or a `vscode://` pairing URI, reporting why it failed. Never throws. */
export function checkPairing(code: string): PairResult {
  try {
    if (typeof code !== "string") return { ok: false, reason: "format" };
    const raw = cleanPastedCode(code);
    if (raw.length === 0) return { ok: false, reason: "empty" };
    if (raw.length > MAX_CODE_CHARS) return { ok: false, reason: "too_long" };

    let encoded: string = raw;
    if (/^vscode(-insiders)?:/i.test(raw)) {
      const fromUri = fromPairingUri(raw);
      if (fromUri === null) return { ok: false, reason: "uri" };
      encoded = cleanPastedCode(fromUri);
      if (encoded.length === 0) return { ok: false, reason: "uri" };
    }
    return fromEncodedCode(encoded);
  } catch {
    return { ok: false, reason: "decode" };
  }
}

/** Parses a pairing code or a `vscode://` pairing URI. Returns `null` for anything invalid. */
export function parsePairing(code: string): Pairing | null {
  const r = checkPairing(code);
  return r.ok ? r.pairing : null;
}

function fromPairingUri(raw: string): string | null {
  const u = new URL(raw);
  if (!/^vscode(-insiders)?:$/.test(u.protocol) || u.hostname !== PAIRING_URI_HOST || u.pathname !== PAIRING_URI_PATH) {
    return null;
  }
  return u.searchParams.get("code");
}

function fromEncodedCode(encoded: string): PairResult {
  if (!BASE64URL.test(encoded)) return { ok: false, reason: "format" };

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "decode" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, reason: "shape" };
  const fields = json as Record<string, unknown>;

  const server = checkServerUrl(fields.s);
  if (!server.ok) return server;

  const token = fields.t;
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS || !TOKEN.test(token)) {
    return { ok: false, reason: "credential" };
  }

  const name = fields.n;
  if (typeof name !== "string") return { ok: false, reason: "device_name" };
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_CHARS || CONTROL.test(trimmed)) {
    return { ok: false, reason: "device_name" };
  }

  return { ok: true, pairing: { serverUrl: server.url, token, name: trimmed } };
}
