// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petPager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageLabel, petSpriteMode, pickInitial, reconcileSelection, stackCapacity, stackVisible, stepSelection } from '../petPager.ts';

const item = (id, at, o = {}) => ({ id, title: id, mode: 'running', label: '', detail: '', at, unread: false, ...o });

test('initial selection: newest unread first, else newest running, else first', () => {
  const items = [item('r1', 50), item('u1', 10, { unread: true, mode: 'jumping' }), item('u2', 20, { unread: true, mode: 'failed' })];
  assert.equal(pickInitial(items), 'u2');
  assert.equal(pickInitial([item('r1', 5), item('r2', 9)]), 'r2');
  assert.equal(pickInitial([]), null);
});

test('a new item does not move the selection', () => {
  const prev = [item('a', 1), item('b', 2)];
  assert.equal(reconcileSelection('a', prev, [item('c', 9), ...prev]), 'a');
});

test('a removed selection moves to the nearest neighbour in the old order', () => {
  const prev = [item('a', 3), item('b', 2), item('c', 1)];
  assert.equal(reconcileSelection('b', prev, [item('a', 3), item('c', 1)]), 'c');
  assert.equal(reconcileSelection('c', prev, [item('a', 3), item('b', 2)]), 'b');
});

test('empty list clears the selection; first selection uses the initial rule', () => {
  assert.equal(reconcileSelection('a', [item('a', 1)], []), null);
  assert.equal(reconcileSelection(null, [], [item('x', 1, { unread: true })]), 'x');
});

test('step clamps at both ends', () => {
  const items = [item('a', 3), item('b', 2), item('c', 1)];
  assert.equal(stepSelection('a', items, -1), 'a');
  assert.equal(stepSelection('a', items, 1), 'b');
  assert.equal(stepSelection('c', items, 1), 'c');
  assert.equal(stepSelection(null, [], 1), null);
});

test('page label is 1-based k/N', () => {
  const items = [item('a', 3), item('b', 2), item('c', 1)];
  assert.equal(pageLabel('b', items), '2/3');
  assert.equal(pageLabel('zz', items), '1/3');
});

test('sprite follows the selected running item in the pager, the newest running one in the stack', () => {
  const items = [item('a', 3, { mode: 'searching' }), item('b', 9, { mode: 'thinking' }), item('u', 10, { unread: true, mode: 'jumping' })];
  assert.equal(petSpriteMode(items, 'pager', 'a'), 'searching');
  assert.equal(petSpriteMode(items, 'pager', 'u'), 'idle');
  assert.equal(petSpriteMode(items, 'stack', 'u'), 'thinking');
  assert.equal(petSpriteMode([item('u', 1, { unread: true, mode: 'failed' })], 'stack', 'u'), 'idle');
});

test('stack capacity uses the window height and the sprite height', () => {
  assert.equal(stackCapacity(128), Math.floor((360 - 128 - 16) / 52));
  assert.equal(stackCapacity(360), 1);
});

test('stack shows all items when they fit, else the last slot is the +N bubble', () => {
  const few = [item('a', 3), item('b', 2)];
  assert.deepEqual(stackVisible(few, 128), { shown: few, more: 0 });
  const many = Array.from({ length: 8 }, (_, i) => item('i' + i, 100 - i));
  const r = stackVisible(many, 128);
  assert.equal(r.shown.length, stackCapacity(128) - 1);
  assert.equal(r.shown.length + r.more, 8);
});
