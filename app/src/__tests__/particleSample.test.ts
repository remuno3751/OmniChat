// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleEvenly, chunkAlive } from '../ui/particleSample';

test('sampleEvenly keeps everything when it fits', () => {
  assert.deepEqual(sampleEvenly(3, 48), [0, 1, 2]);
  assert.deepEqual(sampleEvenly(0, 48), []);
});
test('sampleEvenly spreads over the whole range, including the last position', () => {
  const s = sampleEvenly(300, 48);
  assert.equal(s.length, 48);
  assert.equal(s[0], 0);
  assert.equal(s[47], 299);
  assert.ok(s.every((v, i) => i === 0 || v > s[i - 1]));
});
test('newest chunks never expire, older ones do', () => {
  assert.equal(chunkAlive(900, 0, 420), true);
  assert.equal(chunkAlive(900, 1, 420), true);
  assert.equal(chunkAlive(900, 2, 420), false);
  assert.equal(chunkAlive(100, 5, 420), true);
});
