import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTheme, readConfig, DEFAULT_THEME } from "../src/config";
import { buildSettingsState, parseSettingsMessage, THEME_OPTIONS } from "../src/ui/settingsModel";
import { stringsFor } from "../src/ui/strings";
import { SKIN_STYLES, skinStyles, type SkinView } from "../src/ui/skins";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WEBVIEW = ROOT + "media/webview/";
const read = (rel: string): string => readFileSync(ROOT + rel, "utf8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  contributes: {
    configuration: {
      properties: Record<
        string,
        { enum?: string[]; enumDescriptions?: string[]; enumItemLabels?: string[]; default?: unknown }
      >;
    };
  };
};

const PREFIX = ':root[data-oc-theme="frontier"]';
const SKIN_FILES = readdirSync(WEBVIEW).filter((f) => /^skin-frontier.*\.css$/.test(f)).sort();
const VIEWS: SkinView[] = ["chat", "settings", "activity"];

/** CSS with comments removed. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Index just after the `}` that closes the `{` at `open`. */
function blockEnd(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return css.length;
}

/** Removes every @keyframes block (their from/to steps are not selectors). */
function removeKeyframes(css: string): string {
  let out = css;
  for (let m = /@keyframes\b[^{]*\{/.exec(out); m; m = /@keyframes\b[^{]*\{/.exec(out)) {
    const start = m.index;
    const end = blockEnd(out, start + m[0].length - 1);
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/** The body of the first `@media (prefers-reduced-motion: reduce)` block, or "" if none. */
function reducedMotionBlock(css: string): string {
  const m = /@media[^{]*prefers-reduced-motion:\s*reduce[^{]*\{/.exec(css);
  if (!m) return "";
  return css.slice(m.index + m[0].length, blockEnd(css, m.index + m[0].length - 1) - 1);
}

/** Every rule prelude (selector list) outside at-rule preludes, after keyframes are removed. */
function selectorLists(css: string): string[] {
  const preludes: string[] = [];
  for (const m of removeKeyframes(css).matchAll(/([^{};]+)\{/g)) {
    const prelude = m[1].trim();
    if (!prelude.startsWith("@")) preludes.push(prelude);
  }
  return preludes;
}

/** Splits a selector list on commas that are outside parentheses, so `:is(a, b)` stays whole. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function skinCss(file: string): string {
  return stripComments(readFileSync(WEBVIEW + file, "utf8"));
}

describe("skin sheets exist", () => {
  it("finds at least one media/webview/skin-frontier*.css file", () => {
    expect(SKIN_FILES.length, "no media/webview/skin-frontier*.css files exist yet").toBeGreaterThan(0);
  });

  it("every file listed in SKIN_STYLES exists under media/webview", () => {
    const listed = [...SKIN_STYLES.shared, ...SKIN_STYLES.chat, ...SKIN_STYLES.settings];
    for (const name of listed) {
      expect(existsSync(WEBVIEW + name), `missing ${name}`).toBe(true);
    }
  });

  it("every skin file on disk is wired into at least one view", () => {
    const wired = new Set(VIEWS.flatMap((v) => skinStyles(v)));
    for (const f of SKIN_FILES) expect(wired.has(f), `${f} is not in skinStyles()`).toBe(true);
  });

  it("the shared skin sheet is loaded by all three views", () => {
    for (const v of VIEWS) {
      for (const name of SKIN_STYLES.shared) expect(skinStyles(v)).toContain(name);
    }
  });

  it("the chat view loads the chat skin, and the activity panel does not", () => {
    for (const name of SKIN_STYLES.chat) expect(skinStyles("chat")).toContain(name);
    for (const name of SKIN_STYLES.chat) expect(skinStyles("activity")).not.toContain(name);
  });
});

describe("theme config", () => {
  it("defaults to frontier", () => {
    expect(DEFAULT_THEME).toBe("frontier");
    expect(parseTheme(undefined)).toBe("frontier");
  });

  it("maps unknown and non-string values to frontier", () => {
    expect(parseTheme("neon")).toBe("frontier");
    expect(parseTheme("")).toBe("frontier");
    expect(parseTheme(42)).toBe("frontier");
    expect(parseTheme(null)).toBe("frontier");
    expect(parseTheme({ theme: "simple" })).toBe("frontier");
  });

  it("keeps simple and astral", () => {
    expect(parseTheme("simple")).toBe("simple");
    expect(parseTheme("astral")).toBe("astral");
    expect(parseTheme("frontier")).toBe("frontier");
  });

  it("readConfig with an empty config gives frontier", () => {
    expect(readConfig(() => undefined).theme).toBe("frontier");
  });
});

describe("theme picker", () => {
  it("lists frontier, simple, astral in that order", () => {
    expect(THEME_OPTIONS(stringsFor("en")).map((o) => o.id)).toEqual(["frontier", "simple", "astral"]);
    expect(THEME_OPTIONS(stringsFor("ja")).map((o) => o.id)).toEqual(["frontier", "simple", "astral"]);
  });

  it("has English and Japanese labels", () => {
    expect(THEME_OPTIONS(stringsFor("en")).map((o) => o.label)).toEqual(["Frontier", "Simple", "Astral"]);
    expect(THEME_OPTIONS(stringsFor("ja")).map((o) => o.label)).toEqual(["フロンティア", "シンプル", "アストラル"]);
  });

  it("is included in the settings state, with the selected theme kept", () => {
    const state = buildSettingsState({
      lang: "en",
      version: "0.2.6",
      paired: false,
      status: "unpaired",
      trusted: true,
      values: { serverUrl: "", deviceName: "", theme: "simple", decorations: "auto", autoSave: true, shell: "" },
    });
    expect(state.theme).toBe("simple");
    expect(state.themeOptions.map((o) => o.id)).toEqual(["frontier", "simple", "astral"]);
  });

  it("parseSettingsMessage accepts each theme and rejects unknown ones", () => {
    for (const id of ["frontier", "simple", "astral"]) {
      expect(parseSettingsMessage({ type: "set", key: "theme", value: id })).toEqual({ type: "set", key: "theme", value: id });
    }
    expect(parseSettingsMessage({ type: "set", key: "theme", value: "neon" })).toEqual({ type: "invalid", key: "theme" });
    expect(parseSettingsMessage({ type: "set", key: "theme", value: 1 })).toEqual({ type: "invalid", key: "theme" });
  });
});

describe("package.json theme setting", () => {
  const theme = pkg.contributes.configuration.properties["omnichat.theme"];

  it("enumerates exactly simple, frontier, astral with frontier as default", () => {
    expect(theme.enum).toEqual(["simple", "frontier", "astral"]);
    expect(theme.default).toBe("frontier");
  });

  it("has three enum descriptions and labels", () => {
    expect(theme.enumDescriptions).toHaveLength(3);
    expect(theme.enumItemLabels).toEqual(["Simple", "Frontier", "Astral"]);
  });

  it("has version 0.2.6, matching the top CHANGELOG heading", () => {
    expect(pkg.version).toBe("0.2.6");
    const top = /^## (\S+)/m.exec(read("CHANGELOG.md"));
    expect(top?.[1]).toBe(pkg.version);
  });
});

describe("skin CSS guards", () => {
  it.each(SKIN_FILES.length ? SKIN_FILES : ["(no skin files)"])("%s", (file) => {
    expect(SKIN_FILES.length, "no skin files to check").toBeGreaterThan(0);
    const css = skinCss(file);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    for (const list of selectorLists(css)) {
      for (const sel of splitTopLevel(list)) {
        expect(sel.trim().startsWith(PREFIX), `selector not gated: ${sel.trim()}`).toBe(true);
      }
    }
    expect(css).not.toMatch(/\binfinite\b/);
    if (/@keyframes|animation/.test(css)) {
      expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
      expect(reducedMotionBlock(css)).toMatch(/animation(-name)?\s*:\s*none/);
    }
  });

  it("every skin file has the reduced-motion and forced-colors blocks", () => {
    for (const file of SKIN_FILES) {
      const css = skinCss(file);
      expect(css, file).toMatch(/prefers-reduced-motion: reduce/);
      expect(css, file).toMatch(/forced-colors: active/);
    }
  });

  it("the skin set gates decorations and narrow views", () => {
    const all = SKIN_FILES.map(skinCss).join("\n");
    expect(all).toContain('body[data-oc-decor="on"]');
    expect(all).toContain("body[data-oc-narrow]");
  });
});
