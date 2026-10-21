import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMMAND_PREVIEW_CHARS,
  approvalStrings,
  buildApprovalView,
  lineStat,
  parseWebviewMessage,
  type ApprovalInput,
} from "../src/ui/approvalModel";

const base: ApprovalInput = {
  type: "approval",
  requestId: "r1",
  approvalId: "a1",
  callId: "c1",
  tool: "read_file",
  path: "/etc/hosts",
  reason: "outside workspace (symlink)",
};

const JA_RE = /[぀-ヿ一-龯]/;

describe("buildApprovalView: protected vs normal", () => {
  it("treats a frame without an explicit flag as protected (approval frames are escalations)", () => {
    const view = buildApprovalView(base);
    expect(view.protected).toBe(true);
    expect(view.badge).toBe("保護");
    expect(view.protectedReasons).toEqual(["outside workspace (symlink)"]);
    expect(view.focusId).toBe("rejected");
    expect(view.actions.find((a) => a.id === "rejected")?.primary).toBe(true);
    expect(view.actions.find((a) => a.id === "allowed-once")?.primary).toBe(false);
  });

  it("normal item: no badge, always-allow allowed, focus on allow", () => {
    const view = buildApprovalView({ ...base, protected: false });
    expect(view.protected).toBe(false);
    expect(view.badge).toBeNull();
    expect(view.protectedReasons).toEqual([]);
    expect(view.protectedHint).toBeNull();
    expect(view.canAlwaysAllow).toBe(true);
    expect(view.focusId).toBe("allowed-once");
    expect(view.actions.find((a) => a.id === "allowed-once")?.primary).toBe(true);
    expect(view.actions.find((a) => a.id === "rejected")?.primary).toBe(false);
  });

  it("uses explicit protectedReasons when given, dropping blanks", () => {
    const view = buildApprovalView({
      ...base,
      protectedReasons: ["P1 outside", "  ", "P3 secrets"],
    });
    expect(view.protectedReasons).toEqual(["P1 outside", "P3 secrets"]);
  });
});

describe("no always-allow for protected items", () => {
  it("protected: canAlwaysAllow false and no action besides deny/allow-once/diff", () => {
    const view = buildApprovalView({ ...base, before: "a", after: "b" });
    expect(view.canAlwaysAllow).toBe(false);
    const decisions = view.actions.map((a) => a.decision).filter((d) => d !== undefined);
    expect(decisions.sort()).toEqual(["allowed-once", "rejected"]);
    expect(view.actions.map((a) => a.id)).not.toContain("always");
  });

  it("protected: hint text explains the missing always-allow option", () => {
    expect(buildApprovalView(base).protectedHint).toBe(approvalStrings("ja").protectedHint);
  });
});

describe("command truncation", () => {
  it("cuts a long command to 800 code points and reports the omitted count", () => {
    const command = "a".repeat(1000);
    const view = buildApprovalView({ ...base, tool: "run_command", command });
    expect(view.summaryKind).toBe("command");
    expect(view.truncated).toBe(true);
    expect(view.omittedChars).toBe(1000 - COMMAND_PREVIEW_CHARS);
    expect(view.summary.startsWith("a".repeat(COMMAND_PREVIEW_CHARS) + "\n")).toBe(true);
    expect(view.summary).toContain("200");
    expect(view.summary).not.toContain("a".repeat(COMMAND_PREVIEW_CHARS + 1));
  });

  it("counts code points, so multi-byte characters are not split", () => {
    const command = "あ".repeat(COMMAND_PREVIEW_CHARS + 5);
    const view = buildApprovalView({ ...base, command });
    expect(view.omittedChars).toBe(5);
    expect(view.summary.startsWith("あ".repeat(COMMAND_PREVIEW_CHARS))).toBe(true);
  });

  it("leaves a command at exactly the limit untouched", () => {
    const command = "b".repeat(COMMAND_PREVIEW_CHARS);
    const view = buildApprovalView({ ...base, command });
    expect(view.truncated).toBe(false);
    expect(view.summary).toBe(command);
  });
});

describe("ja / en texts", () => {
  it("defaults to Japanese", () => {
    const view = buildApprovalView(base);
    expect(view.title).toBe("保護された操作の承認");
    expect(view.actions.map((a) => a.label)).toEqual(["拒否", "今回だけ許可"]);
    expect(JA_RE.test(view.title)).toBe(true);
  });

  it("uses English when lang is en, with no Japanese characters", () => {
    const view = buildApprovalView({ ...base, protected: false }, "en");
    expect(view.title).toBe("Approval required");
    expect(view.statusLabel).toBe("Waiting");
    expect(view.actions.map((a) => a.label)).toEqual(["Deny", "Allow once"]);
    expect(JA_RE.test(JSON.stringify(view))).toBe(false);
  });

  it("truncation notice follows the language", () => {
    const command = "x".repeat(COMMAND_PREVIEW_CHARS + 3);
    expect(buildApprovalView({ ...base, command }, "en").summary).toContain("3 more characters");
    expect(buildApprovalView({ ...base, command }, "ja").summary).toContain("3 文字");
  });

  it("approvalStrings falls back to Japanese for an unknown language", () => {
    expect(approvalStrings("xx" as unknown as "ja")).toEqual(approvalStrings("ja"));
  });
});

describe("summaries and diff", () => {
  it("shows a diff stat and a View diff action when before and after are present", () => {
    const view = buildApprovalView({ ...base, tool: "edit_file", before: "a\nb\nc", after: "a\nB\nc\nd" }, "en");
    expect(view.summaryKind).toBe("diff-stat");
    expect(view.diffStat).toEqual({ additions: 2, deletions: 1 });
    expect(view.summary).toBe("+2 -1 lines");
    expect(view.actions[0]).toMatchObject({ id: "view-diff", primary: false });
  });

  it("has no diff action without both sides", () => {
    const view = buildApprovalView({ ...base, before: "a" });
    expect(view.actions.map((a) => a.id)).not.toContain("view-diff");
  });

  it("falls back to the path when there is no command or diff", () => {
    const view = buildApprovalView(base);
    expect(view.summaryKind).toBe("path");
    expect(view.summary).toBe("/etc/hosts");
  });

  it("lineStat counts lines as a multiset, ignoring order", () => {
    expect(lineStat("", "x\ny")).toEqual({ additions: 2, deletions: 0 });
    expect(lineStat("x\ny", "")).toEqual({ additions: 0, deletions: 2 });
    expect(lineStat("x\ny\nx", "y\nx")).toEqual({ additions: 0, deletions: 1 });
  });
});

describe("parseWebviewMessage", () => {
  it("accepts the three webview messages", () => {
    expect(parseWebviewMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewMessage({ type: "approval_reply", approvalId: "a1", decision: "rejected" })).toEqual({
      type: "approval_reply",
      approvalId: "a1",
      decision: "rejected",
    });
    expect(parseWebviewMessage({ type: "viewDiff", approvalId: "a1" })).toEqual({
      type: "viewDiff",
      approvalId: "a1",
    });
  });

  it("rejects unknown types, bad decisions, and missing ids", () => {
    expect(parseWebviewMessage(null)).toBeNull();
    expect(parseWebviewMessage("ready")).toBeNull();
    expect(parseWebviewMessage({ type: "approval_reply", approvalId: "a1", decision: "always" })).toBeNull();
    expect(parseWebviewMessage({ type: "approval_reply", decision: "rejected" })).toBeNull();
    expect(parseWebviewMessage({ type: "approval_reply", approvalId: "", decision: "rejected" })).toBeNull();
    expect(parseWebviewMessage({ type: "eval", approvalId: "a1" })).toBeNull();
  });
});

describe.each(["chat.js", "settings.js"])("webview %s", (file) => {
  const src = readFileSync(fileURLToPath(new URL(`../media/webview/${file}`, import.meta.url)), "utf8");

  it("never uses innerHTML, outerHTML, insertAdjacentHTML or document.write", () => {
    // chat.js renders escaped Markdown / plain text through exactly two sanctioned innerHTML sinks
    // (src/webview/render/markdown.ts and chat-text.ts output); everything else is forbidden.
    const rest = file === "chat.js" ? src.replace(/\.innerHTML = (renderMarkdown|plainToHtml)\(/g, ".sanctioned(") : src;
    expect(rest).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("uses the VS Code API and sets no inline style attribute (CSP)", () => {
    expect(src).toContain("acquireVsCodeApi");
    expect(src).not.toMatch(/setAttribute\(\s*["']style["']|\.style\./);
  });

  it("posts only the documented reply shape", () => {
    if (file === "chat.js") expect(src).toContain('type: "approval_reply"');
  });
});
