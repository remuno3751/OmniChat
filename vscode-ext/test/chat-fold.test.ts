import { describe, expect, it } from "vitest";
import { foldRuns, type ToolItem } from "../src/webview/render/timeline";
import { createThinkingModel } from "../src/webview/render/thinking";

const t = (id: string, tool: string): ToolItem => ({ kind: "tool", id, tool, summary: "", status: "done" }) as ToolItem;

describe("foldRuns", () => {
  it("folds 3+ calls of one tool in a row and leaves shorter runs alone", () => {
    const slots = foldRuns([t("1", "read_file"), t("2", "read_file"), t("3", "read_file"), t("4", "grep"), t("5", "grep"), t("6", "read_file")]);
    expect(slots.map((s) => (s.group ? `g${s.tools.length}` : "i"))).toEqual(["g3", "i", "i", "i"]);
    expect(slots[0]).toMatchObject({ group: true, key: "group:1" });
  });
  it("keeps the group key stable when the run grows", () => {
    const a = foldRuns([t("1", "x"), t("2", "x"), t("3", "x")])[0];
    const b = foldRuns([t("1", "x"), t("2", "x"), t("3", "x"), t("4", "x")])[0];
    expect(a).toMatchObject({ key: "group:1" });
    expect(b).toMatchObject({ key: "group:1" });
  });
});

describe("thinking fallback", () => {
  it("opens the reasoning of a finished turn that has no answer text", () => {
    const m = createThinkingModel();
    expect(m.update({ streaming: false, hasText: false }).forceOpen).toBe(true);
    expect(createThinkingModel().update({ streaming: false, hasText: true }).forceOpen).toBe(false);
  });
});
