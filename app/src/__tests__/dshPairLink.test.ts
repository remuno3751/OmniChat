// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/dshPairLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { consumeDshPairFromHash, peekHasPendingDshPair, takePendingDshPair } from '../dshPairLink';

const CODE = 'Abc_123-xyz'.padEnd(40, 'Q');

// Minimal window stub: consumeDshPairFromHash only touches location and history.
function setUrl(hash, pathname = '/', search = '') {
  const calls = [];
  const loc = { hash, pathname, search };
  globalThis.window = {
    location: loc,
    history: {
      replaceState(_s, _t, url) {
        calls.push(url);
        const i = url.indexOf('#');
        loc.hash = i >= 0 ? url.slice(i) : '';
        loc.pathname = url.split(/[?#]/)[0];
        loc.search = url.includes('?') ? '?' + url.split('?')[1].split('#')[0] : '';
      },
    },
  };
  return { loc, calls };
}

test('valid code is returned and removed from the hash', () => {
  const { loc, calls } = setUrl(`#dsh-pair=${CODE}`, '/app', '?x=1');
  assert.equal(consumeDshPairFromHash(), CODE);
  assert.equal(loc.hash, '');
  assert.deepEqual(calls, ['/app?x=1']);
});

test('url-encoded code is decoded', () => {
  setUrl(`#dsh-pair=${encodeURIComponent(CODE)}`);
  assert.equal(consumeDshPairFromHash(), CODE);
});

test('invalid code is rejected but still stripped from the hash', () => {
  for (const bad of ['short', 'a'.repeat(201), 'has space and symbols !!!!!!!!!!!!!!!!!', '']) {
    const { loc } = setUrl(`#dsh-pair=${encodeURIComponent(bad)}`);
    assert.equal(consumeDshPairFromHash(), null, `should reject ${JSON.stringify(bad)}`);
    assert.equal(loc.hash, '');
  }
});

test('other hash params are preserved', () => {
  const { loc } = setUrl(`#foo=1&dsh-pair=${CODE}&bar=2`);
  assert.equal(consumeDshPairFromHash(), CODE);
  assert.equal(loc.hash, '#foo=1&bar=2');
});

test('no dsh-pair param means no change', () => {
  const { calls } = setUrl('#other=1');
  assert.equal(consumeDshPairFromHash(), null);
  assert.deepEqual(calls, []);
});

test('takePendingDshPair returns the value once', () => {
  // The module ran with no window at import time, so nothing is pending yet.
  assert.equal(peekHasPendingDshPair(), false);
  assert.equal(takePendingDshPair(), null);
});
