// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { thinkingMs, waitStage } from '../waitState';

test('waitStage: 0-3 s is the waiting stage', () => {
  assert.deepEqual(waitStage(0), { key: 'wait.waiting', s: 0 });
  assert.deepEqual(waitStage(2999), { key: 'wait.waiting', s: 2 });
});
test('waitStage: from 3 s the prompt is processed', () => {
  assert.deepEqual(waitStage(3000), { key: 'wait.processing', s: 3 });
  assert.deepEqual(waitStage(29999), { key: 'wait.processing', s: 29 });
});
test('waitStage: from 30 s the slow stage (model load / long input)', () => {
  assert.deepEqual(waitStage(30000), { key: 'wait.slow', s: 30 });
  assert.deepEqual(waitStage(100000), { key: 'wait.slow', s: 100 });
});
test('waitStage: negative elapsed (clock skew) is clamped to 0', () => {
  assert.deepEqual(waitStage(-5000), { key: 'wait.waiting', s: 0 });
});
test('waitStage: tool activity keeps the waiting stage', () => {
  assert.deepEqual(waitStage(10000, true), { key: 'wait.waiting', s: 10 });
  assert.deepEqual(waitStage(60000, true), { key: 'wait.waiting', s: 60 });
});
test('thinkingMs: null until the reasoning lane starts', () => {
  assert.equal(thinkingMs(undefined, undefined, 5000), null);
  assert.equal(thinkingMs(0, undefined, 5000), null);
});
test('thinkingMs: running lane is measured up to now', () => {
  assert.equal(thinkingMs(1000, undefined, 4000), 3000);
});
test('thinkingMs: finished lane ignores later time', () => {
  assert.equal(thinkingMs(1000, 2500, 9000), 1500);
});
test('thinkingMs: never negative', () => {
  assert.equal(thinkingMs(5000, 4000, 9000), 0);
});
