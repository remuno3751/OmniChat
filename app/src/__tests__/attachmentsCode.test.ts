// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Code (DSH) attachments: images and audio are refused in Code, documents are not (docs/design/ATTACHMENTS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeChipRefused, codeRefusesKind, codeSendBlocked, splitForCode, type Chip } from '../attachments';

const chip = (o: Partial<Chip> = {}): Chip => ({
  localId: 'a', name: 'a.png', size: 10, mime: 'image/png', kind: 'image', status: 'ready', progress: 1, warnings: [], ...o,
});

test('images and audio are refused, documents and other files are not', () => {
  assert.equal(codeRefusesKind('image'), true);
  assert.equal(codeRefusesKind('audio'), true);
  assert.equal(codeRefusesKind('document'), false);
  assert.equal(codeRefusesKind('other'), false);
});

test('splitForCode keeps everything outside Code', () => {
  const files = [{ mime: 'image/png' }, { mime: 'audio/wav' }, { mime: 'text/markdown' }];
  const r = splitForCode(files, false);
  assert.equal(r.allowed.length, 3);
  assert.equal(r.refused, 0);
});

test('splitForCode drops images and audio in Code and reports how many', () => {
  const docx = { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const files = [{ mime: 'image/png' }, { mime: 'audio/mpeg' }, docx, { mime: 'text/markdown' }];
  const r = splitForCode(files, true);
  assert.deepEqual(r.allowed, [docx, { mime: 'text/markdown' }]);
  assert.equal(r.refused, 2);
});

test('an image or audio chip in Code is refused (warning on the chip) unless it failed', () => {
  assert.equal(codeChipRefused(chip(), true), true);
  assert.equal(codeChipRefused(chip({ kind: 'audio', mime: 'audio/wav' }), true), true);
  assert.equal(codeChipRefused(chip({ status: 'error' }), true), false, 'a failed chip has its own error');
  assert.equal(codeChipRefused(chip(), false), false, 'outside Code nothing is refused');
  assert.equal(codeChipRefused(chip({ kind: 'document', mime: 'text/plain' }), true), false);
});

test('the send is held while a Code conversation has a refused chip', () => {
  assert.equal(codeSendBlocked([chip()], true), true);
  assert.equal(codeSendBlocked([chip({ kind: 'document', mime: 'text/plain' })], true), false);
  assert.equal(codeSendBlocked([chip()], false), false);
  assert.equal(codeSendBlocked([], true), false);
});
