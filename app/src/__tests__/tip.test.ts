// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIP_DELAY_MS, canHover, createTip } from '../tip';

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    timers: {
      set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
      clear: (id) => pending.delete(id),
    },
    pending,
    fire() { for (const [id, p] of [...pending]) { pending.delete(id); p.fn(); } },
  };
}

test('delay is 2 seconds', () => {
  assert.equal(TIP_DELAY_MS, 2000);
});

test('canHover: web with fine hover pointer only', () => {
  const win = (matches) => ({ matchMedia: (q) => { assert.equal(q, '(hover: hover) and (pointer: fine)'); return { matches }; } });
  assert.equal(canHover('web', win(true)), true);
  assert.equal(canHover('web', win(false)), false);
  assert.equal(canHover('ios', win(true)), false);
  assert.equal(canHover('android', win(true)), false);
});

test('canHover is safe without matchMedia', () => {
  assert.equal(canHover('web', {}), false);
  assert.equal(canHover('web', undefined), false);
  assert.equal(canHover('web', { matchMedia: () => { throw new Error('boom'); } }), false);
});

test('shows only after the delay; leave before it cancels', () => {
  const ft = fakeTimers();
  const seen = [];
  const tip = createTip((o) => seen.push(o), ft.timers, TIP_DELAY_MS);
  tip.enter();
  assert.equal(ft.pending.size, 1);
  assert.equal(ft.pending.values().next().value.ms, 2000);
  tip.leave();
  assert.equal(ft.pending.size, 0);
  assert.deepEqual(seen, []);
});

test('enter then delay opens; leave closes; no duplicate callbacks', () => {
  const ft = fakeTimers();
  const seen = [];
  const tip = createTip((o) => seen.push(o), ft.timers);
  tip.enter();
  ft.fire();
  assert.equal(tip.isOpen, true);
  tip.enter();
  assert.equal(ft.pending.size, 0);
  tip.leave();
  tip.leave();
  assert.deepEqual(seen, [true, false]);
});

test('press and scroll (hide) close an open tip at once', () => {
  const ft = fakeTimers();
  const seen = [];
  const tip = createTip((o) => seen.push(o), ft.timers);
  tip.enter();
  ft.fire();
  tip.hide();
  assert.equal(tip.isOpen, false);
  tip.enter();
  tip.hide();
  assert.equal(ft.pending.size, 0);
  assert.deepEqual(seen, [true, false]);
});

test('only one tip is visible at a time', () => {
  const ft = fakeTimers();
  const a = [];
  const b = [];
  const tipA = createTip((o) => a.push(o), ft.timers);
  const tipB = createTip((o) => b.push(o), ft.timers);
  tipA.enter();
  ft.fire();
  tipB.enter();
  ft.fire();
  assert.equal(tipA.isOpen, false);
  assert.equal(tipB.isOpen, true);
  assert.deepEqual(a, [true, false]);
  assert.deepEqual(b, [true]);
});

test('dispose clears a pending timer', () => {
  const ft = fakeTimers();
  const tip = createTip(() => {}, ft.timers);
  tip.enter();
  tip.dispose();
  assert.equal(ft.pending.size, 0);
});
