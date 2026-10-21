import { describe, expect, it } from "vitest";
import * as L from "../src/tools/limits.js";
import { truncateHeadTail } from "../src/tools/limits.js";

describe("limit constants match spec §3", () => {
  it("has the documented values", () => {
    expect(L.READ_FILE_DEFAULT_LIMIT_LINES).toBe(2000);
    expect(L.READ_FILE_MAX_LIMIT_LINES).toBe(5000);
    expect(L.LIST_DIR_MAX_DEPTH).toBe(3);
    expect(L.LIST_DIR_MAX_ENTRIES).toBe(500);
    expect(L.GLOB_DEFAULT_LIMIT).toBe(200);
    expect(L.GLOB_MAX_LIMIT).toBe(1000);
    expect(L.GREP_DEFAULT_LIMIT).toBe(100);
    expect(L.GREP_MAX_LIMIT).toBe(500);
    expect(L.GREP_MAX_CONTEXT).toBe(5);
    expect(L.GREP_MAX_LINE_CHARS).toBe(300);
    expect(L.GREP_MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(L.GREP_TIMEOUT_MS).toBe(20_000);
    expect(L.WRITE_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(L.RUN_COMMAND_MAX_CHARS).toBe(8000);
    expect(L.RUN_COMMAND_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(L.RUN_COMMAND_MAX_TIMEOUT_MS).toBe(600_000);
    expect(L.RUN_COMMAND_OUTPUT_MAX_BYTES).toBe(64 * 1024);
    expect(L.RUN_COMMAND_OUTPUT_HEAD_BYTES + L.RUN_COMMAND_OUTPUT_TAIL_BYTES).toBe(
      L.RUN_COMMAND_OUTPUT_MAX_BYTES,
    );
    expect(L.DIAGNOSTICS_DEFAULT_LIMIT).toBe(200);
    expect(L.GIT_STATUS_MAX_FILES).toBe(500);
    expect(L.GIT_DIFF_MAX_BYTES).toBe(200 * 1024);
    expect(L.GIT_DIFF_MAX_CONTEXT).toBe(20);
    expect(L.GIT_LOG_MAX_LIMIT).toBe(100);
    expect(L.GIT_COMMIT_MAX_MESSAGE_CHARS).toBe(4000);
    expect(L.TOOL_RESULT_MAX_BYTES).toBe(256 * 1024);
  });
});

describe("truncateHeadTail", () => {
  it("returns empty input unchanged", () => {
    expect(truncateHeadTail("", 10)).toBe("");
    expect(truncateHeadTail("", 0)).toBe("");
  });

  it("returns input unchanged when it fits", () => {
    expect(truncateHeadTail("hello", 5)).toBe("hello");
    expect(truncateHeadTail("hi", 100)).toBe("hi");
  });

  it("keeps head and tail with a marker counting removed chars", () => {
    const text = "a".repeat(40) + "b".repeat(60); // 100 chars
    const out = truncateHeadTail(text, 20);
    const m = /\n\[\.\.\. (\d+) chars truncated \.\.\.\]\n/.exec(out);
    expect(m).not.toBeNull();
    const removed = Number(m![1]);
    expect(removed).toBe(100 - 20);
    const [head, tail] = out.split(m![0]);
    expect(head.length + tail.length).toBe(20);
    expect(head.startsWith("a")).toBe(true);
    expect(tail.endsWith("b")).toBe(true);
    // head is ~1/4 of the budget
    expect(head.length).toBe(5);
  });

  it("never exceeds maxChars + marker length", () => {
    for (const len of [1, 2, 5, 17, 100, 1000]) {
      for (const max of [0, 1, 2, 3, 4, 5, 10, 99]) {
        const text = "x".repeat(len);
        const out = truncateHeadTail(text, max);
        const marker = out.match(/\n\[\.\.\. \d+ chars truncated \.\.\.\]\n/)?.[0] ?? "";
        expect(out.length).toBeLessThanOrEqual(max + marker.length);
        if (len <= max) expect(out).toBe(text);
      }
    }
  });

  it("handles zero budget", () => {
    const out = truncateHeadTail("abc", 0);
    expect(out).toBe("\n[... 3 chars truncated ...]\n");
  });

  it("does not split surrogate pairs", () => {
    const emoji = "\u{1F600}"; // two UTF-16 code units
    const text = emoji.repeat(10); // 20 code units
    for (const max of [1, 2, 3, 5, 7, 9]) {
      const out = truncateHeadTail(text, max);
      const body = out.replace(/\n\[\.\.\. \d+ chars truncated \.\.\.\]\n/, "");
      for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          expect(body.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
          i++;
        } else {
          expect(c < 0xdc00 || c > 0xdfff).toBe(true);
        }
      }
    }
  });
});
