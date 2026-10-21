import { describe, expect, it } from "vitest";
import { readConfig, type GetConfig } from "../src/config";

/** Builds a getConfig fake from a settings object keyed by full id. */
const settings = (values: Record<string, unknown>): GetConfig => (id) => values[id];

describe("readConfig", () => {
  it("returns defaults when nothing is set", () => {
    expect(readConfig(settings({}))).toEqual({
      serverUrl: "",
      theme: "frontier",
      decorations: "auto",
      shell: undefined,
      autoSave: true,
    });
  });

  it("reads every setting by its full omnichat.* id", () => {
    const seen: string[] = [];
    readConfig((id) => {
      seen.push(id);
      return undefined;
    });
    expect(seen.sort()).toEqual([
      "omnichat.autoSave",
      "omnichat.decorations",
      "omnichat.serverUrl",
      "omnichat.shell",
      "omnichat.theme",
    ]);
  });

  it("falls back to frontier for an invalid theme", () => {
    expect(readConfig(settings({ "omnichat.theme": "neon" })).theme).toBe("frontier");
    expect(readConfig(settings({ "omnichat.theme": 42 })).theme).toBe("frontier");
    expect(readConfig(settings({ "omnichat.theme": "Simple" })).theme).toBe("frontier");
  });

  it("accepts each valid theme", () => {
    for (const theme of ["simple", "frontier", "astral"] as const) {
      expect(readConfig(settings({ "omnichat.theme": theme })).theme).toBe(theme);
    }
  });

  it("trims serverUrl and treats non-strings as empty", () => {
    expect(readConfig(settings({ "omnichat.serverUrl": "  https://omni.example.com/ \n" })).serverUrl).toBe(
      "https://omni.example.com/",
    );
    expect(readConfig(settings({ "omnichat.serverUrl": 7 })).serverUrl).toBe("");
  });

  it("treats a blank shell as unset and trims a real one", () => {
    expect(readConfig(settings({ "omnichat.shell": "   " })).shell).toBeUndefined();
    expect(readConfig(settings({ "omnichat.shell": " /bin/zsh " })).shell).toBe("/bin/zsh");
  });

  it("honours autoSave=false and ignores non-boolean values", () => {
    expect(readConfig(settings({ "omnichat.autoSave": false })).autoSave).toBe(false);
    expect(readConfig(settings({ "omnichat.autoSave": "no" })).autoSave).toBe(true);
  });
});
