import test from "node:test";
import assert from "node:assert/strict";
import { currentDateBlock } from "./prompts.js";

test("current date block names today, yesterday, tomorrow and says today is not future", () => {
  process.env.OMNICHAT_TZ = "Asia/Tokyo";
  const b = currentDateBlock(new Date("2026-10-16T15:30:00Z")); // 2026-10-17 00:30 JST
  assert.ok(b.includes("2026-10-17 (Saturday) 00:30"));
  assert.match(b, /Yesterday was 2026-10-16 and tomorrow is 2026-10-18/);
  assert.match(b, /NOT in the future/);
});

import { needsFreshInfo } from "./freshness.js";

test("needsFreshInfo flags time-sensitive questions and skips timeless ones", () => {
  for (const q of ["トヨタの今日の株価は?", "RTX50シリーズはまだ発売されてないよね?", "最新のiPhoneは?", "What is the latest Node.js version?", "Bitcoin price", "2026年の祝日"]) assert.equal(needsFreshInfo(q, new Date("2026-10-16")), true, q);
  for (const q of ["1+1は?", "Pythonでリストを逆順にするには", "Explain recursion", "こんにちは"]) assert.equal(needsFreshInfo(q, new Date("2026-10-16")), false, q);
});

import { isQuoteQuery } from "./quotes.js";

test("isQuoteQuery recognises price / FX / crypto questions", () => {
  for (const q of ["トヨタ自動車の今日の株価は?", "ドル円いくら?", "bitcoin price now", "AAPL stock price"]) assert.equal(isQuoteQuery(q), true, q);
  for (const q of ["RTX50シリーズの発売日", "こんにちは"]) assert.equal(isQuoteQuery(q), false, q);
});
