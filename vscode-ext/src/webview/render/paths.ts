/**
 * Conservative file-path detector for inline code and tool summaries. Pure (no DOM), unit-tested.
 * A false negative only costs a click; a false positive would turn ordinary words into links, so the rules are strict.
 */
export interface PathRef {
  path: string;
  line?: number;
}

const MAX_LEN = 260;
const KNOWN_EXT = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx css scss less html htm vue svelte py rs go java kt cs c cc cpp h hpp " +
    "rb php sh bash ps1 bat cmd yml yaml toml ini env txt xml svg sql lock gradle swift dart lua"
  ).split(" "),
);
/** "Node.js" and friends look like file names but are product names. */
const PRODUCT_NAMES = new Set(["node.js", "next.js", "vue.js", "react.js", "express.js", "d3.js", "three.js", "nuxt.js", "ember.js", "backbone.js"]);

const SEGMENT = /^[\w.@+~()[\]-]+$/;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

function hasLetterExt(name: string): boolean {
  const ext = extOf(name);
  return /^[a-z][a-z0-9]{0,9}$/.test(ext);
}

/** Returns the path (and optional line) when `text` is, as a whole, a file path; otherwise null. */
export function detectPath(text: string): PathRef | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (s === "" || s.length > MAX_LEN || /\s/.test(s)) return null;

  let line: number | undefined;
  const m = /^(.*?):(\d{1,6})(?::\d{1,6})?$/.exec(s);
  if (m && m[1] !== "" && !/^[A-Za-z]$/.test(m[1])) {
    s = m[1];
    line = Number(m[2]);
    if (line < 1) return null;
  }

  // URLs, mailto:, vscode: and the like (a single letter before ':' is a Windows drive).
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(s) || s.includes("://") || /^www\./i.test(s)) return null;
  if (/[<>"|?*]/.test(s) || s.includes("//") || /\\\\/.test(s)) return null;

  const win = /^[A-Za-z]:[\\/]/.test(s);
  const body = win ? s.slice(3) : s;
  const segments = body.split(/[\\/]/);
  const absolute = win || s.startsWith("/");
  const parts = absolute && !win ? segments.slice(1) : segments;
  if (parts.length === 0 || parts.some((p) => p === "" || (!SEGMENT.test(p)))) return null;
  const last = parts[parts.length - 1];
  if (last === "." || last === "..") return null;

  if (parts.length === 1 && !absolute) {
    // A bare name: only a known extension with a letter-led name (no versions like 1.2.3, no "e.g").
    if (!KNOWN_EXT.has(extOf(last)) || PRODUCT_NAMES.has(last.toLowerCase()) || /^\d/.test(last)) return null;
    return line === undefined ? { path: s } : { path: s, line };
  }
  if (parts.length === 1 && absolute && !win) {
    if (!hasLetterExt(last)) return null;
  } else if (!hasLetterExt(last) && !s.startsWith("./") && !s.startsWith("../") && !win) {
    // "a/b" with no extension is too often prose ("and/or", "read/write"); allow only dotted file names.
    return null;
  }
  if (/^\d+(\.\d+)+$/.test(last)) return null;
  return line === undefined ? { path: s } : { path: s, line };
}
