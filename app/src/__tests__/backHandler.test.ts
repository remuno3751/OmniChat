// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BACK_PRIORITY as P, backDepth, registerBack, resetBackForTests, runBack } from '../backHandler';

beforeEach(() => resetBackForTests());

test('highest priority closes first, then the next press goes down the stack', () => {
  const log: string[] = [];
  const offs: (() => void)[] = [];
  offs.push(registerBack(P.ROOT, () => { log.push('exit'); }));
  offs.push(registerBack(P.SCREEN, () => { log.push('screen'); }));
  offs.push(registerBack(P.DRAWER, () => { log.push('drawer'); }));
  offs.push(registerBack(P.POPUP, () => { log.push('popup'); }));
  // a closed overlay unregisters itself (its component state flips), exposing the next one
  for (let i = 3; i >= 0; i--) { assert.equal(runBack(), true); offs[i](); }
  assert.deepEqual(log, ['popup', 'drawer', 'screen', 'exit']);
});
test('equal priority: most recent first; unregister removes', () => {
  const log: string[] = [];
  registerBack(P.POPUP, () => { log.push('a'); });
  const off = registerBack(P.POPUP, () => { log.push('b'); });
  runBack(); off(); runBack();
  assert.deepEqual(log, ['b', 'a']);
  assert.equal(backDepth(), 1);
});
test('a handler returning false passes the press on; nothing registered = unhandled', () => {
  assert.equal(runBack(), false);
  const log: string[] = [];
  registerBack(P.SCREEN, () => { log.push('screen'); });
  registerBack(P.PANEL, () => { log.push('panel-pass'); return false; });
  assert.equal(runBack(), true);
  assert.deepEqual(log, ['panel-pass', 'screen']);
});
test('a throwing handler does not break the chain... it counts as handled', () => {
  registerBack(P.POPUP, () => { throw new Error('x'); });
  assert.equal(runBack(), true);
});
