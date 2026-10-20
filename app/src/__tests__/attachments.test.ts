// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachErrorKey, audioNote, canSendAttachments, capSelection, chipFailed, chipUploaded, effectiveVision,
  formatBytes, hasImage, imageWarning, kindFromMime, readyIds, visionKey, type Chip,
} from '../attachments';

const chip = (o: Partial<Chip> = {}): Chip => ({
  localId: 'a', name: 'a.png', size: 10, mime: 'image/png', kind: 'image', status: 'ready', progress: 1, warnings: [], ...o,
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3 MB');
  assert.equal(formatBytes(12 * 1024 * 1024), '12 MB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
});

test('attachErrorKey maps server codes', () => {
  assert.equal(attachErrorKey('attachment_too_large'), 'attach.err.tooLarge');
  assert.equal(attachErrorKey('attachment_type_not_allowed'), 'attach.err.type');
  assert.equal(attachErrorKey('attachment_quota_exceeded'), 'attach.err.quota');
  assert.equal(attachErrorKey('attachment_too_many'), 'attach.err.tooMany');
  assert.equal(attachErrorKey('attachment_deleted'), 'attach.err.gone');
  assert.equal(attachErrorKey('something_else'), 'attach.err.generic');
  assert.equal(attachErrorKey(undefined), 'attach.err.generic');
});

test('effectiveVision: the override beats the model list', () => {
  assert.equal(effectiveVision('p', 'm', 'no', { [visionKey('p', 'm')]: true }), 'yes');
  assert.equal(effectiveVision('p', 'm', 'yes', { [visionKey('p', 'm')]: false }), 'no');
  assert.equal(effectiveVision('p', 'm', 'yes', { 'p::other': false }), 'yes');
  assert.equal(effectiveVision('p', 'm', undefined, null), 'unknown');
});

test('imageWarning only when an image is attached', () => {
  assert.equal(imageWarning('unknown', false), null);
  assert.equal(imageWarning('yes', true), null);
  assert.equal(imageWarning('unknown', true), 'unknown');
  assert.equal(imageWarning(undefined, true), 'unknown');
  assert.equal(imageWarning('no', true), 'no');
});

test('audioNote only when transcription is known to be unset', () => {
  assert.equal(audioNote('audio', null), true);
  assert.equal(audioNote('audio', undefined), false);
  assert.equal(audioNote('audio', 'p::whisper'), false);
  assert.equal(audioNote('image', null), false);
});

test('capSelection keeps the room and reports the rest', () => {
  assert.deepEqual(capSelection(8, 5, 10), { take: 2, dropped: 3 });
  assert.deepEqual(capSelection(0, 3, 10), { take: 3, dropped: 0 });
  assert.deepEqual(capSelection(10, 2, 10), { take: 0, dropped: 2 });
  assert.deepEqual(capSelection(12, 1, 10), { take: 0, dropped: 1 });
});

test('send gating and ready ids', () => {
  const up = chip({ localId: 'b', status: 'uploading', progress: 0.4 });
  const bad = chipFailed(chip({ localId: 'c' }), 'attachment_too_large', 'x');
  assert.equal(canSendAttachments([chip(), up]), false);
  assert.equal(canSendAttachments([chip(), bad]), true);
  assert.deepEqual(readyIds([chip({ id: 'x1' }), up, bad]), ['x1']);
});

test('chip transitions', () => {
  const ok = chipUploaded(chip({ localId: 'd', status: 'uploading', progress: 0.2 }), 'id9', ['w']);
  assert.equal(ok.status, 'ready');
  assert.equal(ok.id, 'id9');
  assert.deepEqual(ok.warnings, ['w']);
  const err = chipFailed(ok, 'attachment_quota_exceeded', 'full');
  assert.equal(err.status, 'error');
  assert.equal(err.errorCode, 'attachment_quota_exceeded');
});

test('hasImage ignores failed chips', () => {
  assert.equal(hasImage([chipFailed(chip(), 'x', 'y')]), false);
  assert.equal(hasImage([chip()]), true);
});

test('kindFromMime', () => {
  assert.equal(kindFromMime('image/jpeg'), 'image');
  assert.equal(kindFromMime('audio/mpeg'), 'audio');
  assert.equal(kindFromMime('application/pdf'), 'document');
  assert.equal(kindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'document');
  assert.equal(kindFromMime('application/zip'), 'other');
});
