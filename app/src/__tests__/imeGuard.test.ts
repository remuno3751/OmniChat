// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/imeGuard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { imeAfter, initialImeState, shouldSwallowEnter, IME_ENTER_WINDOW_MS } from '../imeGuard';

const enter = (time, extra = {}) => ({ key: 'Enter', keyCode: 13, isComposing: false, repeat: false, time, ...extra });

test('a plain Enter with no recent compositionend is never swallowed', () => {
  assert.equal(shouldSwallowEnter(initialImeState(), enter(1000)), false);
  assert.equal(shouldSwallowEnter(initialImeState(), enter(1000, { repeat: true })), false);
});

test('composing text and the IME process key (229) are swallowed', () => {
  const s = initialImeState();
  assert.equal(shouldSwallowEnter(s, enter(1000, { isComposing: true })), true);
  assert.equal(shouldSwallowEnter(s, { key: 'Process', keyCode: 229, isComposing: false, time: 1000 }), true);
  assert.equal(shouldSwallowEnter(s, { key: 'Unidentified', keyCode: 229, isComposing: false, time: 1000 }), true);
  // keyCode 229 alone (key is a real key) is not enough
  assert.equal(shouldSwallowEnter(s, { key: 'a', keyCode: 229, isComposing: false, time: 1000 }), false);
});

test('the first Enter within the window after compositionend is swallowed, then the flag is consumed', () => {
  let s = imeAfter(initialImeState(), 'compositionend', 1000);
  assert.equal(shouldSwallowEnter(s, enter(1000 + IME_ENTER_WINDOW_MS)), true);
  s = imeAfter(s, 'keydown', 1005);
  // the next Enter (a real one, typed later) is not swallowed
  assert.equal(shouldSwallowEnter(s, enter(1010)), false);
});

test('an Enter after the window is not swallowed', () => {
  const s = imeAfter(initialImeState(), 'compositionend', 1000);
  assert.equal(shouldSwallowEnter(s, enter(1000 + IME_ENTER_WINDOW_MS + 1)), false);
});

test('a keydown that is not Enter consumes the compositionend flag too', () => {
  let s = imeAfter(initialImeState(), 'compositionend', 1000);
  s = imeAfter(s, 'keydown', 1002); // a letter typed right after the conversion
  assert.equal(shouldSwallowEnter(s, enter(1003)), false);
});

test('a keyup consumes the flag, so a later Enter is never swallowed', () => {
  let s = imeAfter(initialImeState(), 'compositionend', 1000);
  s = imeAfter(s, 'keyup', 1001);
  assert.equal(shouldSwallowEnter(s, enter(1002)), false);
});

test('a compositionend that is never followed by a keydown does not swallow a later Enter', () => {
  const s = imeAfter(initialImeState(), 'compositionend', 1000);
  // a new compositionend replaces the old one; an Enter far later is not swallowed
  assert.equal(shouldSwallowEnter(imeAfter(s, 'compositionend', 5000), enter(9000)), false);
});
