// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petPos.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPetPx, normalizePetPos, petGripLeft, petPosToPx, petPxToPos } from '../petPos.ts';

const area = { w: 400, h: 300 };
const pet = { w: 100, h: 120 };

test('normalizePetPos keeps valid fractions and rejects everything else', () => {
  assert.deepEqual(normalizePetPos({ fx: 0.3, fy: 0.7 }), { fx: 0.3, fy: 0.7 });
  assert.deepEqual(normalizePetPos({ fx: -5, fy: 9 }), { fx: 0, fy: 1 });
  assert.equal(normalizePetPos(null), null);
  assert.equal(normalizePetPos([0, 0]), null);
  assert.equal(normalizePetPos({ fx: NaN, fy: 0 }), null);
  assert.equal(normalizePetPos({ fx: '0.5', fy: 0.5 }), null);
});

test('fractions map to the corners of the free room', () => {
  assert.deepEqual(petPosToPx({ fx: 0, fy: 0 }, area, pet), { left: 0, top: 0 });
  assert.deepEqual(petPosToPx({ fx: 1, fy: 1 }, area, pet), { left: 300, top: 180 });
  assert.deepEqual(petPosToPx({ fx: 0.5, fy: 0.5 }, area, pet), { left: 150, top: 90 });
});

test('pixels round-trip through fractions', () => {
  const pos = petPxToPos({ left: 150, top: 90 }, area, pet);
  assert.deepEqual(pos, { fx: 0.5, fy: 0.5 });
  assert.deepEqual(petPosToPx(pos, area, pet), { left: 150, top: 90 });
});

test('dragging outside is clamped so the whole pet stays inside', () => {
  assert.deepEqual(clampPetPx({ left: -50, top: -10 }, area, pet), { left: 0, top: 0 });
  assert.deepEqual(clampPetPx({ left: 999, top: 999 }, area, pet), { left: 300, top: 180 });
  assert.deepEqual(petPxToPos({ left: 999, top: -4 }, area, pet), { fx: 1, fy: 0 });
});

test('a window smaller than the pet gives position 0 instead of negative room', () => {
  const tiny = { w: 60, h: 50 };
  assert.deepEqual(petPosToPx({ fx: 1, fy: 1 }, tiny, pet), { left: 0, top: 0 });
  assert.deepEqual(petPxToPos({ left: 10, top: 10 }, tiny, pet), { fx: 0, fy: 0 });
});

test('a resized container keeps the same fractions inside the new bounds', () => {
  const pos = { fx: 1, fy: 1 };
  const small = petPosToPx(pos, { w: 200, h: 200 }, pet);
  assert.deepEqual(small, { left: 100, top: 80 });
});

test('the move grip is centred on the top edge of the pet, and never negative', () => {
  assert.equal(petGripLeft({ w: 192, h: 208 }, 28), 82);
  assert.equal(petGripLeft({ w: 20, h: 20 }, 28), 0);
});
