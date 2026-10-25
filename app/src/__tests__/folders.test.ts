// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/folders.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { groupByFolder, newFolderId } from '../folders';
import { activeFolders, applyUpsert, clearAll, getState } from '../store';

const folder = (id, extra = {}) => ({ id, name: id, mode: 'chat', createdAt: 0, updatedAt: 0, deleted: false, seq: 1, ...extra });
const conv = (id, extra = {}) => ({ id, title: id, providerId: null, model: null, createdAt: 0, updatedAt: 0, deleted: false, seq: 1, ...extra });

test('groupByFolder: chat in an active folder of the same mode goes to that folder, in input order', () => {
  const folders = [folder('f1'), folder('f2')];
  const list = [conv('a', { folderId: 'f1' }), conv('b'), conv('c', { folderId: 'f2' }), conv('d', { folderId: 'f1' })];
  const g = groupByFolder(list, folders, 'chat');
  assert.deepEqual([...g.byFolder.keys()], ['f1', 'f2']);
  assert.deepEqual(g.byFolder.get('f1').map((c) => c.id), ['a', 'd']);
  assert.deepEqual(g.byFolder.get('f2').map((c) => c.id), ['c']);
  assert.deepEqual(g.loose.map((c) => c.id), ['b']);
});

test('groupByFolder: unknown, deleted, other-mode and null folder ids stay loose', () => {
  const folders = [folder('code', { mode: 'code' }), folder('gone', { deleted: true })];
  const list = [
    conv('unknown', { folderId: 'nope' }),
    conv('deleted', { folderId: 'gone' }),
    conv('otherMode', { folderId: 'code' }),
    conv('nullId', { folderId: null }),
    conv('absent'),
  ];
  const g = groupByFolder(list, folders, 'chat');
  assert.equal(g.byFolder.size, 0);
  assert.deepEqual(g.loose.map((c) => c.id), ['unknown', 'deleted', 'otherMode', 'nullId', 'absent']);
  // the same folder seen from the Code side
  const c = groupByFolder([conv('x', { folderId: 'code' })], folders, 'code');
  assert.deepEqual([...c.byFolder.keys()], ['code']);
});

test('groupByFolder: a project chat stays in its project even with a folderId', () => {
  const g = groupByFolder([conv('p', { folderId: 'f1', projectId: 'proj' })], [folder('f1')], 'chat');
  assert.equal(g.byFolder.size, 0);
  assert.deepEqual(g.loose.map((c) => c.id), ['p']);
});

test('newFolderId: unique non-empty ids', () => {
  const a = newFolderId();
  const b = newFolderId();
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

beforeEach(async () => { await clearAll(); });

test('store: a folder upsert merges by seq (newer wins, older ignored) and moves lastSeq', () => {
  applyUpsert({ folders: [folder('f1', { name: 'new', seq: 5 })] });
  applyUpsert({ folders: [folder('f1', { name: 'old', seq: 3 })] });
  assert.equal(getState().folders.f1.name, 'new');
  assert.equal(getState().lastSeq, 5);
  applyUpsert({ folders: [folder('f1', { name: 'newer', seq: 6 })] });
  assert.equal(getState().folders.f1.name, 'newer');
  assert.equal(getState().lastSeq, 6);
  assert.equal(getState().v3, true);
});

test('store: a deleted folder is kept as a tombstone and its chats become unclassified at once', () => {
  applyUpsert({ folders: [folder('f1', { seq: 2 }), folder('f2', { seq: 2 })] });
  applyUpsert({ conversations: [conv('a', { folderId: 'f1', seq: 4 }), conv('b', { folderId: 'f2', seq: 4 }), conv('c', { seq: 4 })] });
  applyUpsert({ folders: [folder('f1', { deleted: true, seq: 7 })] });
  const s = getState();
  assert.equal(s.folders.f1.deleted, true);
  assert.equal(s.conversations.a.folderId, null);
  assert.equal(s.conversations.a.seq, 4, 'the local clear keeps the conversation seq');
  assert.equal(s.conversations.b.folderId, 'f2');
  assert.equal(s.conversations.c.folderId, undefined);
  assert.equal(s.lastSeq, 7);
});

test('store: a stale folder upsert does not revive a deleted folder', () => {
  applyUpsert({ folders: [folder('f1', { deleted: true, seq: 9 })] });
  applyUpsert({ folders: [folder('f1', { seq: 8 })] });
  assert.equal(getState().folders.f1.deleted, true);
});

test('store: an upsert without folders leaves them alone', () => {
  applyUpsert({ folders: [folder('f1', { seq: 1 })] });
  applyUpsert({ presets: [] });
  assert.ok(getState().folders.f1);
  applyUpsert({ folders: [] });
  assert.ok(getState().folders.f1);
});

test('activeFolders: drops deleted folders, sorts by createdAt then name', () => {
  const map = {
    x: folder('x', { name: 'Zeta', createdAt: 2 }),
    y: folder('y', { name: 'Beta', createdAt: 1 }),
    z: folder('z', { name: 'Alpha', createdAt: 1 }),
    d: folder('d', { name: 'Gone', createdAt: 0, deleted: true }),
  };
  assert.deepEqual(activeFolders(map).map((f) => f.id), ['z', 'y', 'x']);
});

test('pendingFolderFor: only for the chat it was started for, and only while the folder is active', async () => {
  const { pendingFolderFor } = await import('../folders');
  const folders = { f1: folder('f1', { name: 'Work' }), f2: folder('f2', { deleted: true }) };
  assert.equal(pendingFolderFor({ id: 'c1', folderId: 'f1' }, 'c1', folders)?.name, 'Work');
  assert.equal(pendingFolderFor({ id: 'c1', folderId: 'f1' }, 'c2', folders), null);
  assert.equal(pendingFolderFor({ id: 'c1', folderId: 'f2' }, 'c1', folders), null);
  assert.equal(pendingFolderFor({ id: 'c1', folderId: 'missing' }, 'c1', folders), null);
  assert.equal(pendingFolderFor(null, 'c1', folders), null);
});
