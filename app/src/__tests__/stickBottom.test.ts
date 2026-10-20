// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNearBottom } from '../stickBottom';

test('at bottom follows', () => {
  assert.equal(isNearBottom({ contentOffsetY: 500, contentHeight: 1000, layoutHeight: 500 }), true);
});
test('slightly above bottom still follows', () => {
  assert.equal(isNearBottom({ contentOffsetY: 450, contentHeight: 1000, layoutHeight: 500 }), true);
});
test('scrolled up stops following', () => {
  assert.equal(isNearBottom({ contentOffsetY: 100, contentHeight: 1000, layoutHeight: 500 }), false);
});
test('short content follows', () => {
  assert.equal(isNearBottom({ contentOffsetY: 0, contentHeight: 200, layoutHeight: 500 }), true);
});
