// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/maintenance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ETA_PRESETS, MAINTENANCE_MESSAGE_MAX, etaFromChoice, maintenanceView, parseMaintenance, validateMaintenanceMessage, isMaintenanceCode } from '../maintenance';

const on = { enabled: true, message: '  DB移行中  ', eta: 1_700_000_000_000, updatedAt: 1 };
const off = { enabled: false, message: '', eta: null, updatedAt: 1 };

test('parseMaintenance: accepts the server object, rejects anything else', () => {
  assert.deepEqual(parseMaintenance(on), on);
  assert.equal(parseMaintenance(undefined), null); // old server: no field
  assert.equal(parseMaintenance(null), null);
  assert.equal(parseMaintenance('on'), null);
  assert.equal(parseMaintenance({ message: 'x' }), null); // enabled missing
  assert.deepEqual(parseMaintenance({ enabled: true }), { enabled: true, message: '', eta: null, updatedAt: 0 });
  assert.equal(parseMaintenance({ enabled: true, eta: 'soon' }).eta, null);
  assert.equal(parseMaintenance({ enabled: true, eta: NaN }).eta, null);
});

test('maintenanceView: off shows nothing and blocks nothing', () => {
  for (const isAdmin of [true, false]) {
    const v = maintenanceView(off, isAdmin);
    assert.equal(v.show, false);
    assert.equal(v.blocksSend, false);
    assert.equal(v.adminNote, false);
  }
  assert.equal(maintenanceView(null, false).show, false);
  assert.equal(maintenanceView(undefined, false).blocksSend, false);
});

test('maintenanceView: a general user is blocked, an admin is not', () => {
  const user = maintenanceView(on, false);
  assert.equal(user.show, true);
  assert.equal(user.blocksSend, true);
  assert.equal(user.adminNote, false);
  const admin = maintenanceView(on, true);
  assert.equal(admin.show, true);
  assert.equal(admin.blocksSend, false);
  assert.equal(admin.adminNote, true);
});

test('maintenanceView: message is trimmed, eta is passed through (null when absent)', () => {
  assert.equal(maintenanceView(on, false).message, 'DB移行中');
  assert.equal(maintenanceView(on, false).eta, 1_700_000_000_000);
  const noEta = maintenanceView({ ...on, message: '', eta: null }, false);
  assert.equal(noEta.message, '');
  assert.equal(noEta.eta, null);
});

test('isMaintenanceCode: only the maintenance code', () => {
  assert.equal(isMaintenanceCode('maintenance'), true);
  assert.equal(isMaintenanceCode('context_overflow'), false);
  assert.equal(isMaintenanceCode(undefined), false);
});

test('validateMaintenanceMessage: 500 characters at most, after trim', () => {
  assert.equal(validateMaintenanceMessage(''), null);
  assert.equal(validateMaintenanceMessage('a'.repeat(MAINTENANCE_MESSAGE_MAX)), null);
  assert.equal(validateMaintenanceMessage('a'.repeat(MAINTENANCE_MESSAGE_MAX + 1)), 'maint.messageTooLong');
  assert.equal(validateMaintenanceMessage('  ' + 'a'.repeat(MAINTENANCE_MESSAGE_MAX) + '  '), null);
  assert.equal(validateMaintenanceMessage('あ'.repeat(MAINTENANCE_MESSAGE_MAX)), null);
});

test('etaFromChoice: keep omits the field, none clears, presets add minutes', () => {
  const now = 1_000_000;
  assert.equal(etaFromChoice('keep', now), undefined);
  assert.equal(etaFromChoice('none', now), null);
  assert.equal(etaFromChoice('30', now), now + 30 * 60_000);
  assert.equal(etaFromChoice('360', now), now + 360 * 60_000);
  for (const p of ETA_PRESETS) assert.equal(typeof etaFromChoice(p, now), 'number');
});
