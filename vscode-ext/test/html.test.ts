import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCsp, buildWebviewHtml, FONT_FACES, fontFaceCss, makeNonce, type WebviewHtmlOptions } from "../src/ui/html";

const WEBVIEW_DIR = fileURLToPath(new URL("../media/webview/", import.meta.url));
const CSP_SOURCE = "https://webview.test";
const NONCE = "abc123";

const fontUri = (name: string) => `${CSP_SOURCE}/fonts/${name}`;

function render(over: Partial<WebviewHtmlOptions> = {}): string {
  return buildWebviewHtml({
    title: "OmniChat",
    nonce: NONCE,
    cspSource: CSP_SOURCE,
    theme: "frontier",
    decorations: "auto",
    scriptUri: `${CSP_SOURCE}/webview/chat.js`,
    styleUris: [`${CSP_SOURCE}/webview/base.css`, `${CSP_SOURCE}/generated/tokens.css`],
    body: '<div class="oc-page"></div>',
    fontUri,
    ...over,
  });
}

describe("CSP", () => {
  it("builds the strict policy with the nonce and cspSource", () => {
    expect(buildCsp(NONCE, CSP_SOURCE)).toBe(
      `default-src 'none'; style-src ${CSP_SOURCE} 'nonce-${NONCE}'; ` +
        `script-src 'nonce-${NONCE}'; font-src ${CSP_SOURCE}; img-src ${CSP_SOURCE} data:; base-uri 'none'`,
    );
  });

  it("is in the document meta tag and never allows unsafe-inline or remote hosts", () => {
    const html = render();
    const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    expect(meta).not.toBeNull();
    const csp = meta![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/https?:\/\/(?!webview\.test)/);
  });

  it("puts the same nonce on the inline style and the script", () => {
    const html = render();
    expect(html).toContain(`<style nonce="${NONCE}">`);
    expect(html).toContain(`<script nonce="${NONCE}" src="${CSP_SOURCE}/webview/chat.js">`);
  });
});

describe("makeNonce", () => {
  it("returns distinct 128-bit hex values", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => makeNonce()));
    expect(nonces.size).toBe(200);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("theme and decorations attributes", () => {
  it.each(["simple", "frontier", "astral"] as const)("sets data-oc-theme=%s on html and body", (theme) => {
    const html = render({ theme });
    expect(html).toContain(`<html lang="en" data-oc-theme="${theme}"`);
    expect(html).toContain(`<body data-oc-theme="${theme}"`);
  });

  it("starts decorations on unless the setting is off", () => {
    expect(render({ decorations: "auto" })).toContain('data-oc-decor="on"');
    expect(render({ decorations: "on" })).toContain('data-oc-decor="on"');
    expect(render({ decorations: "off" })).toContain('data-oc-decor="off"');
    expect(render({ decorations: "off" })).toContain('data-oc-decor-setting="off"');
  });

  it("escapes the title", () => {
    expect(render({ title: "<b>&x</b>" })).toContain("<title>&lt;b&gt;&amp;x&lt;/b&gt;</title>");
  });
});

describe("@font-face per theme", () => {
  it("loads Frontier fonts only for frontier", () => {
    const html = render({ theme: "frontier" });
    expect(html).toContain('font-family:"SpaceGrotesk_400Regular"');
    expect(html).toContain('font-family:"Syncopate_400Regular"');
    expect(html).toContain(`url("${CSP_SOURCE}/fonts/SpaceGrotesk-Regular.woff2")`);
    expect(html).not.toContain("ZenMaru");
    expect(html).not.toContain("Marcellus");
  });

  it("loads Astral fonts only when astral", () => {
    const html = render({ theme: "astral" });
    expect(html).toContain('font-family:"ZenMaruGothic_400Regular"');
    expect(html).toContain('font-family:"Outfit_400Regular"');
    expect(html).toContain('font-family:"Marcellus_400Regular"');
    expect(html).not.toContain("SpaceGrotesk");
    expect(html).not.toContain("Syncopate");
  });

  it("declares no font faces for simple", () => {
    const html = render({ theme: "simple" });
    expect(html).not.toContain("@font-face");
    expect(html).toContain("<style nonce=");
  });

  it("uses fontUri for every referenced file", () => {
    const seen: string[] = [];
    render({
      theme: "astral",
      fontUri: (name) => {
        seen.push(name);
        return `${CSP_SOURCE}/fonts/${name}`;
      },
    });
    expect(seen.sort()).toEqual([
      "Marcellus-Regular.woff2",
      "Outfit-Regular.woff2",
      "Outfit-SemiBold.woff2",
      "ZenMaruGothic-Bold.woff2",
      "ZenMaruGothic-Latin-Bold.woff2",
      "ZenMaruGothic-Latin-Regular.woff2",
      "ZenMaruGothic-Regular.woff2",
    ]);
  });

  /** family -> sorted weights declared in the document. */
  function weightsOf(html: string): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const m of html.matchAll(/@font-face\{font-family:"([^"]+)";font-style:normal;font-weight:(\d+);/g)) {
      (out[m[1]] ??= []).push(Number(m[2]));
    }
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort((a, b) => a - b);
    return out;
  }

  it("registers every weight the app uses (Frontier)", () => {
    expect(weightsOf(render({ theme: "frontier" }))).toEqual({
      SpaceGrotesk_400Regular: [400, 500, 700],
      Syncopate_400Regular: [400, 700],
    });
  });

  it("registers every weight the app uses (Astral)", () => {
    expect(weightsOf(render({ theme: "astral" }))).toEqual({
      ZenMaruGothic_400Regular: [400, 700],
      Outfit_400Regular: [400, 600],
      Marcellus_400Regular: [400],
    });
  });

  it("only sends Latin to the small Zen Maru Latin files, declared after the Japanese ones", () => {
    const css = fontFaceCss("astral", fontUri);
    const faces = css.split(String.fromCharCode(10));
    const latin = faces.filter((f) => f.includes("ZenMaruGothic-Latin"));
    expect(latin).toHaveLength(2);
    for (const f of latin) expect(f).toContain("unicode-range:U+0000-00FF");
    const lastJp = Math.max(...faces.map((f, i) => (f.includes("ZenMaruGothic-Regular") || f.includes("ZenMaruGothic-Bold") ? i : -1)));
    const firstLatin = Math.min(...faces.map((f, i) => (f.includes("ZenMaruGothic-Latin") ? i : 99)));
    expect(firstLatin).toBeGreaterThan(lastJp);
  });

  it("ships a woff2 file for every declared face", () => {
    for (const faces of Object.values(FONT_FACES)) {
      for (const face of faces) {
        expect(existsSync(join(fileURLToPath(new URL("../media/fonts/", import.meta.url)), face.file)), face.file).toBe(true);
      }
    }
  });
});

describe("stylesheets and body", () => {
  it("links stylesheets in order and places the body markup", () => {
    const html = render({ body: '<main id="app"></main>' });
    const base = html.indexOf(`href="${CSP_SOURCE}/webview/base.css"`);
    const tokens = html.indexOf(`href="${CSP_SOURCE}/generated/tokens.css"`);
    expect(base).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(base);
    expect(html).toContain('<main id="app"></main>');
  });
});

describe("webview CSS rules", () => {
  const cssFiles = readdirSync(WEBVIEW_DIR).filter((f) => f.endsWith(".css"));
  const css = cssFiles.map((f) => ({ name: f, text: readFileSync(WEBVIEW_DIR + f, "utf8") }));

  it("finds the webview stylesheets", () => {
    expect(cssFiles).toContain("base.css");
  });

  it("never uses backdrop-filter", () => {
    for (const file of css) {
      expect(file.text, file.name).not.toMatch(/backdrop-filter/i);
    }
  });

  it("never uses --oc-accent as a text colour", () => {
    const misuse = /(?<![-\w])color\s*:\s*var\(\s*--oc-accent\s*\)/;
    for (const file of css) {
      expect(file.text, file.name).not.toMatch(misuse);
    }
    // The detector itself must catch the misuse it is meant to catch.
    expect("  color: var(--oc-accent);").toMatch(misuse);
    expect("  color: var( --oc-accent );").toMatch(misuse);
    expect("  background-color: var(--oc-accent);").not.toMatch(misuse);
    expect("  color: var(--oc-accent-ink);").not.toMatch(misuse);
  });
});
