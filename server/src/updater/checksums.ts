// SHA-256 helpers for release assets. Accepts sha256sum-style lists and per-asset .sha256 files.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { UpdateErr } from "./github.js";

const HEX64 = /^[0-9a-f]{64}$/;
// "<hex>  <name>" (text mode) or "<hex> *<name>" (binary mode, sha256sum -b).
const SUM_LINE = /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/;

/** Parses a SHA256SUMS listing into a map of asset name -> lowercase hex. Invalid lines are skipped. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = SUM_LINE.exec(line);
    if (!m) continue;
    const name = m[2].trim().replace(/^\.\//, "");
    out.set(name, m[1].toLowerCase());
  }
  return out;
}

/**
 * Finds the expected checksum for an asset. The combined SHA256SUMS text wins;
 * otherwise a per-asset file (`<hex>` or `<hex>  <name>`) is used. Returns null when neither has it.
 */
export function sumFor(name: string, sumsText: string | null, perAssetText: string | null): string | null {
  if (sumsText) {
    const hex = parseSums(sumsText).get(name);
    if (hex) return hex;
  }
  if (perAssetText) {
    const tokens = perAssetText.trim().split(/\s+/);
    const hex = (tokens[0] ?? "").toLowerCase();
    if (!HEX64.test(hex)) return null;
    if (tokens.length === 1) return hex;
    const named = tokens.slice(1).join(" ").replace(/^\*/, "");
    return basename(named) === name ? hex : null;
  }
  return null;
}

/** Streams a file through SHA-256 and resolves with the lowercase hex digest. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Throws UpdateErr("checksum-mismatch") unless the file hashes to expectedHex. */
export async function verifySha256(path: string, expectedHex: string): Promise<void> {
  const want = expectedHex.trim().toLowerCase();
  if (!HEX64.test(want)) {
    throw new UpdateErr("checksum-mismatch", "expected checksum is not a valid sha256 value");
  }
  const got = await sha256File(path);
  if (got !== want) {
    throw new UpdateErr(
      "checksum-mismatch",
      `sha256 mismatch for ${basename(path)}: expected ${want}, got ${got}`,
    );
  }
}
