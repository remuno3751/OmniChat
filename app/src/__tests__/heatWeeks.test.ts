// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { heatWeeks } from '../usageFormat';

const d = (day: string, totalTokens: number) => ({ day, totalTokens });

test('heatWeeks: weeks start on Sunday, the first week is padded', () => {
  // 2026-10-21 is a Wednesday
  const w = heatWeeks([d('2026-10-21', 5), d('2026-10-22', 0), d('2026-10-23', 10)]);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].map((c) => (c ? c.day : null)), [null, null, null, '2026-10-21', '2026-10-22', '2026-10-23', null]);
});

test('heatWeeks: levels are relative to the busiest day (0 only for empty days)', () => {
  const w = heatWeeks([d('2026-10-18', 100), d('2026-10-19', 60), d('2026-10-20', 30), d('2026-10-21', 10), d('2026-10-22', 0)]).flat();
  assert.deepEqual(w.filter(Boolean).map((c) => c!.level), [4, 3, 2, 1, 0]);
});

test('heatWeeks: a new week starts after seven slots; no days -> no weeks', () => {
  const days = Array.from({ length: 9 }, (_, i) => d(`2026-10-${String(18 + i).padStart(2, '0')}`, i + 1));
  const w = heatWeeks(days);
  assert.equal(w.length, 2);
  assert.equal(w[1].filter(Boolean).length, 2);
  assert.deepEqual(heatWeeks([]), []);
});
