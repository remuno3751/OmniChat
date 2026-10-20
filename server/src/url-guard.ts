// Outbound URL guard: user-supplied provider/notification URLs may point at LAN or loopback servers (local LLMs are
// the point of this app) but never at link-local / cloud-metadata addresses.

const BLOCKED_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

/** Returns a reason string when the URL must not be used for server-side requests, otherwise null. */
export function forbiddenOutboundUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "invalid URL"; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs are allowed";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) return "metadata hosts are not allowed";
  // IPv6: link-local fe80::/10, AWS metadata fd00:ec2::254, and IPv4-mapped forms of the IPv4 ranges below
  if (host.includes(":")) {
    if (/^fe[89ab][0-9a-f]:/.test(host) || host === "fd00:ec2::254") return "link-local addresses are not allowed";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return forbiddenIpv4(mapped[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) {
      const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
      return forbiddenIpv4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return null;
  }
  // WHATWG URL already normalises decimal/hex/octal IPv4 forms to dotted quads
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return forbiddenIpv4(host);
  return null;
}

function forbiddenIpv4(ip: string): string | null {
  const [a, b] = ip.split(".").map(Number);
  if (a === 169 && b === 254) return "link-local addresses are not allowed";
  if (a === 0) return "0.0.0.0/8 is not allowed";
  return null;
}
