// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: npx tsx --test src/__tests__/versionDisplay.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutVersionLine, clientVersionLine, normalizeDesktopVersion } from '../clientVersion';
import { isPrereleaseNewerThan } from '../updateState';
import { permissionWordKey } from '../notifyPermission';

test('normalizeDesktopVersion maps the Windows numeric pre-release suffix back to beta.N', () => {
  assert.equal(normalizeDesktopVersion('0.5.5-2'), '0.5.5-beta.2');
  assert.equal(normalizeDesktopVersion(' 0.5.5-2 '), '0.5.5-beta.2');
  assert.equal(normalizeDesktopVersion('0.5.5-beta.2'), '0.5.5-beta.2');
  assert.equal(normalizeDesktopVersion('0.5.4'), '0.5.4');
  assert.equal(normalizeDesktopVersion('1.0.0-rc.1'), '1.0.0-rc.1');
});

test('clientVersionLine: desktop shows the normalized shell version, web without a shell keeps the app version', () => {
  assert.deepEqual(clientVersionLine('web', '1.0.0', '0.5.5-2'), { key: 'update.desktopVersion', version: '0.5.5-beta.2' });
  assert.deepEqual(clientVersionLine('web', '1.0.0', null), { key: 'update.webVersion', version: '1.0.0' });
  assert.deepEqual(clientVersionLine('android', '1.0.0', '0.5.5-2'), { key: 'update.appVersion', version: '1.0.0' });
});

test('aboutVersionLine drops the platform suffix on desktop', () => {
  assert.deepEqual(aboutVersionLine('web', '1.0.0', '0.5.5-2'), { key: 'general.aboutVersionPlain', params: { version: '0.5.5-beta.2' } });
  assert.deepEqual(aboutVersionLine('web', '1.0.0', null), { key: 'general.aboutVersion', params: { version: '1.0.0', platform: 'web' } });
  assert.deepEqual(aboutVersionLine('ios', '1.2.3'), { key: 'general.aboutVersion', params: { version: '1.2.3', platform: 'ios' } });
});

test('isPrereleaseNewerThan: installed pre-release above the latest stable', () => {
  assert.equal(isPrereleaseNewerThan('0.5.5-beta.2', '0.5.4'), true);
  assert.equal(isPrereleaseNewerThan('0.5.5-2', '0.5.4'), true); // raw Windows form also ranks as a pre-release
  assert.equal(isPrereleaseNewerThan('0.5.4-beta.6', '0.5.4'), false); // older pre-release of the same core
  assert.equal(isPrereleaseNewerThan('0.5.5-beta.2', '0.5.5'), false); // stable of the same core is newer
  assert.equal(isPrereleaseNewerThan('0.5.5-beta.2', '0.5.5-beta.2'), false);
  assert.equal(isPrereleaseNewerThan('0.5.4', '0.5.3'), false); // stable installed: not a pre-release
  assert.equal(isPrereleaseNewerThan('0.5.5-beta.10', '0.5.5-beta.9'), true);
  assert.equal(isPrereleaseNewerThan('bad', '0.5.4'), false);
  assert.equal(isPrereleaseNewerThan('0.5.5-beta.2', 'nope'), false);
});

test('permissionWordKey maps Notification permission states to Japanese words', () => {
  assert.equal(permissionWordKey('granted'), 'notify.perm.granted');
  assert.equal(permissionWordKey('denied'), 'notify.perm.denied');
  assert.equal(permissionWordKey('default'), 'notify.perm.default');
  assert.equal(permissionWordKey('unsupported'), null);
});
