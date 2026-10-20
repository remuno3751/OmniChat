// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/streamReveal.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepReveal, safeCut, MAX_BACKLOG } from '../streamReveal';
import { motionFactors, resolveStreamAnim } from '../ui/motionLevel';

test('never stalls and never overshoots', () => {
  const text = 'a'.repeat(50);
  let s = { shown: 0, carry: 0 };
  let steps = 0;
  while (s.shown < text.length && steps < 1000) { s = stepReveal(text, s.shown, 16, s.carry); steps++; }
  assert.equal(s.shown, 50);
  assert.ok(steps < 60);
});

test('catches up faster with a larger backlog', () => {
  const small = stepReveal('x'.repeat(20), 0, 16).shown;
  const big = stepReveal('x'.repeat(800), 0, 16).shown;
  assert.ok(big > small * 3, `${big} vs ${small}`);
});

test('steady trickle when the buffer is small', () => {
  const r = stepReveal('abc', 0, 16);
  assert.equal(r.shown, 1);
});

test('long frames are clamped; huge backlog is skipped ahead', () => {
  const t = 'y'.repeat(MAX_BACKLOG + 5000);
  const r = stepReveal(t, 0, 5000);
  assert.ok(r.shown >= 5000 && r.shown < t.length);
});

test('does not split surrogate pairs', () => {
  const t = 'a😀b';
  assert.equal(safeCut(t, 2), 3);
  const r = stepReveal(t, 1, 1);
  assert.ok(r.shown === 3 || r.shown === 1 + 2);
});

test('already complete / empty', () => {
  assert.deepEqual(stepReveal('abc', 3, 16), { shown: 3, carry: 0 });
  assert.deepEqual(stepReveal('', 0, 16), { shown: 0, carry: 0 });
});

test('motion amount factors', () => {
  assert.equal(motionFactors('standard', false).durK, 1);
  assert.equal(motionFactors('off', false).on, false);
  assert.equal(motionFactors('rich', true).on, false);
  assert.ok(motionFactors('reduced', false).durK < 1);
});

test('stream animation resolution', () => {
  const on = motionFactors('standard', false);
  assert.equal(resolveStreamAnim('particles', on, true), 'particles');
  assert.equal(resolveStreamAnim('particles', on, false), 'smooth');
  assert.equal(resolveStreamAnim('smooth', motionFactors('standard', true), true), 'smooth');
  assert.equal(resolveStreamAnim('particles', motionFactors('standard', true), true), 'smooth');
  assert.equal(resolveStreamAnim('smooth', motionFactors('off', true), true), 'off');
  assert.equal(resolveStreamAnim('smooth', motionFactors('off', false), true), 'off');
});
