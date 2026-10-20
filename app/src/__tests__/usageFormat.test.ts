// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dayLabel,
  formatTokens,
  niceMax,
  periodDays,
  periodRange,
  segmentHeights,
  sharePct,
  shortDate,
  slashPeriodRange,
  tzOffsetMinutes,
} from '../usageFormat'

const utc = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi)

test('formatTokens: plain numbers below 1000', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(987), '987')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12.6), '13')
})

test('formatTokens: thousands with one decimal, trailing .0 dropped', () => {
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(1200), '1.2k')
  assert.equal(formatTokens(1960), '2k')
  assert.equal(formatTokens(9999), '10k')
  assert.equal(formatTokens(10000), '10k')
  assert.equal(formatTokens(12345), '12.3k')
  assert.equal(formatTokens(99949), '99.9k')
})

test('formatTokens: 100k and up are integers in k, then M', () => {
  assert.equal(formatTokens(123456), '123k')
  assert.equal(formatTokens(999499), '999k')
  assert.equal(formatTokens(999500), '1M')
  assert.equal(formatTokens(1000000), '1M')
  assert.equal(formatTokens(1200000), '1.2M')
  assert.equal(formatTokens(25000000), '25M')
})

test('formatTokens: negative, NaN and infinite are 0', () => {
  assert.equal(formatTokens(-5), '0')
  assert.equal(formatTokens(NaN), '0')
  assert.equal(formatTokens(Infinity), '0')
  assert.equal(formatTokens(undefined), '0')
})

test('tzOffsetMinutes: minutes east of UTC, never -0', () => {
  assert.equal(tzOffsetMinutes({ getTimezoneOffset: () => -540 }), 540)
  assert.equal(tzOffsetMinutes({ getTimezoneOffset: () => 300 }), -300)
  assert.equal(Object.is(tzOffsetMinutes({ getTimezoneOffset: () => 0 }), 0), true)
  assert.equal(typeof tzOffsetMinutes(), 'number')
})

test('periodDays and periodRange', () => {
  assert.equal(periodDays('7d'), 7)
  assert.equal(periodDays('30d'), 30)
  assert.equal(periodDays('90d'), 90)
  assert.equal(periodDays('all'), 0)
  const now = utc(2026, 10, 18, 15, 30)
  assert.deepEqual(periodRange('all', now, 0), { from: null, to: null })
  // UTC: 7d = Oct 12 00:00 .. today Oct 18
  assert.deepEqual(periodRange('7d', now, 0), { from: utc(2026, 10, 12), to: null })
  // JST: local date is already Oct 19 (00:30), 30d starts Sep 20 local = Sep 19 15:00 UTC
  assert.deepEqual(periodRange('30d', now, 540), { from: utc(2026, 9, 19, 15, 0), to: null })
  // EST: local date is Oct 18 10:30, 90d starts Jul 21 local midnight (= 05:00 UTC)
  assert.deepEqual(periodRange('90d', now, -300), { from: utc(2026, 7, 21, 5, 0), to: null })
})

test('periodRange: local midnight boundaries', () => {
  // JST 23:59 Oct 18 -> still Oct 18: today starts Oct 17 15:00 UTC
  assert.equal(slashPeriodRange('today', utc(2026, 10, 18, 14, 59), 540).from, utc(2026, 10, 17, 15, 0))
  // JST 00:00 Oct 19 -> today starts Oct 18 15:00 UTC
  assert.equal(slashPeriodRange('today', utc(2026, 10, 18, 15, 0), 540).from, utc(2026, 10, 18, 15, 0))
  // EST 23:59 Oct 17 (= 04:59 UTC Oct 18) -> today starts Oct 17 05:00 UTC
  assert.equal(slashPeriodRange('today', utc(2026, 10, 18, 4, 59), -300).from, utc(2026, 10, 17, 5, 0))
  // EST 00:00 Oct 18 (= 05:00 UTC Oct 18) -> today starts Oct 18 05:00 UTC
  assert.equal(slashPeriodRange('today', utc(2026, 10, 18, 5, 0), -300).from, utc(2026, 10, 18, 5, 0))
  // UTC: a 7d window that crosses a month boundary
  assert.equal(periodRange('7d', utc(2026, 11, 3, 12, 0), 0).from, utc(2026, 10, 28))
})

test('slashPeriodRange: today, week, month, all', () => {
  const now = utc(2026, 10, 18, 15, 30)
  assert.deepEqual(slashPeriodRange('today', now, 0), { from: utc(2026, 10, 18), to: null })
  assert.deepEqual(slashPeriodRange('week', now, 0), { from: utc(2026, 10, 12), to: null })
  assert.deepEqual(slashPeriodRange('month', now, 0), { from: utc(2026, 9, 19), to: null })
  assert.deepEqual(slashPeriodRange('all', now, 0), { from: null, to: null })
  // JST: local date Oct 19 -> week starts Oct 13 local = Oct 12 15:00 UTC
  assert.equal(slashPeriodRange('week', now, 540).from, utc(2026, 10, 12, 15, 0))
  // EST: local date Oct 18 -> week starts Oct 12 local = Oct 12 05:00 UTC
  assert.equal(slashPeriodRange('week', now, -300).from, utc(2026, 10, 12, 5, 0))
})

test('dayLabel: en and ja', () => {
  assert.equal(dayLabel('2026-10-18', 'en'), 'Oct 18')
  assert.equal(dayLabel('2026-10-18', 'ja'), '10/18')
  assert.equal(dayLabel('2026-01-05', 'en'), 'Jan 5')
  assert.equal(dayLabel('2026-01-05', 'ja'), '1/5')
  assert.equal(dayLabel('nope', 'en'), 'nope')
  assert.equal(dayLabel('2026-13-01', 'en'), '2026-13-01')
})

test('shortDate: converted to tz, en and ja', () => {
  const ms = utc(2026, 10, 18, 15, 0) // JST Oct 19 00:00
  assert.equal(shortDate(ms, 540, 'en'), 'Oct 19, 2026')
  assert.equal(shortDate(ms, 540, 'ja'), '2026/10/19')
  assert.equal(shortDate(ms, 0, 'en'), 'Oct 18, 2026')
  assert.equal(shortDate(ms, -300, 'ja'), '2026/10/18')
  assert.equal(shortDate(0, 0, 'en'), '-')
  assert.equal(shortDate(NaN, 0, 'en'), '-')
})

test('segmentHeights: scaled parts (input, output = completion - reasoning, thinking)', () => {
  const day = { promptTokens: 300, completionTokens: 200, reasoningTokens: 50 }
  // max 1000 over 100px: input 30, output 150 -> 15, thinking 50 -> 5
  assert.deepEqual(segmentHeights(day, 1000, 100), { input: 30, output: 15, thinking: 5 })
  // no reasoning -> no thinking segment
  assert.deepEqual(
    segmentHeights({ promptTokens: 300, completionTokens: 200, reasoningTokens: 0 }, 1000, 100),
    { input: 30, output: 20, thinking: 0 },
  )
  // empty day
  assert.deepEqual(segmentHeights({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, 1000, 100), { input: 0, output: 0, thinking: 0 })
})

test('segmentHeights: non-zero parts keep at least 1px and the total fits', () => {
  const tiny = segmentHeights({ promptTokens: 1, completionTokens: 1, reasoningTokens: 0 }, 1000000, 100)
  assert.deepEqual(tiny, { input: 1, output: 1, thinking: 0 })
  for (const max of [1, 7, 1000, 123456]) {
    for (const [p, c, r] of [[900, 900, 0], [5, 3, 3], [1, 0, 0], [40, 60, 59], [1000, 1000, 1000]]) {
      const h = segmentHeights({ promptTokens: p, completionTokens: c, reasoningTokens: r }, max, 80)
      assert.ok(h.input + h.output + h.thinking <= 80, `sum for ${[max, p, c, r]}`)
      assert.ok(h.input >= 0 && h.output >= 0 && h.thinking >= 0)
      if (p > 0) assert.ok(h.input >= 1)
    }
  }
  assert.deepEqual(segmentHeights({ promptTokens: 5, completionTokens: 5, reasoningTokens: 0 }, 0, 80), { input: 0, output: 0, thinking: 0 })
  assert.deepEqual(segmentHeights({ promptTokens: 5, completionTokens: 5, reasoningTokens: 0 }, 10, 0), { input: 0, output: 0, thinking: 0 })
})

test('niceMax rounds up to 1, 2 or 5 times a power of ten', () => {
  assert.equal(niceMax(0), 1)
  assert.equal(niceMax(1), 1)
  assert.equal(niceMax(1.5), 2)
  assert.equal(niceMax(2), 2)
  assert.equal(niceMax(3), 5)
  assert.equal(niceMax(5), 5)
  assert.equal(niceMax(7), 10)
  assert.equal(niceMax(120), 200)
  assert.equal(niceMax(480), 500)
  assert.equal(niceMax(1000), 1000)
  assert.equal(niceMax(1001), 2000)
  assert.equal(niceMax(0.3), 0.5)
  assert.equal(niceMax(45678), 50000)
})

test('sharePct', () => {
  assert.equal(sharePct(0.45), '45%')
  assert.equal(sharePct(0.5), '50%')
  assert.equal(sharePct(1), '100%')
  assert.equal(sharePct(0.004), '<1%')
  assert.equal(sharePct(0.0099), '<1%')
  assert.equal(sharePct(0), '0%')
  assert.equal(sharePct(NaN), '0%')
})
