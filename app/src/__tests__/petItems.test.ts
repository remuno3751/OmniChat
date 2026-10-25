// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petItems.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, buildItems, itemsFromState, PET_MAX_ITEMS } from '../petItems.ts';
import { effectivePets, DEVICE_DEFAULTS } from '../deviceSettings.ts';
import { petAnchorBottom, PET_ANCHOR_BOTTOM } from '../petPos.ts';

test('running items come first; an unread finish of a running chat is dropped', () => {
  const runs = [{ id: 'r', title: 'R', mode: 'running', detail: '', at: 5 }];
  const finished = [
    { id: 'r', title: 'R', outcome: 'done', at: 9, unread: true },
    { id: 'u', title: 'U', outcome: 'error', at: 7, unread: true },
  ];
  const items = buildItems(runs, finished, 'en');
  assert.deepEqual(items.map((i) => i.id), ['u', 'r']);
  assert.equal(items[0].mode, 'failed');
  assert.equal(items[0].unread, true);
  assert.equal(items[0].label, 'Something went wrong. Please check');
});

test('unread done uses the done text in Japanese', () => {
  const items = buildItems([], [{ id: 'x', title: '', outcome: 'done', at: 1, unread: true }], 'ja');
  assert.equal(items[0].label, '完了しました。回答を確認してください');
  assert.equal(items[0].mode, 'jumping');
});

test('a transient finish (not unread) carries its short bubble text', () => {
  const items = buildItems([], [{ id: 't', title: 'T', outcome: 'done', at: 1, unread: false }], 'en');
  assert.equal(items[0].unread, false);
  assert.equal(items[0].label, 'Done!');
});

test('at most PET_MAX_ITEMS items, running kept first', () => {
  const runs = Array.from({ length: 6 }, (_, i) => ({ id: 'r' + i, title: '', mode: 'thinking', detail: '', at: i }));
  const finished = Array.from({ length: 6 }, (_, i) => ({ id: 'u' + i, title: '', outcome: 'done', at: 100 + i, unread: true }));
  const items = buildItems(runs, finished, 'en');
  assert.equal(items.length, PET_MAX_ITEMS);
  assert.equal(items.filter((i) => !i.unread).length, 6);
});

test('activityOf: approval first, streaming phase, then a running code session', () => {
  assert.equal(activityOf(undefined, 'awaiting_approval'), 'waiting');
  assert.equal(activityOf(undefined, 'running'), 'running');
  assert.equal(activityOf(undefined, 'done'), '');
  assert.equal(activityOf({}, undefined), '');
  const msgs = { m: { id: 'm', role: 'assistant', status: 'streaming', phases: [{ phase: 'searching', start: 1, end: null }] } };
  assert.equal(activityOf(msgs, undefined), 'searching');
});

test('itemsFromState reads v2 items and wraps a v1 state into one item', () => {
  const v2 = itemsFromState({ type: 'state', v: 2, items: [{ id: 'a', title: 'A', mode: 'thinking', label: 'x', detail: '', at: 1, unread: false }, { id: 'bad' }] });
  assert.deepEqual(v2.map((i) => i.id), ['a']);
  const v1 = itemsFromState({ type: 'state', mode: 'running', label: 'Writing', detail: '', at: 3 });
  assert.equal(v1.length, 1);
  assert.equal(v1[0].id, 'legacy');
  assert.deepEqual(itemsFromState({ type: 'state', mode: 'idle', label: '', at: 3 }), []);
});

test('effectivePets: a device that never chose follows the synced pet; an explicit choice wins', () => {
  const fresh = { ...DEVICE_DEFAULTS.pets };
  assert.deepEqual(effectivePets(fresh, 'synced'), { enabled: true, petId: 'synced' });
  assert.deepEqual(effectivePets(fresh, null), { enabled: false, petId: null });
  const chosen = { ...fresh, explicit: true, enabled: false, petId: 'mine' };
  assert.deepEqual(effectivePets(chosen, 'synced'), { enabled: false, petId: 'mine' });
  const offExplicit = { ...fresh, explicit: true, enabled: false };
  assert.deepEqual(effectivePets(offExplicit, 'synced'), { enabled: false, petId: 'synced' });
});

test('in-app pet anchor: above the composer on narrow screens, unchanged on wide ones', () => {
  assert.equal(petAnchorBottom(1024), PET_ANCHOR_BOTTOM);
  assert.equal(petAnchorBottom(560), PET_ANCHOR_BOTTOM);
  assert.ok(petAnchorBottom(390) > PET_ANCHOR_BOTTOM);
  assert.equal(petAnchorBottom(390, 100), 112);
});
