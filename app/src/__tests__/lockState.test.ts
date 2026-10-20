// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/lockState.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundLock } from '../lockState.ts';

function setup(over = {}) {
  const env = { t: 1_000_000, enabled: true, delay: 0, locks: 0, unlocked: true, ...over };
  const bl = createBackgroundLock({
    now: () => env.t,
    isEnabled: () => env.enabled,
    delaySeconds: () => env.delay,
    onLock: () => { env.locks++; env.unlocked = false; },
  });
  return { env, bl };
}

test('BUG: background -> foreground without killing the app must require auth (immediately)', () => {
  const { env, bl } = setup();
  bl.onAppState('background');
  env.t += 5_000;
  bl.onAppState('active');
  assert.equal(env.unlocked, false);
});

test('immediately: locks while leaving (so the app switcher shows the lock), even if the return event is lost', () => {
  const { env, bl } = setup();
  bl.onAppState('background');
  assert.equal(env.unlocked, false);
});

test('delay: a short absence stays unlocked, a long one locks on return', () => {
  const { env, bl } = setup({ delay: 60 });
  bl.onAppState('background');
  assert.equal(env.unlocked, true);
  env.t += 59_000; bl.onAppState('active');
  assert.equal(env.unlocked, true);
  bl.onAppState('background');
  env.t += 60_000; bl.onAppState('active');
  assert.equal(env.unlocked, false);
});

test('inactive then background counts from the first leave', () => {
  const { env, bl } = setup({ delay: 60 });
  bl.onAppState('inactive');
  env.t += 30_000; bl.onAppState('background');
  env.t += 31_000; bl.onAppState('active');
  assert.equal(env.unlocked, false);
});

test('NO LOOP: events while the OS auth dialog shows do not lock', () => {
  const { env, bl } = setup();
  bl.authBegin();
  bl.onAppState('inactive');
  env.t += 800; bl.onAppState('active');
  bl.authEnd();
  assert.equal(env.locks, 0);
});

test('NO LOOP: a late inactive/active pair right after the dialog closed is still the dialog', () => {
  const { env, bl } = setup();
  bl.authBegin(); bl.authEnd();
  env.t += 300; bl.onAppState('inactive');
  env.t += 300; bl.onAppState('active');
  assert.equal(env.locks, 0);
});

test('after the grace a real leave locks again', () => {
  const { env, bl } = setup();
  bl.authBegin(); bl.authEnd();
  env.t += 5_000; bl.onAppState('background');
  assert.equal(env.unlocked, false);
});

test('lock disabled (scope off / web): nothing happens', () => {
  const { env, bl } = setup({ enabled: false, delay: 0 });
  bl.onAppState('background'); env.t += 99_000; bl.onAppState('active');
  assert.equal(env.locks, 0);
});

test("'active' without a prior leave does nothing", () => {
  const { env, bl } = setup();
  bl.onAppState('active');
  assert.equal(env.locks, 0);
});
