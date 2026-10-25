// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeGroupsStart.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeChatFolders, startBlock } from '../codeGroups';

const prov = (id, kind, baseUrl) => ({ id, kind, baseUrl, name: id, deleted: false, seq: 1, createdAt: 0, updatedAt: 0 });
const conv = (id, extra = {}) => ({ id, title: id, providerId: null, model: null, createdAt: 0, updatedAt: 0, deleted: false, seq: 1, mode: 'code', ...extra });

test('startBlock: offline, unknown and no-picker devices are blocked', () => {
  assert.equal(startBlock(undefined, false), 'unavailable');
  assert.equal(startBlock({ online: false, kind: 'vscode', workspaces: true }, true), 'offline');
  assert.equal(startBlock({ online: true, kind: 'dsh', workspaces: false }, false), 'unavailable');
});

test('startBlock: a VS Code folder must be open there; a DSH device needs nothing more', () => {
  assert.equal(startBlock({ online: true, kind: 'vscode', workspaces: true }, false), 'notOpen');
  assert.equal(startBlock({ online: true, kind: 'vscode', workspaces: true }, true), null);
  assert.equal(startBlock({ online: true, kind: 'dsh', workspaces: true }, false), null);
});

test('codeChatFolders: normalized folders of code chats per device; chat mode and deleted ones ignored', () => {
  const providers = { p1: prov('p1', 'vscode-bridge', 'Zenn'), p2: prov('p2', 'dsh-bridge', 'PC2') };
  const list = [
    conv('a', { providerId: 'p1', cwd: 'C:\\Work\\Zenn\\' }),
    conv('b', { providerId: 'p1', cwd: 'c:/work/zenn' }),
    conv('c', { providerId: 'p2', cwd: '/home/x/app' }),
    conv('d', { providerId: 'p1', cwd: 'C:/other', deleted: true }),
    conv('e', { providerId: 'p1', cwd: 'C:/chat', mode: 'chat' }),
    conv('f', { providerId: null, cwd: '/no/device' }),
  ];
  const m = codeChatFolders(list, providers);
  assert.deepEqual([...m.keys()].sort(), ['PC2', 'Zenn']);
  assert.deepEqual([...m.get('Zenn')], ['c:/work/zenn']);
  assert.deepEqual([...m.get('PC2')], ['/home/x/app']);
});
