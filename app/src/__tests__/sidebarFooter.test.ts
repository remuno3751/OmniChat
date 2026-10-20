// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFooterItems } from '../sidebarFooter';

const items = [
  { key: 'newProject', prio: 2 }, { key: 'newChat', prio: 1 }, { key: 'ephemeral', prio: 4 },
  { key: 'tips', prio: 5 }, { key: 'pin', prio: 7 }, { key: 'hide', prio: 6 }, { key: 'settings', prio: 0 },
];
const keys = (l) => l.map((i) => i.key);

test('wide: everything in the bottom row, the top row only has the user name', () => {
  const r = splitFooterItems(items, 280);
  assert.deepEqual(keys(r.top), []);
  assert.equal(r.bottom.length, 7);
});

test('a little narrower: only the lowest priority (pin) moves up', () => {
  const r = splitFooterItems(items, 236); // 6 buttons fit in a row
  assert.deepEqual(keys(r.top), ['pin']);
  assert.equal(r.bottom.length, 6);
});

test('narrower: pin and hide move up (lowest priority first), display order is kept', () => {
  const r = splitFooterItems(items, 196); // 5 per row; 100px left for the name beside 2 buttons
  assert.deepEqual(keys(r.top), ['pin', 'hide']);
  assert.deepEqual(keys(r.bottom), ['newProject', 'newChat', 'ephemeral', 'tips', 'settings']);
});

test('very narrow: the top row is limited by the room for the name; the rest stays at the bottom', () => {
  const r = splitFooterItems(items, 120);
  assert.ok(r.top.length <= 1);
  assert.equal(r.top.length + r.bottom.length, 7);
});

test('no items, or a width of zero, never throws', () => {
  assert.deepEqual(splitFooterItems([], 100), { top: [], bottom: [] });
  const r = splitFooterItems(items, 0);
  assert.equal(r.top.length + r.bottom.length, 7);
});
