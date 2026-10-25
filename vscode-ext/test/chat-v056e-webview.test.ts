import { describe, expect, it } from "vitest";
import { buildCheckpointRow, buildCheckpointRows, CP_MAX_ROWS, formatCpTime } from "../src/webview/chat/checkpointModel";
import { canEditItem, lastUserItemId } from "../src/webview/chat/editLast";
import { isHttpUrl, SOURCES_MAX, sourcesOf } from "../src/webview/chat/sources";
import type { CheckpointItem, V056eStrings } from "../src/webview/chat/v056eTypes";

const S: V056eStrings = {
  cpTitle: "チェックポイント",
  cpHint: "hint",
  cpEmpty: "empty",
  cpLoading: "loading",
  cpError: "error",
  cpReload: "reload",
  cpRestore: "戻す",
  cpRestoring: "戻しています…",
  cpDirty: "作業中の変更あり",
  cpUnavailable: "unavailable",
  cpBusy: "busy",
  cpFiles: "変更 {n} ファイル",
  cpNoChange: "変更なし",
  cpButtonTip: "チェックポイント",
  srcTitle: (n: number) => `情報源 (${n})`,
  srcOpen: "リンクを開く",
  editLabel: "編集",
  editBannerText: "banner",
  editCancel: "キャンセル",
  editSendTip: "編集して再送",
};

/** A local-time timestamp, so the tests do not depend on the machine's zone. */
function at(y: number, m: number, d: number, h: number, min: number): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

function item(over: Partial<CheckpointItem> = {}): CheckpointItem {
  return {
    id: "cp1",
    createdAt: at(2026, 10, 24, 9, 5),
    dirty: false,
    restorable: true,
    prompt: "直して",
    files: 2,
    messageId: "m1",
    ...over,
  };
}

const NOW = at(2026, 10, 24, 18, 0);
const CTX = { now: NOW, busy: false, restoring: null };

describe("formatCpTime", () => {
  it("shows HH:mm for a time on the same day", () => {
    expect(formatCpTime(at(2026, 10, 24, 9, 5), NOW)).toBe("09:05");
  });

  it("shows M/D HH:mm for another day", () => {
    expect(formatCpTime(at(2026, 10, 23, 23, 40), NOW)).toBe("10/23 23:40");
    expect(formatCpTime(at(2026, 1, 3, 7, 0), NOW)).toBe("1/3 07:00");
  });

  it("treats the same day number in another month as another day", () => {
    expect(formatCpTime(at(2026, 9, 24, 12, 0), NOW)).toBe("9/24 12:00");
  });
});

describe("buildCheckpointRow", () => {
  it("draws a restorable row with its file count and the restore label", () => {
    const row = buildCheckpointRow(item(), CTX, S);
    expect(row.time).toBe("09:05");
    expect(row.files).toBe("変更 2 ファイル");
    expect(row.restoreLabel).toBe("戻す");
    expect(row.restoreOff).toBe(false);
    expect(row.restoreTip).toBeNull();
    expect(row.dirty).toBe(false);
  });

  it("says no change when there are no changed files", () => {
    expect(buildCheckpointRow(item({ files: 0 }), CTX, S).files).toBe("変更なし");
  });

  it("turns restore off with the unavailable tip when there is no ref", () => {
    const row = buildCheckpointRow(item({ restorable: false }), CTX, S);
    expect(row.restoreOff).toBe(true);
    expect(row.restoreTip).toBe("unavailable");
  });

  it("turns restore off while a run is going", () => {
    const row = buildCheckpointRow(item(), { ...CTX, busy: true }, S);
    expect(row.restoreOff).toBe(true);
    expect(row.restoreTip).toBe("busy");
  });

  it("marks the row being restored and turns the others off", () => {
    const mine = buildCheckpointRow(item({ id: "a" }), { ...CTX, restoring: "a" }, S);
    expect(mine.restoring).toBe(true);
    expect(mine.restoreLabel).toBe("戻しています…");
    const other = buildCheckpointRow(item({ id: "b" }), { ...CTX, restoring: "a" }, S);
    expect(other.restoring).toBe(false);
    expect(other.restoreOff).toBe(true);
  });

  it("keeps the dirty flag and the full prompt", () => {
    const row = buildCheckpointRow(item({ dirty: true, prompt: "長い依頼" }), CTX, S);
    expect(row.dirty).toBe(true);
    expect(row.prompt).toBe("長い依頼");
  });
});

describe("buildCheckpointRows", () => {
  it("keeps the host order and caps the list", () => {
    const many = Array.from({ length: CP_MAX_ROWS + 5 }, (_, i) => item({ id: `c${i}` }));
    const rows = buildCheckpointRows(many, CTX, S);
    expect(rows).toHaveLength(CP_MAX_ROWS);
    expect(rows[0].id).toBe("c0");
    expect(rows[CP_MAX_ROWS - 1].id).toBe(`c${CP_MAX_ROWS - 1}`);
  });
});

describe("sourcesOf", () => {
  it("returns no sources for an item without a list", () => {
    expect(sourcesOf({ kind: "assistant" })).toEqual([]);
    expect(sourcesOf(null)).toEqual([]);
    expect(sourcesOf({ sources: "x" })).toEqual([]);
  });

  it("drops an invalid source alone and keeps the others in order", () => {
    const out = sourcesOf({
      sources: [
        { title: "A", url: "https://a.example/x", host: "a.example" },
        { title: "B", url: "javascript:alert(1)", host: "x" },
        { title: "C", url: "not a url", host: "x" },
        "junk",
        { title: "D", url: "http://d.example/", host: "d.example" },
      ],
    });
    expect(out.map((s) => s.title)).toEqual(["A", "D"]);
  });

  it("falls back to the URL when the title is empty", () => {
    const out = sourcesOf({ sources: [{ title: "  ", url: "https://e.example/", host: "e.example" }] });
    expect(out[0].title).toBe("https://e.example/");
  });

  it("keeps at most eight sources", () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, url: `https://h${i}.example/`, host: `h${i}.example` }));
    const out = sourcesOf({ sources: list });
    expect(out).toHaveLength(SOURCES_MAX);
    expect(out[SOURCES_MAX - 1].title).toBe(`t${SOURCES_MAX - 1}`);
  });
});

describe("isHttpUrl", () => {
  it("accepts only absolute http and https URLs", () => {
    expect(isHttpUrl("https://example.com/a?b=1")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("/relative")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("last user item detection", () => {
  const items = [
    { id: "u1", kind: "user" },
    { id: "a1", kind: "assistant" },
    { id: "u2", kind: "user" },
    { id: "t1", kind: "tool" },
    { id: "a2", kind: "assistant" },
  ];

  it("finds the last user item even when answers follow it", () => {
    expect(lastUserItemId(items)).toBe("u2");
  });

  it("is null when there is no user item", () => {
    expect(lastUserItemId([{ id: "a", kind: "assistant" }])).toBeNull();
    expect(lastUserItemId([])).toBeNull();
  });

  it("offers edit only on the last user item and only when no run is going", () => {
    expect(canEditItem(items, "u2", false)).toBe(true);
    expect(canEditItem(items, "u1", false)).toBe(false);
    expect(canEditItem(items, "u2", true)).toBe(false);
    expect(canEditItem(items, "", false)).toBe(false);
  });
});
