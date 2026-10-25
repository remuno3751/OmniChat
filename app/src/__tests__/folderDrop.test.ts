// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/folderDrop.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canDropOn, folderDropPatch } from '../folders';

const folder = (id, extra = {}) => ({ id, name: id, mode: 'chat', createdAt: 0, updatedAt: 0, deleted: false, seq: 1, ...extra });
const conv = (extra = {}) => ({ mode: 'chat', folderId: null, projectId: null, ...extra });
const folders = [folder('f1'), folder('f2')];

test('drop on another folder moves the chat there and clears its project', () => {
  assert.deepEqual(folderDropPatch(conv({ folderId: 'f1' }), 'f2', folders), { folderId: 'f2', projectId: null });
  assert.deepEqual(folderDropPatch(conv({ projectId: 'p1' }), 'f1', folders), { folderId: 'f1', projectId: null });
});

test('drop on Unclassified clears the folder; a project chat also leaves its project', () => {
  assert.deepEqual(folderDropPatch(conv({ folderId: 'f1' }), null, folders), { folderId: null });
  assert.deepEqual(folderDropPatch(conv({ folderId: 'f1', projectId: 'p1' }), null, folders), { folderId: null, projectId: null });
});

test('no-op: dropped on its current folder, or on Unclassified while already there', () => {
  assert.equal(folderDropPatch(conv({ folderId: 'f1' }), 'f1', folders), null);
  assert.equal(folderDropPatch(conv(), null, folders), null);
  assert.equal(canDropOn(conv({ folderId: 'f1' }), 'f1', folders), false);
});

test('a chat in its folder but also in a project is not a no-op for that folder', () => {
  assert.deepEqual(folderDropPatch(conv({ folderId: 'f1', projectId: 'p1' }), 'f1', folders), { folderId: 'f1', projectId: null });
});

test('unknown, deleted or other-mode folders are not valid targets', () => {
  const fs = [...folders, folder('gone', { deleted: true }), folder('code', { mode: 'code' })];
  assert.equal(folderDropPatch(conv(), 'nope', fs), null);
  assert.equal(folderDropPatch(conv(), 'gone', fs), null);
  assert.equal(folderDropPatch(conv(), 'code', fs), null);
});

test('code chats are never moved by this drop', () => {
  assert.equal(folderDropPatch(conv({ mode: 'code' }), 'f1', folders), null);
  assert.equal(folderDropPatch(conv({ mode: 'code', folderId: 'f1' }), null, folders), null);
});

test('a chat with no mode counts as a chat', () => {
  assert.deepEqual(folderDropPatch({ folderId: null, projectId: null }, 'f1', folders), { folderId: 'f1', projectId: null });
});
