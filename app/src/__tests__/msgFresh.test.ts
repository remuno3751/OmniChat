// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreshTracker, freshByClock, isFreshMessage } from '../ui/msgFresh';

const SKEW = 9000; // phone clock 9 s ahead of the server: server stamps look 9 s old

test('same clock: recent message is fresh, old one is not', () => {
  assert.equal(freshByClock(1000, 2000), true);
  assert.equal(freshByClock(1000, 6000), false);
});
test('skewed clock: clock test alone misses a brand-new server message', () => {
  const now = 100_000;
  const serverStamp = now - SKEW;
  assert.equal(freshByClock(serverStamp, now), false);
});
test('skewed clock: a message arriving after open is fresh via the tracker', () => {
  const tr = createFreshTracker();
  const now = 100_000;
  const old = [{ id: 'a', createdAt: 10_000 }, { id: 'b', createdAt: 20_000 }];
  tr.observe('c1', old);
  const next = [...old, { id: 'c', createdAt: now - SKEW }];
  tr.observe('c1', next);
  assert.equal(tr.isLate('c', now - SKEW), true);
  assert.equal(isFreshMessage(now - SKEW, now, tr.isLate('c', now - SKEW)), true);
  assert.equal(tr.isLate('a', 10_000), false);
  assert.equal(isFreshMessage(10_000, now, tr.isLate('a', 10_000)), false); // opening a long chat stays static
});
test('opening a conversation: nothing is late; older branch switched in is not late', () => {
  const tr = createFreshTracker();
  tr.observe('c1', [{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 50 }]);
  tr.observe('c1', [{ id: 'a', createdAt: 5 }, { id: 'x', createdAt: 20 }]); // older sibling
  assert.equal(tr.isLate('x', 20), false);
});
test('empty draft then first messages are late; conversation change resets', () => {
  const tr = createFreshTracker();
  tr.observe('d', []);
  tr.observe('d', [{ id: 'u', createdAt: 1 }]);
  assert.equal(tr.isLate('u', 1), true);
  tr.observe('e', [{ id: 'u', createdAt: 1 }]);
  assert.equal(tr.isLate('u', 1), false);
});
