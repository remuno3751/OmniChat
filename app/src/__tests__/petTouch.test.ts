// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/petTouch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANCEL_MOVE_PX, LONG_PRESS_MS, reduceTouch, touchMayBeTaken } from '../petTouch.ts';

test('long press is 450 ms and the cancel distance is 8 px', () => {
  assert.equal(LONG_PRESS_MS, 450);
  assert.equal(CANCEL_MOVE_PX, 8);
});

test('a still press followed by a long press enters move mode with a vibration', () => {
  let s = reduceTouch('idle', { type: 'down' });
  assert.deepEqual(s, { phase: 'pressing', effect: null });
  s = reduceTouch(s.phase, { type: 'move', dx: 3, dy: 4 }); // 5 px: still a press
  assert.equal(s.phase, 'pressing');
  s = reduceTouch(s.phase, { type: 'longPress' });
  assert.deepEqual(s, { phase: 'moving', effect: 'vibrate' });
});

test('moving the finger more than 8 px before the long press cancels it', () => {
  const s = reduceTouch('pressing', { type: 'move', dx: 6, dy: 6 }); // hypot 8.49
  assert.deepEqual(s, { phase: 'idle', effect: 'cancelLongPress' });
  // a later long press does nothing once cancelled
  assert.deepEqual(reduceTouch(s.phase, { type: 'longPress' }), { phase: 'idle', effect: null });
});

test('exactly 8 px does not cancel', () => {
  assert.equal(reduceTouch('pressing', { type: 'move', dx: 8, dy: 0 }).phase, 'pressing');
});

test('moves while moving keep the move mode and have no effect', () => {
  assert.deepEqual(reduceTouch('moving', { type: 'move', dx: 200, dy: -40 }), { phase: 'moving', effect: null });
});

test('a short tap (release before the long press) waves', () => {
  assert.deepEqual(reduceTouch('pressing', { type: 'up' }), { phase: 'idle', effect: 'tap' });
});

test('releasing in move mode saves the position', () => {
  assert.deepEqual(reduceTouch('moving', { type: 'up' }), { phase: 'idle', effect: 'save' });
  assert.deepEqual(reduceTouch('moving', { type: 'terminate' }), { phase: 'idle', effect: 'save' });
});

test('a terminated press cancels the long press without a tap', () => {
  assert.deepEqual(reduceTouch('pressing', { type: 'terminate' }), { phase: 'idle', effect: 'cancelLongPress' });
});

test('a cancelled touch that is released is not a tap', () => {
  const s = reduceTouch('pressing', { type: 'move', dx: 20, dy: 0 });
  assert.deepEqual(reduceTouch(s.phase, { type: 'up' }), { phase: 'idle', effect: null });
});

test('the responder may be taken away only when the pet is not moving', () => {
  assert.equal(touchMayBeTaken('idle'), true);
  assert.equal(touchMayBeTaken('pressing'), true);
  assert.equal(touchMayBeTaken('moving'), false);
});
