import { isIP } from "node:net";

export type Route = "loopback" | "lan" | "vpn" | "external";

function v4(parts: number[]): Route {
  const [a, b] = parts;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "lan";
  if (a === 100 && b >= 64 && b <= 127) return "vpn"; // Tailscale CGNAT 100.64.0.0/10
  return "external";
}

/** Classifies a peer address (IPv4, IPv6, IPv4-mapped IPv6). Unparseable / missing -> "external". */
export function classifyAddress(addr: string | undefined | null): Route {
  let a = String(addr ?? "").trim();
  if (!a) return "external";
  if (a.startsWith("[") && a.includes("]")) a = a.slice(1, a.indexOf("]"));
  a = a.replace(/%.*$/, ""); // zone id
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  const kind = isIP(a);
  if (kind === 4) return v4(a.split(".").map(Number));
  if (kind === 6) {
    const l = a.toLowerCase();
    if (l === "::1") return "loopback";
    if (l.startsWith("fd7a:115c:a1e0:")) return "vpn"; // Tailscale IPv6 ULA range
    const first = parseInt(l.split(":")[0] || "0", 16);
    if ((first & 0xffc0) === 0xfe80) return "lan"; // fe80::/10
    if ((first & 0xfe00) === 0xfc00) return "lan"; // fc00::/7
    return "external";
  }
  return "external";
}

/** The first hop of X-Forwarded-For (string or string[] header). */
export function firstForwarded(h: string | string[] | undefined): string | undefined {
  const v = Array.isArray(h) ? h[0] : h;
  const first = v?.split(",")[0]?.trim();
  return first || undefined;
}

/** True when the request carries proxy / Tailscale forwarding headers (X-Forwarded-*, Forwarded, X-Real-IP, Via, Tailscale-*). */
export function hasForwardingHeaders(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some((k) => {
    const l = k.toLowerCase();
    return l.startsWith("x-forwarded-") || l === "forwarded" || l === "x-real-ip" || l === "via" || l.startsWith("tailscale-");
  });
}

/**
 * Route of a request: the socket peer, or with trustProxy the first X-Forwarded-For entry (falling back to the peer).
 * A loopback peer that sits behind a proxy (`proxied`: forwarding headers present) is never "loopback": a remote user
 * reaching us through e.g. Tailscale Funnel must not look like the server machine. A forwarded address that claims
 * to be loopback is likewise "external".
 */
export function classifyRoute(peer: string | undefined, forwardedFor: string | string[] | undefined, trustProxy: boolean, proxied = false): Route {
  const peerRoute = classifyAddress(peer);
  if (trustProxy) {
    const f = firstForwarded(forwardedFor);
    if (f) { const r = classifyAddress(f); return r === "loopback" ? "external" : r; }
  }
  return peerRoute === "loopback" && (proxied || firstForwarded(forwardedFor)) ? "external" : peerRoute;
}
