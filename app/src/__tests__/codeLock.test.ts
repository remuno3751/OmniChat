// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeLock.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CODE_LOCK_DEFAULTS, afterFailure, lockoutMs, lockoutRemainingMs, normalizeCodeLock, shouldRequireUnlock,
} from '../codeLock.ts';
import { hashPin, isValidPin, newSalt, sha256, toHex, utf8, verifyPin } from '../pinHash.ts';

const SALT = '00112233445566778899aabbccddeeff';
const T0 = 1_000_000_000_000; // arbitrary epoch ms
const START = T0 - 10 * 60 * 1000; // app run started 10 minutes before T0

// ---- (a) shouldRequireUnlock ---------------------------------------------------------------------

const req = (over) => shouldRequireUnlock({ enabled: true, relockSeconds: 300, unlockedAt: T0, now: T0, appSessionStart: START, ...over });

test('lock off: never required, whatever the rest says', () => {
  assert.equal(req({ enabled: false, unlockedAt: null }), false);
  assert.equal(req({ enabled: false, relockSeconds: 0 }), false);
  assert.equal(req({ enabled: false, relockSeconds: 60, unlockedAt: T0 - 9e9 }), false);
});

test('never unlocked in this run: required (any relock option)', () => {
  for (const rs of [0, 60, 300, 900, -1]) {
    assert.equal(req({ relockSeconds: rs, unlockedAt: null }), true, `relock ${rs}`);
  }
});

test('0 = every time, even right after the unlock', () => {
  assert.equal(req({ relockSeconds: 0, unlockedAt: T0, now: T0 }), true);
  assert.equal(req({ relockSeconds: 0, unlockedAt: T0 - 1000, now: T0 }), true);
});

test('-1 = not required again within the same app run, required after a restart', () => {
  assert.equal(req({ relockSeconds: -1, unlockedAt: T0, now: T0 + 99 * 3600e3 }), false);
  assert.equal(req({ relockSeconds: -1, unlockedAt: START - 1, now: T0 }), true);
});

test('60 / 300 / 900: boundaries (exactly at the limit is not yet required, one ms over is)', () => {
  for (const sec of [60, 300, 900]) {
    assert.equal(req({ relockSeconds: sec, unlockedAt: T0, now: T0 + sec * 1000 }), false, `${sec}s at limit`);
    assert.equal(req({ relockSeconds: sec, unlockedAt: T0, now: T0 + sec * 1000 + 1 }), true, `${sec}s over by 1ms`);
    assert.equal(req({ relockSeconds: sec, unlockedAt: T0, now: T0 + sec * 1000 - 1 }), false, `${sec}s under`);
  }
});

test('the clock moving backwards does not force a lock', () => {
  assert.equal(req({ relockSeconds: 60, unlockedAt: T0, now: T0 - 5000 }), false);
});

// ---- (b) pin hashing -----------------------------------------------------------------------------

test('sha256 matches the standard test vectors (empty, "abc", a two-block message)', () => {
  assert.equal(toHex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    toHex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('sha256 agrees with node:crypto on messages of many lengths (padding edge cases)', () => {
  for (let n = 0; n <= 130; n++) {
    const s = 'x'.repeat(n);
    assert.equal(toHex(sha256(utf8(s))), createHash('sha256').update(s).digest('hex'), `len ${n}`);
  }
});

test('hashPin is the 10,000-round chain over (salt || pin), as documented', () => {
  const sp = Buffer.from(SALT + '1234', 'utf8');
  let d = createHash('sha256').update(sp).digest();
  for (let i = 1; i < 10000; i++) d = createHash('sha256').update(Buffer.concat([d, sp])).digest();
  assert.equal(hashPin('1234', SALT), d.toString('hex'));
});

test('same PIN and salt give the same hash; a different PIN does not', () => {
  const h = hashPin('123456', SALT);
  assert.equal(h, hashPin('123456', SALT));
  assert.notEqual(h, hashPin('123457', SALT));
  assert.equal(h.length, 64);
  assert.doesNotMatch(h, /123456/);
});

test('a different salt gives a different hash for the same PIN', () => {
  assert.notEqual(hashPin('1234', SALT), hashPin('1234', 'ffeeddccbbaa99887766554433221100'));
});

test('verifyPin: right PIN passes, wrong PIN and malformed input fail', () => {
  const h = hashPin('4321', SALT);
  assert.equal(verifyPin('4321', SALT, h), true);
  assert.equal(verifyPin('4322', SALT, h), false);
  assert.equal(verifyPin('432', SALT, h), false);
  const bad = h.slice(0, 63) + (h[63] === '0' ? '1' : '0');
  assert.equal(verifyPin('4321', SALT, bad), false);
  assert.equal(verifyPin('4321', SALT, ''), false);
  assert.equal(verifyPin('abcd', SALT, h), false);
});

test('isValidPin: 4 to 8 digits only', () => {
  assert.equal(isValidPin('1234'), true);
  assert.equal(isValidPin('12345678'), true);
  assert.equal(isValidPin('123'), false);
  assert.equal(isValidPin('123456789'), false);
  assert.equal(isValidPin('12a4'), false);
  assert.equal(isValidPin(' 1234'), false);
});

test('newSalt: 32 hex characters, and two calls differ', () => {
  const a = newSalt();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newSalt());
});

// ---- (c) failures and waiting time ---------------------------------------------------------------

test('no wait for the first four wrong PINs', () => {
  for (let n = 0; n <= 4; n++) assert.equal(lockoutMs(n), 0, `failCount ${n}`);
});

test('the fifth wrong PIN gives 30 s, then the wait doubles on each failure, capped at 15 min', () => {
  assert.equal(lockoutMs(5), 30_000);
  assert.equal(lockoutMs(6), 60_000);
  assert.equal(lockoutMs(7), 120_000);
  assert.equal(lockoutMs(8), 240_000);
  assert.equal(lockoutMs(9), 480_000);
  assert.equal(lockoutMs(10), 900_000); // 960 s would be doubled again, capped at 900 s
  assert.equal(lockoutMs(11), 900_000);
  assert.equal(lockoutMs(50), 900_000);
});

test('afterFailure counts up and sets lockedUntil only from the fifth failure', () => {
  assert.deepEqual(afterFailure({ failCount: 3 }, T0), { failCount: 4, lockedUntil: 0 });
  assert.deepEqual(afterFailure({ failCount: 4 }, T0), { failCount: 5, lockedUntil: T0 + 30_000 });
  assert.deepEqual(afterFailure({ failCount: 5 }, T0), { failCount: 6, lockedUntil: T0 + 60_000 });
});

test('lockoutRemainingMs: zero when not locked or when the time has passed', () => {
  assert.equal(lockoutRemainingMs(0, T0), 0);
  assert.equal(lockoutRemainingMs(T0 - 1, T0), 0);
  assert.equal(lockoutRemainingMs(T0 + 30_000, T0), 30_000);
});

// ---- (d) stored values fall back to defaults -----------------------------------------------------

test('normalizeCodeLock: missing or broken values become the defaults', () => {
  assert.deepEqual(normalizeCodeLock(undefined), CODE_LOCK_DEFAULTS);
  assert.deepEqual(normalizeCodeLock('nope'), CODE_LOCK_DEFAULTS);
  assert.deepEqual(normalizeCodeLock({ scope: 'x', enabled: 'yes', backgroundLockSeconds: 7, relockSeconds: 42, failCount: -1, lockedUntil: 'x' }), CODE_LOCK_DEFAULTS);
  assert.deepEqual(normalizeCodeLock({ failCount: 1.5 }), CODE_LOCK_DEFAULTS);
  assert.equal(normalizeCodeLock({}).relockSeconds, -1);
});

test('normalizeCodeLock: a PIN salt or hash that is malformed is dropped, and a lone half is dropped too', () => {
  const hash = hashPin('1234', SALT);
  assert.deepEqual(normalizeCodeLock({ pinSalt: 'zz', pinHash: hash }), { ...CODE_LOCK_DEFAULTS, pinSalt: null, pinHash: null });
  assert.deepEqual(normalizeCodeLock({ pinSalt: SALT, pinHash: null }).pinSalt, null);
  const ok = normalizeCodeLock({ pinSalt: SALT, pinHash: hash, failCount: 2, lockedUntil: T0 });
  assert.equal(ok.pinSalt, SALT);
  assert.equal(ok.pinHash, hash);
  assert.equal(ok.failCount, 2);
  assert.equal(ok.lockedUntil, T0);
});

test('normalizeCodeLock: only the listed relock options survive', () => {
  for (const rs of [0, 60, 300, 900, -1]) assert.equal(normalizeCodeLock({ relockSeconds: rs }).relockSeconds, rs);
  for (const rs of [30, 120, 3600, '60', null]) assert.equal(normalizeCodeLock({ relockSeconds: rs }).relockSeconds, -1, String(rs));
});

test('device settings: a broken stored codeLock loads as the defaults (through the public module)', async () => {
  const realGet = AsyncStorage.getItem;
  const realSet = AsyncStorage.setItem;
  AsyncStorage.getItem = async (key) => (key === 'omnichat.device'
    ? JSON.stringify({ codeLock: { scope: 5, enabled: 'maybe', relockSeconds: 7, pinSalt: 'bad', pinHash: 'bad', failCount: 'x' } })
    : null);
  AsyncStorage.setItem = async () => {};
  try {
    const mod = await import('../deviceSettings.ts?codelock=1');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(mod.getDevice().codeLock, CODE_LOCK_DEFAULTS);
  } finally {
    AsyncStorage.getItem = realGet;
    AsyncStorage.setItem = realSet;
  }
});


// ---- (d) scope and legacy `enabled` ----------------------------------------------------------------

test('scope: legacy boolean enabled maps to code / off; default is code (existing users unchanged)', () => {
  assert.equal(normalizeCodeLock({ enabled: true }).scope, 'code');
  assert.equal(normalizeCodeLock({ enabled: false }).scope, 'off');
  assert.equal(normalizeCodeLock({}).scope, 'code');
  assert.equal(normalizeCodeLock({ scope: 'app', enabled: false }).scope, 'app');
  assert.equal(normalizeCodeLock({ scope: 'bogus', enabled: false }).scope, 'off');
});

test('backgroundLockSeconds: only 0/60/300/900, default 0 (immediately)', () => {
  for (const v of [0, 60, 300, 900]) assert.equal(normalizeCodeLock({ backgroundLockSeconds: v }).backgroundLockSeconds, v);
  for (const v of [-1, 30, '60', null]) assert.equal(normalizeCodeLock({ backgroundLockSeconds: v }).backgroundLockSeconds, 0);
});
