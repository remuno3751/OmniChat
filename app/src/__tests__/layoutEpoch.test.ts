// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRealResize, RESIZE_THRESHOLD } from '../ui/layoutEpoch';

test('fold/unfold and rotation count as real resizes', () => {
  assert.equal(isRealResize(412, 884), true);
  assert.equal(isRealResize(884, 412), true);
  assert.equal(isRealResize(412, 915), true);
});

test('small jitter is ignored', () => {
  assert.equal(isRealResize(412, 412), false);
  assert.equal(isRealResize(412, 412 + RESIZE_THRESHOLD - 1), false);
  assert.equal(isRealResize(412, 412 + RESIZE_THRESHOLD), true);
});

test('non-finite widths never trigger', () => {
  assert.equal(isRealResize(NaN, 400), false);
  assert.equal(isRealResize(400, Infinity), false);
});
