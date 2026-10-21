// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/desktopUpdate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asChannel,
  checkResultText,
  desktopUpdateBridge,
  isPrereleaseVersion,
  parseCheckResult,
  updateActionHintKey,
} from '../desktopUpdate';

test('desktopUpdateBridge needs checkUpdate and openUpdate', () => {
  assert.equal(desktopUpdateBridge(undefined), null);
  assert.equal(desktopUpdateBridge({}), null);
  assert.equal(desktopUpdateBridge({ __OMNICHAT_DESKTOP__: { version: '1' } }), null);
  assert.equal(desktopUpdateBridge({ __OMNICHAT_DESKTOP__: { checkUpdate() {}, openUpdate: 3 } }), null);
  const d = { checkUpdate() {}, openUpdate() {} };
  assert.equal(desktopUpdateBridge({ __OMNICHAT_DESKTOP__: d }), d);
});

test('asChannel accepts only the two channels', () => {
  assert.equal(asChannel('stable'), 'stable');
  assert.equal(asChannel('prerelease'), 'prerelease');
  assert.equal(asChannel('nightly'), null);
  assert.equal(asChannel(null), null);
});

test('parseCheckResult is tolerant', () => {
  const ok = parseCheckResult({ status: 'available', current: '0.4.0', latest: '0.5.0-beta.1', channel: 'prerelease', canInstall: true });
  assert.deepEqual(ok, { status: 'available', current: '0.4.0', latest: '0.5.0-beta.1', channel: 'prerelease', canInstall: true });
  assert.equal(parseCheckResult({ status: 'latest', current: '0.4.0', channel: 'stable', canInstall: false }).status, 'latest');
  for (const bad of [null, undefined, 3, 'x', {}, { status: 'weird' }, { status: 'available', current: '1' }]) {
    const r = parseCheckResult(bad);
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'other');
    assert.equal(r.channel, 'stable');
  }
  assert.equal(parseCheckResult({ status: 'error', error: 'network' }).error, 'network');
});

test('checkResultText maps result to i18n keys', () => {
  assert.deepEqual(
    checkResultText({ status: 'available', current: '1', latest: '2.0.0', channel: 'stable', canInstall: true }),
    { key: 'update.desktop.available', params: { version: '2.0.0' }, danger: false },
  );
  assert.deepEqual(
    checkResultText({ status: 'latest', current: '1.0.0', channel: 'stable', canInstall: false }),
    { key: 'update.desktop.latest', params: { version: '1.0.0' }, danger: false },
  );
  const net = checkResultText({ status: 'error', current: '1', channel: 'stable', canInstall: false, error: 'network' });
  assert.equal(net.key, 'update.err.network');
  assert.equal(net.danger, true);
  assert.equal(checkResultText({ status: 'error', current: '1', channel: 'stable', canInstall: false, error: 'bad-repo' }).key, 'update.err.other');
  assert.equal(checkResultText({ status: 'error', current: '1', channel: 'stable', canInstall: false, error: 'timeout' }).key, 'update.err.other');
});

test('prerelease detection and action hint', () => {
  assert.equal(isPrereleaseVersion('1.0.0-beta.2'), true);
  assert.equal(isPrereleaseVersion('1.0.0'), false);
  assert.equal(isPrereleaseVersion(undefined), false);
  const base = { current: '1', latest: '2', channel: 'stable' };
  assert.equal(updateActionHintKey({ ...base, status: 'available', canInstall: true }), 'update.desktop.installHint');
  assert.equal(updateActionHintKey({ ...base, status: 'available', canInstall: false }), 'update.desktop.pageHint');
  assert.equal(updateActionHintKey({ ...base, status: 'latest', canInstall: false }), null);
});
