// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/deviceSettingsDsh.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_DEFAULTS, getDevice, setDevice } from '../deviceSettings';

test('dsh defaults', () => {
  assert.deepEqual(DEVICE_DEFAULTS.dsh, { enabled: false, port: 19401, pairing: '', bridgeName: 'my-pc' });
});

test('port is an integer clamped to 1..65535, NaN falls back to the default', () => {
  setDevice({ dsh: { port: 99999 } });
  assert.equal(getDevice().dsh.port, 65535);
  setDevice({ dsh: { port: 0 } });
  assert.equal(getDevice().dsh.port, 1);
  setDevice({ dsh: { port: 1234.6 } });
  assert.equal(getDevice().dsh.port, 1235);
  setDevice({ dsh: { port: Number.NaN } });
  assert.equal(getDevice().dsh.port, 19401);
});

test('pairing is trimmed and limited to 200 chars', () => {
  setDevice({ dsh: { pairing: '  abc  ' } });
  assert.equal(getDevice().dsh.pairing, 'abc');
  setDevice({ dsh: { pairing: 'x'.repeat(500) } });
  assert.equal(getDevice().dsh.pairing.length, 200);
});

test('empty or blank bridgeName falls back to my-pc', () => {
  setDevice({ dsh: { bridgeName: '   ' } });
  assert.equal(getDevice().dsh.bridgeName, 'my-pc');
  setDevice({ dsh: { bridgeName: ' office-pc ' } });
  assert.equal(getDevice().dsh.bridgeName, 'office-pc');
});

test('dsh patches merge deeply and leave other settings alone', () => {
  setDevice({ dsh: { port: 20000, pairing: 'p', bridgeName: 'b' } });
  setDevice({ dsh: { enabled: true } });
  const d = getDevice();
  assert.deepEqual(d.dsh, { enabled: true, port: 20000, pairing: 'p', bridgeName: 'b' });
  setDevice({ fontSize: 18 });
  assert.equal(getDevice().fontSize, 18);
  assert.equal(getDevice().dsh.port, 20000);
});
