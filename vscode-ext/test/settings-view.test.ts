import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WEBVIEW = fileURLToPath(new URL("../media/webview/", import.meta.url));

/** CSS without comments, so colours and URLs in the header prose are not counted. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("settings.css", () => {
  const css = readFileSync(WEBVIEW + "settings.css", "utf8");
  const code = stripComments(css);

  it("exists and is wired into the Settings view", () => {
    expect(existsSync(WEBVIEW + "settings.css")).toBe(true);
    const view = readFileSync(fileURLToPath(new URL("../src/ui/settingsView.ts", import.meta.url)), "utf8");
    expect(view).toContain('styles: ["settings.css"]');
  });

  it("loads no remote resources and no @import", () => {
    expect(code).not.toMatch(/https?:/i);
    expect(code).not.toMatch(/@import/i);
    expect(code).not.toMatch(/url\(/i);
  });

  it("uses no literal colours (only --oc-* tokens and system colour keywords)", () => {
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/i);
  });

  it("honours reduced motion and hides [hidden] elements", () => {
    expect(code).toContain("prefers-reduced-motion: reduce");
    expect(code).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
});

describe("settings.js", () => {
  const js = readFileSync(WEBVIEW + "settings.js", "utf8");

  it("does not write HTML or inline styles", () => {
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(js).not.toMatch(/\.style\./);
  });

  it("uses only the existing message protocol", () => {
    for (const t of ["ready", "set", "pair", "unpair", "openLog"]) {
      expect(js).toContain(`type: "${t}"`);
    }
  });
});
