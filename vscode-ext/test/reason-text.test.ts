import { describe, expect, it } from "vitest";
import { localizeReason } from "../src/ui/reasonText";

describe("localizeReason", () => {
  it("translates the policy and protected-rule reasons", () => {
    expect(localizeReason("exec needs approval in manual mode", "ja")).toBe("コマンド実行は手動モードでは承認が必要です");
    expect(localizeReason("P1-outside: path is outside the workspace", "ja")).toBe("P1-outside: パスがワークスペースの外です");
    expect(localizeReason("C-git: git push", "ja")).toBe("C-git: git push です");
    expect(localizeReason("deny rule d1", "ja")).toBe("拒否ルール d1 に一致しました");
    expect(localizeReason("extension: write inside .git", "ja")).toContain(".git の中への書き込み");
  });

  it("keeps English and unknown texts unchanged", () => {
    expect(localizeReason("exec needs approval in manual mode", "en")).toBe("exec needs approval in manual mode");
    expect(localizeReason("something new", "ja")).toBe("something new");
  });
});
