// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/updateState.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REMIND_LATER_MS,
  canApkUpdate,
  compareSemver,
  decidePopup,
  emptyUpdateState,
  failureDismissKey,
  loadUpdateState,
  parseUpdateState,
  remindLater,
  serializeUpdateState,
  serverVersionChanged,
  skipVersion,
  unskipVersion,
  updateErrorText,
} from '../updateState';

const DAY = 24 * 3600_000;
const NOW = 1_800_000_000_000;

function release(version) {
  return {
    tag: `v${version}`,
    version,
    name: version,
    notes: '',
    prerelease: version.includes('-'),
    publishedAt: '2026-10-01T00:00:00Z',
    htmlUrl: 'https://example.invalid/r',
    assets: [],
  };
}

/** A status where an update to 1.1.0 is available and can be applied in place. */
function status(over = {}) {
  return {
    current: '1.0.0',
    installType: 'server-app',
    selfUpdate: true,
    selfUpdateReason: null,
    dockerCommand: null,
    channel: 'stable',
    checkHours: 12,
    tokenSet: false,
    latest: release('1.1.0'),
    updateAvailable: true,
    skipped: false,
    skippedVersions: [],
    bundleAssetFound: true,
    lastCheckedAt: NOW,
    lastError: null,
    phase: 'idle',
    progress: null,
    lastApply: null,
    plugin: null,
    isAdmin: true,
    ...over,
  };
}

function decide(over = {}) {
  return decidePopup({
    status: status(),
    device: emptyUpdateState(),
    now: NOW,
    isAdmin: true,
    sessionDismissed: [],
    ...over,
  });
}

// ---- skip / unskip -------------------------------------------------------

test('skipVersion adds once and is idempotent (same object returned)', () => {
  const s0 = emptyUpdateState();
  const s1 = skipVersion(s0, '1.1.0');
  assert.deepEqual(s1.skipped, ['1.1.0']);
  const s2 = skipVersion(s1, '1.1.0');
  assert.equal(s2, s1);
  assert.deepEqual(s2.skipped, ['1.1.0']);
  assert.equal(s0.skipped.length, 0, 'input is not mutated');
});

test('skipVersion ignores invalid version strings', () => {
  const s0 = emptyUpdateState();
  assert.equal(skipVersion(s0, ''), s0);
  assert.equal(skipVersion(s0, 'has space'), s0);
});

test('unskipVersion removes and is idempotent', () => {
  const s1 = skipVersion(emptyUpdateState(), '1.1.0');
  const s2 = unskipVersion(s1, '1.1.0');
  assert.deepEqual(s2.skipped, []);
  const s3 = unskipVersion(s2, '1.1.0');
  assert.equal(s3, s2);
  assert.equal(unskipVersion(emptyUpdateState(), '9.9.9').skipped.length, 0);
});

test('skip then unskip restores the same content', () => {
  const s0 = { ...emptyUpdateState(), skipped: ['1.0.5'] };
  const s = unskipVersion(skipVersion(s0, '1.1.0'), '1.1.0');
  assert.deepEqual(s, s0);
});

// ---- remind later window ----------------------------------------------------

test('remindLater: popup suppressed just before 24h, shown just after', () => {
  assert.equal(REMIND_LATER_MS, DAY);
  const s = remindLater(emptyUpdateState(), '1.1.0', NOW);
  assert.equal(s.remindAfter['1.1.0'], NOW + DAY);
  assert.equal(decide({ device: s, now: NOW + DAY - 1 }).kind, 'none');
  assert.equal(decide({ device: s, now: NOW + DAY - 60_000 }).kind, 'none');
  assert.deepEqual(decide({ device: s, now: NOW + DAY + 1 }), { kind: 'update', version: '1.1.0' });
});

test('remindLater: exactly at the boundary the popup is shown again (suppressed while now < until)', () => {
  const s = remindLater(emptyUpdateState(), '1.1.0', NOW);
  assert.equal(decide({ device: s, now: NOW + DAY }).kind, 'update');
});

test('remindLater only affects its own version', () => {
  const s = remindLater(emptyUpdateState(), '1.2.0', NOW);
  assert.equal(decide({ device: s, now: NOW + 1 }).kind, 'update');
});

// ---- decidePopup truth table ------------------------------------------------

test('no status -> none', () => {
  assert.deepEqual(decide({ status: null }), { kind: 'none' });
});

test('non-admin never gets an update popup or a failure popup', () => {
  assert.deepEqual(decide({ isAdmin: false }), { kind: 'none' });
  const failed = status({
    isAdmin: false,
    lastApply: { status: 'failed', version: '1.1.0', message: 'x', at: NOW, acknowledged: false, rolledBack: true },
  });
  assert.deepEqual(decide({ status: failed, isAdmin: false }), { kind: 'none' });
});

test('admin with an available self-update -> update popup for the latest version', () => {
  assert.deepEqual(decide(), { kind: 'update', version: '1.1.0' });
});

test('updateAvailable false -> none', () => {
  assert.deepEqual(decide({ status: status({ updateAvailable: false }) }), { kind: 'none' });
});

test('updateAvailable true but latest null -> none', () => {
  assert.deepEqual(decide({ status: status({ latest: null }) }), { kind: 'none' });
});

test('server-skipped version -> none', () => {
  assert.deepEqual(decide({ status: status({ skipped: true, skippedVersions: ['1.1.0'] }) }), { kind: 'none' });
});

test('device-skipped version -> none; a different device skip does not hide it', () => {
  const dev = skipVersion(emptyUpdateState(), '1.1.0');
  assert.deepEqual(decide({ device: dev }), { kind: 'none' });
  assert.deepEqual(decide({ device: skipVersion(emptyUpdateState(), '1.2.0') }), { kind: 'update', version: '1.1.0' });
});

test('session dismissed version -> none', () => {
  assert.deepEqual(decide({ sessionDismissed: ['1.1.0'] }), { kind: 'none' });
  assert.deepEqual(decide({ sessionDismissed: ['1.0.9'] }), { kind: 'update', version: '1.1.0' });
});

test('selfUpdate false on a non-docker install -> none', () => {
  const st = status({ selfUpdate: false, selfUpdateReason: 'launcher predates the update system' });
  assert.deepEqual(decide({ status: st }), { kind: 'none' });
});

test('selfUpdate true but no bundle asset -> none', () => {
  assert.deepEqual(decide({ status: status({ bundleAssetFound: false }) }), { kind: 'none' });
});

test('docker install -> update popup (command is shown by the UI), even with selfUpdate false', () => {
  const st = status({
    installType: 'docker',
    selfUpdate: false,
    bundleAssetFound: false,
    dockerCommand: 'docker compose pull && docker compose up -d',
  });
  assert.deepEqual(decide({ status: st }), { kind: 'update', version: '1.1.0' });
});

test('failure popup: failed and not acknowledged, admin -> failure with message and version', () => {
  const st = status({
    lastApply: { status: 'failed', version: '1.1.0', message: 'did not start', at: NOW, acknowledged: false, rolledBack: true },
  });
  assert.deepEqual(decide({ status: st }), { kind: 'failure', message: 'did not start', version: '1.1.0' });
});

test('failure popup wins over the update popup', () => {
  const st = status({
    lastApply: { status: 'failed', version: '1.0.5', message: 'm', at: NOW, acknowledged: false },
  });
  assert.equal(decide({ status: st }).kind, 'failure');
});

test('acknowledged failure -> no failure popup, falls through to the update rules', () => {
  const st = status({
    lastApply: { status: 'failed', version: '1.0.5', message: 'm', at: NOW, acknowledged: true },
  });
  assert.deepEqual(decide({ status: st }), { kind: 'update', version: '1.1.0' });
});

test('successful apply -> no failure popup', () => {
  const st = status({
    updateAvailable: false,
    lastApply: { status: 'ok', version: '1.0.0', message: 'ok', at: NOW, acknowledged: false },
  });
  assert.deepEqual(decide({ status: st }), { kind: 'none' });
});

test('failure popup dismissed this session -> not shown (key failureDismissKey)', () => {
  const st = status({
    lastApply: { status: 'failed', version: '1.1.0', message: 'm', at: NOW, acknowledged: false },
  });
  assert.equal(failureDismissKey('1.1.0'), 'failure:1.1.0');
  assert.equal(decide({ status: st, sessionDismissed: ['failure:1.1.0'] }).kind, 'update');
});

test('non-admin failure is not shown even when dismissal is absent', () => {
  const st = status({
    isAdmin: false,
    lastApply: { status: 'failed', version: '1.1.0', message: 'm', at: NOW, acknowledged: false },
  });
  assert.equal(decide({ status: st, isAdmin: false }).kind, 'none');
});

// ---- loadUpdateState tolerance ----------------------------------------------

test('loadUpdateState on garbage never throws and yields the empty state', () => {
  const garbage = [null, undefined, 0, 42, NaN, true, 'text', '', [], [1, 2], () => 1, Symbol.iterator];
  for (const g of garbage) {
    assert.deepEqual(loadUpdateState(g), emptyUpdateState(), `input ${String(g)}`);
  }
});

test('loadUpdateState on an empty object gives the empty state', () => {
  assert.deepEqual(loadUpdateState({}), emptyUpdateState());
});

test('wrong typed fields fall back, unknown keys are dropped', () => {
  const s = loadUpdateState({
    skipped: 'not-an-array',
    remindAfter: ['x'],
    lastSeenServerVersion: 12,
    extra: { deep: true },
  });
  assert.deepEqual(s, emptyUpdateState());
});

test('skipped keeps only valid unique version strings', () => {
  const s = loadUpdateState({ skipped: ['1.0.0', 5, null, '', '1.0.0', 'bad version!', '1.1.0-rc.1'] });
  assert.deepEqual(s.skipped, ['1.0.0', '1.1.0-rc.1']);
});

test('remindAfter keeps only valid version keys with finite non-negative numbers', () => {
  const s = loadUpdateState({
    remindAfter: { '1.1.0': 5, '1.2.0': -1, '1.3.0': 'x', '1.4.0': null, 'bad key': 3, '1.5.0': 0 },
  });
  assert.deepEqual(s.remindAfter, { '1.1.0': 5, '1.5.0': 0 });
});

test('remindAfter ignores a __proto__ key from parsed JSON', () => {
  const raw = JSON.parse('{"remindAfter": {"__proto__": 1, "1.1.0": 2}}');
  const s = loadUpdateState(raw);
  assert.deepEqual(s.remindAfter, { '1.1.0': 2 });
  assert.equal(Object.getPrototypeOf(s.remindAfter), Object.prototype);
});

test('lastSeenServerVersion: valid string kept, empty or wrong type -> null', () => {
  assert.equal(loadUpdateState({ lastSeenServerVersion: '1.2.0' }).lastSeenServerVersion, '1.2.0');
  assert.equal(loadUpdateState({ lastSeenServerVersion: '' }).lastSeenServerVersion, null);
  assert.equal(loadUpdateState({ lastSeenServerVersion: 12 }).lastSeenServerVersion, null);
  assert.equal(loadUpdateState({ lastSeenServerVersion: null }).lastSeenServerVersion, null);
});

test('loadUpdateState drops unknown keys', () => {
  const s = loadUpdateState({ skipped: ['1.0.0'], foo: 1 });
  assert.deepEqual(Object.keys(s).sort(), ['lastSeenServerVersion', 'remindAfter', 'skipped']);
});

test('parseUpdateState: missing, corrupt or non-object JSON text -> empty state', () => {
  assert.deepEqual(parseUpdateState(null), emptyUpdateState());
  assert.deepEqual(parseUpdateState(undefined), emptyUpdateState());
  assert.deepEqual(parseUpdateState(''), emptyUpdateState());
  assert.deepEqual(parseUpdateState('{not json'), emptyUpdateState());
  assert.deepEqual(parseUpdateState('[]'), emptyUpdateState());
  assert.deepEqual(parseUpdateState('"str"'), emptyUpdateState());
});

test('serialize and parse round-trip', () => {
  const s = {
    skipped: ['1.0.0', '1.1.0'],
    remindAfter: { '1.2.0': NOW + DAY },
    lastSeenServerVersion: '1.1.0',
  };
  assert.deepEqual(parseUpdateState(serializeUpdateState(s)), s);
});

// ---- serverVersionChanged ----------------------------------------------------

test('serverVersionChanged', () => {
  assert.equal(serverVersionChanged(null, '1.0.0'), false, 'first start: no toast');
  assert.equal(serverVersionChanged('1.0.0', null), false);
  assert.equal(serverVersionChanged(null, null), false);
  assert.equal(serverVersionChanged('1.0.0', '1.0.0'), false);
  assert.equal(serverVersionChanged('1.0.0', '1.1.0'), true);
  assert.equal(serverVersionChanged('1.1.0', '1.0.0'), true, 'a downgrade is also a change');
});

// ---- compareSemver / canApkUpdate ---------------------------------------------

test('compareSemver basic ordering', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
});

test('compareSemver: leading v accepted, build metadata ignored', () => {
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.0.0+build.5', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
});

test('compareSemver: SemVer 2.0 prerelease precedence chain', () => {
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.equal(compareSemver(chain[i], chain[i + 1]), -1, `${chain[i]} < ${chain[i + 1]}`);
    assert.equal(compareSemver(chain[i + 1], chain[i]), 1, `${chain[i + 1]} > ${chain[i]}`);
  }
});

test('compareSemver: numeric prerelease ids sort before alphanumeric ones', () => {
  assert.equal(compareSemver('1.0.0-1', '1.0.0-a'), -1);
  assert.equal(compareSemver('1.0.0-2', '1.0.0-10'), -1);
});

test('compareSemver: a prerelease is lower than the release of the same core', () => {
  assert.equal(compareSemver('1.2.0-rc.9', '1.2.0'), -1);
  assert.equal(compareSemver('1.2.1-rc.1', '1.2.0'), 1);
});

test('compareSemver: huge numeric components compare without precision loss', () => {
  assert.equal(compareSemver('99999999999999999999.0.0', '9999999999999999999.0.0'), 1);
  assert.equal(compareSemver('1.0.9007199254740993', '1.0.9007199254740992'), 1);
});

test('compareSemver throws on invalid input', () => {
  for (const bad of ['', '1.0', 'abc', '01.0.0', '1.0.0-', '1.0.0-01', '1.0.0.0', '1.0.0 ']) {
    assert.throws(() => compareSemver(bad, '1.0.0'), `${JSON.stringify(bad)}`);
  }
});

test('canApkUpdate: newer than the app build only', () => {
  assert.equal(canApkUpdate('1.2.0', '1.0.0'), true);
  assert.equal(canApkUpdate('1.0.1', '1.0.0'), true);
  assert.equal(canApkUpdate('1.0.0', '1.0.0'), false);
  assert.equal(canApkUpdate('0.9.0', '1.0.0'), false);
  assert.equal(canApkUpdate('1.0.0-rc.1', '1.0.0'), false, 'prerelease is older than the release');
  assert.equal(canApkUpdate('1.0.1', '1.0.0-rc.1'), true);
});

test('canApkUpdate never throws on invalid input', () => {
  assert.equal(canApkUpdate('garbage', '1.0.0'), false);
  assert.equal(canApkUpdate('1.2.0', ''), false);
  assert.equal(canApkUpdate(undefined, '1.0.0'), false);
});

// ---- updateErrorText ----------------------------------------------------------

test('updateErrorText maps every error code to an i18n key', () => {
  const expected = {
    network: 'update.err.network',
    'not-found': 'update.err.notFound',
    forbidden: 'update.err.forbidden',
    unauthorized: 'update.err.unauthorized',
    'rate-limited': 'update.err.rateLimited',
    'bad-response': 'update.err.badResponse',
    'checksum-missing': 'update.err.checksumMissing',
    'checksum-mismatch': 'update.err.checksumMismatch',
    download: 'update.err.download',
    unsupported: 'update.err.unsupported',
    'bundle-invalid': 'update.err.bundleInvalid',
    busy: 'update.err.busy',
    other: 'update.err.other',
  };
  for (const [code, key] of Object.entries(expected)) {
    assert.deepEqual(updateErrorText({ code, message: 'raw', at: NOW }), { key, params: {} }, code);
  }
});

test('updateErrorText: unknown or prototype-like codes fall back to other', () => {
  assert.deepEqual(updateErrorText({ code: 'nope', message: '', at: 0 }).key, 'update.err.other');
  assert.deepEqual(updateErrorText({ code: 'toString', message: '', at: 0 }).key, 'update.err.other');
  assert.deepEqual(updateErrorText({ code: '__proto__', message: '', at: 0 }).key, 'update.err.other');
});
