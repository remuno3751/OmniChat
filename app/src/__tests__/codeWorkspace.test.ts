// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeWorkspace.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeDevices, workspaceOptions, pickerAvailable, cwdToSend, changeDevice, defaultCwdOf, defaultDevice } from '../codeWorkspace';

const prov = (id, baseUrl, extra = {}) => ({ id, kind: 'dsh-bridge', baseUrl, deleted: false, ...extra });
const providers = [prov('p2', 'laptop'), prov('p1', 'desk'), { id: 'o', kind: 'openai-compatible', baseUrl: 'http://x' }, prov('p3', 'gone', { deleted: true })];
const map = Object.fromEntries(providers.map((p) => [p.id, p]));
const bridges = [
  { name: 'desk', online: true, workspacesSupported: true, workspaces: ['C:\\Work\\App', '/b'] },
  { name: 'laptop', online: true }, // old plugin
];
const conv = (cwd, updatedAt, providerId = 'p1') => ({ id: 'c' + updatedAt, providerId, updatedAt, cwd });

test('codeDevices: bridge providers only, sorted, online and workspace support from /bridges', () => {
  const d = codeDevices(providers, bridges);
  assert.deepEqual(d.map((x) => [x.name, x.online, x.workspaces]), [['desk', true, true], ['laptop', true, false]]);
  assert.deepEqual(codeDevices(providers, null).map((x) => [x.online, x.workspaces]), [[false, false], [false, false]]);
  assert.deepEqual(codeDevices(providers, []).map((x) => x.online), [false, false]);
});

test('workspaceOptions: bridge list first, then conversation folders (deduplicated by normalized path)', () => {
  const convs = [conv('c:/work/app/', 5), conv('D:\\Old', 3), conv('/other-device', 9, 'p2'), conv(null, 8)];
  assert.deepEqual(workspaceOptions('desk', bridges, convs, map), ['C:\\Work\\App', '/b', 'D:\\Old']);
  // offline bridge: only what conversations know
  assert.deepEqual(workspaceOptions('desk', [], convs, map), ['c:/work/app/', 'D:\\Old']);
  assert.deepEqual(workspaceOptions('laptop', bridges, convs, map), ['/other-device']);
});

test('picker is available only for an online, workspace-aware device', () => {
  const [desk, laptop] = codeDevices(providers, bridges);
  assert.equal(pickerAvailable(desk), true);
  assert.equal(pickerAvailable(laptop), false);
  assert.equal(pickerAvailable(undefined), false);
  assert.equal(pickerAvailable(codeDevices(providers, [])[0]), false);
});

test('cwdToSend: default sends nothing; only offered folders are sent; old bridges never', () => {
  const [desk, laptop] = codeDevices(providers, bridges);
  const opts = ['C:\\Work\\App', '/b'];
  assert.equal(cwdToSend({ providerId: 'p1', cwd: null }, desk, opts), undefined);
  assert.equal(cwdToSend({ providerId: 'p1', cwd: '/b' }, desk, opts), '/b');
  assert.equal(cwdToSend({ providerId: 'p1', cwd: 'c:/work/app' }, desk, opts), 'c:/work/app');
  assert.equal(cwdToSend({ providerId: 'p1', cwd: '/not/offered' }, desk, opts), undefined);
  assert.equal(cwdToSend({ providerId: 'p2', cwd: '/b' }, laptop, opts), undefined);
});

const vsProviders = [{ id: 'v1', kind: 'vscode-bridge', baseUrl: 'pc', deleted: false }];
const vsBridges = [{ name: 'pc', kind: 'vscode', online: true, cwd: 'C:\\w\\app', workspaces: ['C:\\w\\app', 'C:\\w\\lib'] }];

test('vscode device with bridges not loaded: the picked folder is still sent', () => {
  const [pc] = codeDevices(vsProviders, null);
  assert.equal(pc.kind, 'vscode');
  assert.equal(cwdToSend({ providerId: 'v1', cwd: 'C:\\w\\lib' }, pc, [], null), 'C:\\w\\lib');
  // no folder known yet: nothing to resolve the default from
  assert.equal(cwdToSend({ providerId: 'v1', cwd: null }, pc, [], null), undefined);
});

test('vscode device default: the folder open in VS Code (cwd, else first open workspace)', () => {
  const [pc] = codeDevices(vsProviders, vsBridges);
  assert.equal(cwdToSend({ providerId: 'v1', cwd: null }, pc, ['C:\\w\\app', 'C:\\w\\lib'], vsBridges), 'C:\\w\\app');
  assert.equal(defaultCwdOf(pc, vsBridges), 'C:\\w\\app');
  assert.equal(defaultCwdOf(pc, [{ name: 'pc', kind: 'vscode', online: true, workspaces: ['/x', '/y'] }]), '/x');
  assert.equal(defaultCwdOf(pc, null), undefined);
  // a DSH device keeps its own default: nothing is sent
  assert.equal(defaultCwdOf({ ...pc, kind: 'dsh' }, vsBridges), undefined);
  assert.equal(cwdToSend({ providerId: 'p1', cwd: null }, { ...pc, kind: 'dsh' }, ['C:\\w\\app'], vsBridges), undefined);
});

test('workspaceOptions for an online VS Code PC lists only the folders open in VS Code', () => {
  const convs = [conv('C:\\old\\proj', 9, 'v1')];
  assert.deepEqual(workspaceOptions('pc', vsBridges, convs, { v1: vsProviders[0] }, 'vscode'), ['C:\\w\\app', 'C:\\w\\lib']);
  // offline: the folders of known chats
  assert.deepEqual(workspaceOptions('pc', [], convs, { v1: vsProviders[0] }, 'vscode'), ['C:\\old\\proj']);
});

test('changeDevice: the folder survives only if the new device offers it', () => {
  assert.deepEqual(changeDevice({ providerId: 'p1', cwd: '/b' }, 'p2', ['/b']), { providerId: 'p2', cwd: '/b' });
  assert.deepEqual(changeDevice({ providerId: 'p1', cwd: '/b' }, 'p2', ['/c']), { providerId: 'p2', cwd: null });
  assert.deepEqual(changeDevice({ providerId: 'p1', cwd: null }, 'p2', ['/c']), { providerId: 'p2', cwd: null });
});

test('defaultDevice: the first online device, else the first one, else none', () => {
  const dev = (name: string, online: boolean) => ({ providerId: 'p-' + name, name, online, workspaces: false, kind: 'vscode' as const });
  const offlineFirst = [dev('my-pc', false), dev('zeta', true), dev('zz', true)];
  assert.equal(defaultDevice(offlineFirst)?.name, 'zeta');
  assert.equal(defaultDevice([dev('a', false), dev('b', false)])?.name, 'a');
  assert.equal(defaultDevice([]), undefined);
});
