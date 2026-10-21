import { describe, expect, it } from "vitest";
import { formatDuration, relativeTime, truncateTitle } from "../src/chat/format";

/** Local-time date helper so the tests do not depend on the machine's time zone. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

describe("relativeTime", () => {
  const now = at(2026, 10, 21, 12, 0);

  it("reads recent times in Japanese", () => {
    expect(relativeTime(now - 20_000, now, "ja")).toBe("たった今");
    expect(relativeTime(now - 5 * 60_000, now, "ja")).toBe("5分前");
    expect(relativeTime(now - 3 * 3_600_000, now, "ja")).toBe("3時間前");
  });

  it("reads recent times in English", () => {
    expect(relativeTime(now - 20_000, now, "en")).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now, "en")).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now, "en")).toBe("3h ago");
  });

  it("uses yesterday by calendar day, not by 24 hours", () => {
    const lateYesterday = at(2026, 10, 20, 23, 30);
    expect(relativeTime(lateYesterday, now, "en")).toBe("yesterday");
    expect(relativeTime(lateYesterday, now, "ja")).toBe("昨日");
  });

  it("counts days under a week", () => {
    expect(relativeTime(at(2026, 10, 18), now, "en")).toBe("3d ago");
    expect(relativeTime(at(2026, 10, 18), now, "ja")).toBe("3日前");
  });

  it("shows the date from a week back", () => {
    expect(relativeTime(at(2026, 10, 14), now, "en")).toBe("Oct 14");
    expect(relativeTime(at(2026, 10, 14), now, "ja")).toBe("10/14");
    expect(relativeTime(at(2026, 1, 3), now, "en")).toBe("Jan 3");
  });

  it("reads a future time as just now", () => {
    expect(relativeTime(now + 60_000, now, "en")).toBe("just now");
  });
});

describe("formatDuration", () => {
  it("uses milliseconds below a second", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999.4)).toBe("999ms");
  });

  it("uses seconds with one decimal below a minute", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(59_000)).toBe("59.0s");
  });

  it("uses minutes and zero-padded seconds from a minute on", () => {
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(600_000)).toBe("10m 00s");
  });

  it("treats invalid input as zero", () => {
    expect(formatDuration(-5)).toBe("0ms");
    expect(formatDuration(Number.NaN)).toBe("0ms");
  });
});

describe("truncateTitle", () => {
  it("keeps short titles and trims whitespace", () => {
    expect(truncateTitle("  hello  ", 10)).toBe("hello");
  });

  it("cuts long titles with an ellipsis", () => {
    expect(truncateTitle("abcdefghij", 5)).toBe("abcd…");
  });

  it("counts characters, not UTF-16 units", () => {
    expect(truncateTitle("あいうえお", 5)).toBe("あいうえお");
    expect(truncateTitle("あいうえおか", 5)).toBe("あいうえ…");
  });
});
