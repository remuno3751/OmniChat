// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petUnread.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissUnread, finishRun, finishedIds, unreadList, watchShown } from '../petUnread.ts';

test('a run that ends while the user is not watching it becomes unread', () => {
  const m = finishRun({}, { id: 'a', outcome: 'done', at: 10 }, false);
  assert.deepEqual(m, { a: { id: 'a', outcome: 'done', at: 10 } });
});

test('a run that ends while the user watches it stays read', () => {
  assert.deepEqual(finishRun({}, { id: 'a', outcome: 'done', at: 10 }, true), {});
});

test('an error finish is unread with its outcome', () => {
  const m = finishRun({}, { id: 'b', outcome: 'error', at: 5 }, false);
  assert.equal(m.b.outcome, 'error');
});

test('focused and shown clears that conversation only', () => {
  let m = finishRun({}, { id: 'a', outcome: 'done', at: 1 }, false);
  m = finishRun(m, { id: 'b', outcome: 'done', at: 2 }, false);
  assert.deepEqual(Object.keys(watchShown(m, 'a', true)), ['b']);
});

test('not focused, or nothing shown, keeps the unread marks', () => {
  const m = finishRun({}, { id: 'a', outcome: 'done', at: 1 }, false);
  assert.equal(watchShown(m, 'a', false), m);
  assert.equal(watchShown(m, null, true), m);
  assert.equal(watchShown(m, 'other', true), m);
});

test('dismiss removes one mark and keeps the map when it is absent', () => {
  const m = finishRun({}, { id: 'a', outcome: 'done', at: 1 }, false);
  assert.deepEqual(dismissUnread(m, 'a'), {});
  assert.equal(dismissUnread(m, 'zzz'), m);
});

test('unread list is newest first', () => {
  let m = finishRun({}, { id: 'old', outcome: 'done', at: 1 }, false);
  m = finishRun(m, { id: 'new', outcome: 'error', at: 9 }, false);
  assert.deepEqual(unreadList(m).map((e) => e.id), ['new', 'old']);
});

test('finishedIds lists the ids that stopped running', () => {
  assert.deepEqual(finishedIds(['a', 'b', 'c'], ['b']), ['a', 'c']);
  assert.deepEqual(finishedIds([], ['x']), []);
});
