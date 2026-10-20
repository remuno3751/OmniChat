// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { avoidPadding, keyboardOverlap } from '../keyboardMath';

test('overlap is container bottom minus keyboard top, never negative', () => {
  assert.equal(keyboardOverlap(2400, 1500), 900);
  assert.equal(keyboardOverlap(1500, 1500), 0);
  assert.equal(keyboardOverlap(1200, 1500), 0); // window already resized by the OS: nothing to compensate twice
  assert.equal(keyboardOverlap(2400, null), 0);
  assert.equal(keyboardOverlap(2400, NaN), 0);
});
test('padding: inset without keyboard, overlap with keyboard (inset dropped)', () => {
  assert.equal(avoidPadding({ keyboardVisible: false, overlap: 0, insetBottom: 34 }), 34);
  assert.equal(avoidPadding({ keyboardVisible: false, overlap: 0, insetBottom: 34, rest: 8 }), 42);
  assert.equal(avoidPadding({ keyboardVisible: true, overlap: 800, insetBottom: 34, rest: 8 }), 800);
  assert.equal(avoidPadding({ keyboardVisible: true, overlap: 0, insetBottom: 34 }), 0);
});
