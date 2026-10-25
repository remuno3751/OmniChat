// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: npx tsx --test src/__tests__/deviceList.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STALE_DEVICE_MS, addHiddenDevice, bridgeNameOfDevice, groupDevicesByName, isStaleDevice, parseHiddenDevices, staleDevices } from '../deviceList';

const NOW = Date.UTC(2026, 9, 24);
const dev = (id, name, lastSeenAt, current = false) => ({ id, name, platform: 'vscode-ext', createdAt: 0, lastSeenAt, current });

test('groupDevicesByName collapses same names; the most recently seen is primary', () => {
  const g = groupDevicesByName([
    dev('a', 'VS Code (my-pc)', NOW - 5000),
    dev('b', 'VS Code (test)', NOW - 9000),
    dev('c', 'VS Code (my-pc)', NOW - 100),
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].name, 'VS Code (my-pc)');
  assert.equal(g[0].count, 2);
  assert.equal(g[0].primary.id, 'c');
  assert.deepEqual(g[0].ids.sort(), ['a', 'c']);
  assert.equal(g[1].count, 1);
});

test('groupDevicesByName puts the current device first even when it was seen earlier', () => {
  const g = groupDevicesByName([dev('x', 'Phone', NOW, false), dev('y', 'Phone', NOW - 10, true), dev('z', 'Other', NOW + 5)]);
  assert.equal(g[0].primary.id, 'y');
  assert.equal(g[0].count, 2);
  assert.equal(g[1].name, 'Other');
});

test('isStaleDevice: not current and not seen for 30 days', () => {
  assert.equal(isStaleDevice(dev('a', 'x', NOW - STALE_DEVICE_MS), NOW), true);
  assert.equal(isStaleDevice(dev('a', 'x', NOW - STALE_DEVICE_MS + 1), NOW), false);
  assert.equal(isStaleDevice(dev('a', 'x', NOW - STALE_DEVICE_MS - 1, true), NOW), false);
});

test('staleDevices keeps only stale ones', () => {
  const list = [dev('old', 'VS Code (test)', NOW - 40 * 24 * 3600_000), dev('new', 'VS Code (my-pc)', NOW - 1000), dev('me', 'Here', NOW - 99 * 24 * 3600_000, true)];
  assert.deepEqual(staleDevices(list, NOW).map((d) => d.id), ['old']);
  assert.deepEqual(staleDevices([], NOW), []);
});

test('bridgeNameOfDevice reads the name the server gives bridge devices', () => {
  assert.equal(bridgeNameOfDevice('VS Code (my-pc)'), 'my-pc');
  assert.equal(bridgeNameOfDevice('DSH plugin (office PC)'), 'office PC');
  assert.equal(bridgeNameOfDevice('iPhone'), null);
  assert.equal(bridgeNameOfDevice('VS Code ()'), null);
});

test('parseHiddenDevices and addHiddenDevice tolerate bad stored data', () => {
  assert.deepEqual(parseHiddenDevices(null), []);
  assert.deepEqual(parseHiddenDevices('{not json'), []);
  assert.deepEqual(parseHiddenDevices('{"a":1}'), []);
  assert.deepEqual(parseHiddenDevices('["VS Code (test)", 3, "", "VS Code (test)", null]'), ['VS Code (test)']);
  assert.deepEqual(addHiddenDevice(['a'], 'a'), ['a']);
  assert.deepEqual(addHiddenDevice(['a'], 'b'), ['a', 'b']);
});
