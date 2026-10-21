// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeApprovalMode, approvalModeOfAction, approvalModeActions, approvalModePatch,
  closedFullDialog, openFullDialog, toggleFullDialogCheck, canConfirmFull, approvalCardView, decidedByLabel,
} from '../approvalMode';

test('normalizeApprovalMode: aliases and defaults', () => {
  assert.equal(normalizeApprovalMode(undefined), 'manual');
  assert.equal(normalizeApprovalMode('ask'), 'manual');
  assert.equal(normalizeApprovalMode('rules'), 'auto');
  assert.equal(normalizeApprovalMode('auto'), 'auto');
  assert.equal(normalizeApprovalMode('full'), 'full');
  assert.equal(normalizeApprovalMode('bogus'), 'manual');
});

test('approvalModeOfAction maps slash action ids', () => {
  assert.equal(approvalModeOfAction('approval_mode:ask'), 'manual');
  assert.equal(approvalModeOfAction('approval_mode:rules'), 'auto');
  assert.equal(approvalModeOfAction('approval_mode:full'), 'full');
  assert.equal(approvalModeOfAction('search:off'), null);
  assert.equal(approvalModeOfAction('approval_mode:x'), null);
});

test('approvalModeActions shows the server value and flags full for confirmation', () => {
  const a = approvalModeActions('auto');
  assert.deepEqual(a.map((x) => x.mode), ['manual', 'auto', 'full']);
  assert.deepEqual(a.map((x) => x.selected), [false, true, false]);
  assert.equal(a[2].needsConfirm, true);
  assert.equal(approvalModeActions('full')[2].needsConfirm, false);
  assert.equal(approvalModeActions(undefined)[0].selected, true);
});

test('approvalModePatch sends confirmFull only for a confirmed full access', () => {
  assert.deepEqual(approvalModePatch('full', true), { approvalMode: 'full', confirmFull: true });
  assert.deepEqual(approvalModePatch('full', false), { approvalMode: 'full' });
  assert.deepEqual(approvalModePatch('auto', true), { approvalMode: 'auto' });
});

test('full access dialog needs the checkbox and resets it on every open', () => {
  assert.equal(canConfirmFull(closedFullDialog), false);
  let s = openFullDialog();
  assert.equal(canConfirmFull(s), false);
  s = toggleFullDialogCheck(s);
  assert.equal(canConfirmFull(s), true);
  assert.equal(openFullDialog().checked, false);
  assert.deepEqual(toggleFullDialogCheck(closedFullDialog), closedFullDialog);
});

test('approvalCardView hides "always allow" for protected items', () => {
  assert.deepEqual(approvalCardView({}), { protectedItem: false, reasons: [], showAlways: true });
  const v = approvalCardView({ protected: true, reasons: ['outside', 7, ''] });
  assert.equal(v.showAlways, false);
  assert.deepEqual(v.reasons, ['outside']);
});

test('decidedByLabel', () => {
  assert.deepEqual(decidedByLabel('user'), { key: 'decidedBy.user', params: {} });
  assert.deepEqual(decidedByLabel('rule:r1'), { key: 'decidedBy.rule', params: { id: 'r1' } });
  assert.deepEqual(decidedByLabel('mode:full'), { key: 'decidedBy.mode', params: { mode: 'full' } });
  assert.equal(decidedByLabel(undefined), null);
  assert.equal(decidedByLabel('weird'), null);
});

test('the full-access dialog text never claims an automatic reset', () => {
  for (const f of ['en', 'ja']) {
    const src = fs.readFileSync(new URL(`../i18n/${f}.ts`, import.meta.url), 'utf8');
    const lines = src.split('\n').filter((l) => /'(approval\.full|approval\.mode)\./.test(l));
    assert.ok(lines.length >= 8);
    for (const l of lines) assert.ok(!/restart|reset|再起動|戻り|リセット/i.test(l), l);
  }
});
