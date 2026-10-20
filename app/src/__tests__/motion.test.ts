// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/motion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFactors, resolveStreamAnim } from '../ui/motionLevel';

test('Off and OS reduce-motion disable animation entirely', () => {
  assert.equal(motionFactors('off', false).on, false);
  assert.equal(motionFactors('off', true).on, false);
  assert.equal(motionFactors('standard', true).on, false);
  assert.equal(motionFactors('rich', true).on, false);
});

test('Reduced, Standard and Rich all animate, and get strictly stronger', () => {
  const reduced = motionFactors('reduced', false);
  const standard = motionFactors('standard', false);
  const rich = motionFactors('rich', false);
  for (const f of [reduced, standard, rich]) {
    assert.equal(f.on, true);
    assert.ok(f.durK > 0);
    assert.ok(f.distK > 0);
  }
  assert.ok(reduced.durK < standard.durK && standard.durK < rich.durK);
  assert.ok(reduced.distK < standard.distK && standard.distK < rich.distK);
});

test('stream animation resolution on native', () => {
  // native: Smooth stays, Particles falls back to Smooth, Off stays Off
  assert.equal(resolveStreamAnim('smooth', motionFactors('standard', false), false), 'smooth');
  assert.equal(resolveStreamAnim('particles', motionFactors('standard', false), false), 'smooth');
  assert.equal(resolveStreamAnim('smooth', motionFactors('off', false), false), 'off');
});
