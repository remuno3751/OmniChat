import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// check-contrast.mjs has no declaration file (tsconfig has no allowJs); same as gen-tokens.mjs in tokens.test.ts.
// @ts-ignore
import { KNOWN_FAILURES, MODES, TOKENS_PATH, checkContrast, composite, contrastRatio, parseColor } from "../scripts/check-contrast.mjs";

type Row = { theme: string; mode: string; fg: string; bg: string; ratio: number; min: number; label: string };

const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

// Every --oc-* name the checker reads, filled with one colour (a flat theme).
const TOKEN_NAMES = [
  "bg", "panel", "panel2", "input", "text", "sub", "accent", "accent-text", "accent-ink",
  "danger", "warn", "good", "code", "code-text", "user-bubble", "bot-bubble",
  "border", "border-strong", "diff-add", "diff-del",
];

function flatTokens(colour: string) {
  const vars = Object.fromEntries(TOKEN_NAMES.map((n) => [`--oc-${n}`, colour]));
  return { themes: { flat: { light: vars, dark: vars } } };
}

describe("colour parsing", () => {
  it("reads #rgb, #rrggbb and #rrggbbaa", () => {
    expect(parseColor("#fff")).toEqual(WHITE);
    expect(parseColor("#000000")).toEqual(BLACK);
    expect(parseColor("#ff000080").a).toBeCloseTo(128 / 255, 6);
  });

  it("reads rgb() and rgba() with numeric or percent alpha", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(0,0,0,0.45)").a).toBeCloseTo(0.45, 6);
    expect(parseColor("rgba(0, 0, 0, 50%)").a).toBeCloseTo(0.5, 6);
  });

  it("rejects colours it cannot read instead of skipping them", () => {
    expect(() => parseColor("color-mix(in srgb, red 50%, blue)")).toThrow(/unsupported colour/);
    expect(() => parseColor("var(--x)")).toThrow(/unsupported colour/);
  });

  it("composites alpha over an opaque background", () => {
    const half = composite({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE);
    expect(half.r).toBeCloseTo(127.5, 6);
    expect(half.a).toBe(1);
  });
});

describe("WCAG contrast math", () => {
  it("black on white is 21:1", () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
  });

  it("a colour against itself is 1:1", () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
  });

  it("matches known pairs", () => {
    // #767676 on white is the usual smallest grey that passes AA body text (4.54:1).
    expect(contrastRatio(parseColor("#767676"), WHITE)).toBeCloseTo(4.54, 2);
    // #777777 on white is just under 4.5:1 (4.48:1).
    expect(contrastRatio(parseColor("#777777"), WHITE)).toBeCloseTo(4.48, 2);
  });
});

describe("checkContrast", () => {
  it("passes a black-on-white theme", () => {
    const FG = ["text", "sub", "accent-text", "accent-ink", "danger", "warn", "good", "code-text", "border", "border-strong", "diff-add", "diff-del"];
    const vars = Object.fromEntries(
      TOKEN_NAMES.map((n) => [`--oc-${n}`, FG.includes(n) ? "#000000" : "#ffffff"]),
    );
    const r = checkContrast({ themes: { flat: { light: vars, dark: vars } } });
    expect(r.failures).toEqual([]);
    expect(r.checked).toBe(48);
  });

  it("fails white text on white", () => {
    const r = checkContrast(flatTokens("#ffffff"));
    expect(r.failures.length).toBeGreaterThan(0);
    const textBg = r.failures.find((f: Row) => f.fg === "text" && f.bg === "bg");
    expect(textBg).toMatchObject({ theme: "flat", mode: "light", ratio: 1, min: 4.5 });
  });

  it("returns the ratio and threshold on each failure", () => {
    const r = checkContrast(flatTokens("#777777"));
    for (const f of r.failures) {
      expect(f.ratio).toBeLessThan(f.min);
      expect(MODES).toContain(f.mode);
    }
  });

  it("rejects a theme missing a token", () => {
    const bad = flatTokens("#000000");
    delete (bad.themes.flat.light as Record<string, string>)["--oc-text"];
    expect(() => checkContrast(bad)).toThrow(/missing token --oc-text/);
  });
});

describe("real generated tokens", () => {
  const tokens = JSON.parse(readFileSync(TOKENS_PATH, "utf8"));
  const result = checkContrast(tokens);

  it("has no unexpected contrast failures", () => {
    expect(result.failures).toEqual([]);
  });

  it("checks every theme in both modes", () => {
    expect(result.checked).toBe(144);
  });

  it("only lists known failures that still fail (no stale entries)", () => {
    const knownKeys = result.known.map((k: Row) => `${k.theme}/${k.mode}/${k.fg}/${k.bg}`);
    expect(knownKeys.sort()).toEqual(Object.keys(KNOWN_FAILURES).sort());
  });
});
