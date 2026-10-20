// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { overflowToIndex, indexToOverflow, compressAtToSlider, sliderToCompressAt } from '../overflowSteps';

test('default slider: truncate / summarize / stop = 0 / 1 / 2', () => {
  assert.deepEqual(['truncate', 'summarize', 'stop'].map((v) => overflowToIndex(v, false)), [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((i) => indexToOverflow(i, false)), ['truncate', 'summarize', 'stop']);
});
test('chat slider has a leading "follow default" step', () => {
  assert.equal(overflowToIndex(null, true), 0);
  assert.equal(overflowToIndex('summarize', true), 2);
  assert.equal(indexToOverflow(0, true), null);
  assert.equal(indexToOverflow(3, true), 'stop');
  assert.equal(indexToOverflow(9, true), 'stop');
});
test('compress start: 100 is off', () => {
  assert.equal(compressAtToSlider(null), 100);
  assert.equal(sliderToCompressAt(100), null);
  assert.equal(sliderToCompressAt(80), 80);
  assert.equal(sliderToCompressAt(10), 50);
});
