// Placeholder titles from a first message (title.ts clipTitle): a Code chat keeps at most 30 characters, cut at a phrase boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipTitle } from "./title.js";

test("a short line is kept as it is; the first non-empty line is used", () => {
  assert.equal(clipTitle("rename the module"), "rename the module");
  assert.equal(clipTitle("  \n  second line wins not\nthird"), "second line wins not");
  assert.equal(clipTitle(""), "");
  assert.equal(clipTitle(undefined), "");
});

test("a long line is clipped at the last phrase boundary in its second half", () => {
  assert.equal(clipTitle("Please refactor the payment module so that the retry logic is shared"), "Please refactor the payment");
});

test("Japanese text with no spaces is cut hard at 30 characters, and a phrase boundary is used when there is one", () => {
  const long = "あ".repeat(40);
  assert.equal(clipTitle(long), "あ".repeat(30));
  assert.equal(clipTitle("あいうえおかきくけこさしすせそたちつてと。" + "い".repeat(20)), "あいうえおかきくけこさしすせそたちつてと");
});

test("a boundary too early in the text is not used (cut hard instead)", () => {
  const s = "ab " + "c".repeat(40);
  assert.equal(clipTitle(s), "ab " + "c".repeat(27));
});
