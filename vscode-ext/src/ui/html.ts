/**
 * Webview HTML document builder (spec docs/design/VSCODE-BRIDGE.md §5, §9, §10).
 * Pure: no `vscode` import. The panel host passes webview URIs in, so this
 * module can be unit-tested in Node.
 */
import { randomBytes } from "node:crypto";
import type { Theme } from "../config";

/** `omnichat.decorations` (spec §5). `auto` is resolved by CSS for narrow views. */
export type DecorationsSetting = "auto" | "on" | "off";

export interface FontFace {
  /** CSS family name; must match the names used in `--oc-font-*` tokens. */
  family: string;
  /** File name under `media/fonts/`, passed to `fontUri()`. */
  file: string;
  /** Real weight of the file. Every weight the app uses is registered, so bold is never synthesised. */
  weight: 400 | 500 | 600 | 700;
  /** Optional `unicode-range` (sends Latin to the small Latin file). */
  range?: string;
}

/** Latin range of the fontsource `latin` subsets. */
const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

/**
 * Fonts per theme, with the same faces the app registers (app/src/fonts.ts):
 * Frontier: Space Grotesk 400/500/700, Syncopate 400/700. Astral: Zen Maru Gothic 400/700,
 * Outfit 400/600, Marcellus 400. Simple loads none. One family per app family with several
 * weights, so `font-weight` picks the real face. Zen Maru is the full Japanese file plus a small
 * Latin file declared last (the last matching face wins inside its unicode-range).
 */
export const FONT_FACES: Readonly<Record<Theme, readonly FontFace[]>> = {
  simple: [],
  frontier: [
    { family: "SpaceGrotesk_400Regular", file: "SpaceGrotesk-Regular.woff2", weight: 400 },
    { family: "SpaceGrotesk_400Regular", file: "SpaceGrotesk-Medium.woff2", weight: 500 },
    { family: "SpaceGrotesk_400Regular", file: "SpaceGrotesk-Bold.woff2", weight: 700 },
    { family: "Syncopate_400Regular", file: "Syncopate-Regular.woff2", weight: 400 },
    { family: "Syncopate_400Regular", file: "Syncopate-Bold.woff2", weight: 700 },
  ],
  astral: [
    { family: "ZenMaruGothic_400Regular", file: "ZenMaruGothic-Regular.woff2", weight: 400 },
    { family: "ZenMaruGothic_400Regular", file: "ZenMaruGothic-Bold.woff2", weight: 700 },
    { family: "ZenMaruGothic_400Regular", file: "ZenMaruGothic-Latin-Regular.woff2", weight: 400, range: LATIN_RANGE },
    { family: "ZenMaruGothic_400Regular", file: "ZenMaruGothic-Latin-Bold.woff2", weight: 700, range: LATIN_RANGE },
    { family: "Outfit_400Regular", file: "Outfit-Regular.woff2", weight: 400 },
    { family: "Outfit_400Regular", file: "Outfit-SemiBold.woff2", weight: 600 },
    { family: "Marcellus_400Regular", file: "Marcellus-Regular.woff2", weight: 400 },
  ],
};

export interface WebviewHtmlOptions {
  /** Fallback document title; escaped. */
  title: string;
  /** Per-render nonce from `makeNonce()`. */
  nonce: string;
  /** `webview.cspSource`. */
  cspSource: string;
  theme: Theme;
  decorations: DecorationsSetting;
  /** Webview URI of the theme-runtime or page script (classic script). */
  scriptUri: string;
  /** Webview URIs of stylesheets, in load order (base.css, tokens.css, ...). */
  styleUris: readonly string[];
  /** Trusted inner HTML of `<body>`. The caller escapes any dynamic text. */
  body: string;
  /** Maps a font file name under media/fonts/ to its webview URI. */
  fontUri: (name: string) => string;
}

/** Escapes text for HTML text and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A fresh 128-bit nonce (hex), unique per call. */
export function makeNonce(): string {
  return randomBytes(16).toString("hex");
}

/** The Content-Security-Policy value for one webview document. */
export function buildCsp(nonce: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${cspSource}`,
    `img-src ${cspSource} data:`,
    "base-uri 'none'",
  ].join("; ");
}

/** `data-oc-decor` value before runtime checks: only `off` turns decorations off. */
export function initialDecor(setting: DecorationsSetting): "on" | "off" {
  return setting === "off" ? "off" : "on";
}

/** Builds @font-face rules for the selected theme only (inside the nonce'd style). */
export function fontFaceCss(theme: Theme, fontUri: (name: string) => string): string {
  return FONT_FACES[theme]
    .map(
      (face) =>
        `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};` +
        `font-display:swap;src:url("${cssUrl(fontUri(face.file))}") format("woff2");` +
        `${face.range ? `unicode-range:${face.range};` : ""}}`,
    )
    .join("\n");
}

/** Keeps a webview URI safe inside a double-quoted CSS url(). */
function cssUrl(uri: string): string {
  return uri.replace(/[\\"\n\r]/g, (ch) => encodeURIComponent(ch));
}

/** Renders the full webview document. */
export function buildWebviewHtml(opts: WebviewHtmlOptions): string {
  const { nonce, cspSource, theme } = opts;
  const decor = initialDecor(opts.decorations);
  const fonts = fontFaceCss(theme, opts.fontUri);
  const links = opts.styleUris
    .map((uri) => `<link rel="stylesheet" href="${escapeHtml(uri)}">`)
    .join("\n  ");

  return [
    "<!DOCTYPE html>",
    '<html lang="en" data-oc-theme="' + theme + '" data-oc-mode="dark">',
    "<head>",
    '  <meta charset="UTF-8">',
    // The policy has no quotes, angle brackets or ampersands, so it needs no escaping.
    `  <meta http-equiv="Content-Security-Policy" content="${buildCsp(nonce, cspSource)}">`,
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${escapeHtml(opts.title)}</title>`,
    `  <style nonce="${nonce}">${fonts}</style>`,
    `  ${links}`,
    "</head>",
    `<body data-oc-theme="${theme}" data-oc-decor="${decor}" data-oc-decor-setting="${opts.decorations}">`,
    opts.body,
    `<script nonce="${nonce}" src="${escapeHtml(opts.scriptUri)}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}
