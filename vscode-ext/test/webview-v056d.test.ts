import { describe, expect, it } from "vitest";
import { ARG_COMMANDS, argCommand, MAX_SLASH_ARG } from "../src/webview/chat/slashLogic";
import { cleanQuery, splitSnippet } from "../src/webview/chat/historySearch";
import { effortLabel, EFFORT_CHOICES } from "../src/webview/chat/effortChip";
import { draftOf } from "../src/webview/chat/settingsPanel";
import { v056dEn } from "../src/ui/stringsV056d";

describe("splitSnippet", () => {
  it("splits at the match markers", () => {
    expect(splitSnippet("a \u0001b\u0002 c")).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
      { text: " c", match: false },
    ]);
  });

  it("keeps plain text as one part and empty text as none", () => {
    expect(splitSnippet("plain")).toEqual([{ text: "plain", match: false }]);
    expect(splitSnippet("")).toEqual([]);
  });

  it("runs an unclosed match to the end and handles adjacent matches", () => {
    expect(splitSnippet("a\u0001bc")).toEqual([
      { text: "a", match: false },
      { text: "bc", match: true },
    ]);
    expect(splitSnippet("\u0001a\u0002\u0001b\u0002")).toEqual([
      { text: "a", match: true },
      { text: "b", match: true },
    ]);
  });

  it("never returns the markers themselves", () => {
    const parts = splitSnippet("x\u0001y\u0002z\u0001\u0002");
    expect(parts.map((p) => p.text).join("")).toBe("xyz");
    expect(parts.some((p) => /[\u0001\u0002]/.test(p.text))).toBe(false);
  });
});

describe("cleanQuery", () => {
  it("trims and caps the query at 200 characters", () => {
    expect(cleanQuery("  abc  ")).toBe("abc");
    expect(cleanQuery("   ")).toBe("");
    expect(cleanQuery("x".repeat(250))).toHaveLength(200);
  });
});

describe("effortLabel", () => {
  it("maps each level to its label and null to the default", () => {
    expect(effortLabel(null, v056dEn)).toBe("Default");
    expect(effortLabel("off", v056dEn)).toBe("Off");
    expect(effortLabel("low", v056dEn)).toBe("Low");
    expect(effortLabel("medium", v056dEn)).toBe("Medium");
    expect(effortLabel("high", v056dEn)).toBe("High");
    expect(effortLabel("max", v056dEn)).toBe("Max");
  });

  it("lists the default first, then off and the four levels (six buttons)", () => {
    expect(EFFORT_CHOICES).toEqual([null, "off", "low", "medium", "high", "max"]);
  });
});

describe("argCommand", () => {
  it("reads /effort and /rename arguments", () => {
    expect(argCommand("/effort high")).toEqual({ name: "effort", arg: "high" });
    expect(argCommand("/effort")).toEqual({ name: "effort", arg: "" });
    expect(argCommand("/effort off")).toEqual({ name: "effort", arg: "off" });
    expect(argCommand("/rename  My title  ")).toEqual({ name: "rename", arg: "My title" });
    expect(argCommand("/effort\nhigh")).toEqual({ name: "effort", arg: "high" });
  });

  it("takes /export only with json", () => {
    expect(argCommand("/export json")).toEqual({ name: "export", arg: "json" });
    expect(argCommand("/export JSON")).toEqual({ name: "export", arg: "json" });
    expect(argCommand("/export")).toBeNull();
    expect(argCommand("/export markdown")).toBeNull();
  });

  it("ignores ordinary text and longer words", () => {
    expect(argCommand("hello /effort high")).toBeNull();
    expect(argCommand("/effortx high")).toBeNull();
    expect(argCommand("effort high")).toBeNull();
  });

  it("caps the argument at the frame limit", () => {
    const cmd = argCommand(`/rename ${"t".repeat(MAX_SLASH_ARG + 50)}`);
    expect(cmd?.arg).toHaveLength(MAX_SLASH_ARG);
  });

  it("completes effort and rename with a space rather than running them", () => {
    expect(ARG_COMMANDS).toEqual(["effort", "rename"]);
  });
});

describe("draftOf", () => {
  it("starts from the defaults when nothing is stored", () => {
    expect(draftOf(null)).toEqual({ systemPrompt: "", systemMode: "append", effort: null });
  });

  it("copies the stored settings", () => {
    const value = { systemPrompt: "Be brief", systemMode: "replace" as const, effort: "high" as const };
    expect(draftOf(value)).toEqual(value);
  });
});
