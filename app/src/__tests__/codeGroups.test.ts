// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeGroups.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normCwd, cwdLabel, deviceOf, devicesOf, groupByWorkspace, groupByDevice, workspaceKey, splitHiddenDeviceChats } from '../codeGroups';

const providers = {
  p1: { id: 'p1', kind: 'dsh-bridge', baseUrl: 'desk' },
  p2: { id: 'p2', kind: 'dsh-bridge', baseUrl: 'laptop ' },
  o: { id: 'o', kind: 'openai-compatible', baseUrl: 'http://x' },
};
let n = 0;
const conv = (cwd, updatedAt, providerId = 'p1', extra = {}) => ({ id: 'c' + n++, title: 't', providerId, updatedAt, createdAt: 0, mode: 'code', cwd, ...extra });

test('normCwd: slashes, trailing slash, Windows case-insensitive, POSIX case-sensitive', () => {
  assert.equal(normCwd('C:\\Work\\App\\'), 'c:/work/app');
  assert.equal(normCwd('c:/work/app'), 'c:/work/app');
  assert.equal(normCwd('/Home/Me/App//'), '/Home/Me/App');
  assert.notEqual(normCwd('/Home/me'), normCwd('/home/me'));
  assert.equal(normCwd(null), '');
  assert.equal(normCwd(''), '');
});

test('cwdLabel: last segment, root stays', () => {
  assert.equal(cwdLabel('C:\\work\\app\\'), 'app');
  assert.equal(cwdLabel('/home/me/proj'), 'proj');
  assert.equal(cwdLabel('/'), '/');
});

test('deviceOf / devicesOf', () => {
  assert.equal(deviceOf(conv('/a', 1, 'p2'), providers), 'laptop');
  assert.equal(deviceOf(conv('/a', 1, 'o'), providers), null);
  assert.equal(deviceOf(conv('/a', 1, null), providers), null);
  assert.deepEqual(devicesOf([conv('/a', 1, 'p2'), conv('/a', 1, 'p1'), conv('/a', 1, 'o')], providers), ['desk', 'laptop']);
});

test('groupByWorkspace: same folder written differently is one group; newest group first; Other last', () => {
  const list = [
    conv('C:\\Work\\App', 100),
    conv('c:/work/app/', 300),
    conv('/srv/other', 200),
    conv(null, 900), // newest overall but unknown folder -> last
    conv('', 50),
  ];
  const g = groupByWorkspace(list, providers, false);
  assert.deepEqual(g.map((x) => [x.label, x.convs.length]), [['App', 2], ['other', 1], ['', 2]]);
  assert.equal(g[0].path, 'c:/work/app/', 'path of the newest conversation');
  assert.deepEqual(g[0].convs.map((c) => c.updatedAt), [300, 100]);
  assert.equal(g[2].path, null);
  assert.equal(g[2].key, 'ws:|');
});

test('groupByWorkspace: equal folder names get their parent; devices separate groups when byDevice', () => {
  const g = groupByWorkspace([conv('/a/app', 2), conv('/b/app', 1)], providers, false);
  assert.deepEqual(g.map((x) => x.label), ['a/app', 'b/app']);
  const d = groupByWorkspace([conv('/x/app', 2, 'p1'), conv('/x/app', 1, 'p2')], providers, true);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => x.device), ['desk', 'laptop']);
  assert.notEqual(d[0].key, d[1].key);
  assert.equal(groupByWorkspace([conv('/x/app', 2, 'p1'), conv('/x/app', 1, 'p2')], providers, false).length, 1);
});

test('groupByDevice: devices by recency, no-device last, workspaces inside', () => {
  const g = groupByDevice([conv('/a', 10, 'p1'), conv('/b', 30, 'p2'), conv('/c', 20, 'p2'), conv('/z', 99, 'o')], providers);
  assert.deepEqual(g.map((x) => x.device), ['laptop', 'desk', null]);
  assert.deepEqual(g[0].groups.map((x) => x.label), ['b', 'c']);
  assert.equal(g[0].groups[0].key, workspaceKey('laptop', '/b'));
});

test('splitHiddenDeviceChats: hidden device names (the revoke "hide" list) move their chats out of the Code list', () => {
  const convs = [conv('/a', 10, 'p1'), conv('/b', 30, 'p2'), conv('/z', 99, 'o')];
  // "VS Code (desk)" and "DSH plugin (laptop )" name bridges desk and "laptop "
  const none = splitHiddenDeviceChats(convs, providers, []);
  assert.equal(none.shown.length, 3);
  assert.equal(none.hidden.length, 0);
  const one = splitHiddenDeviceChats(convs, providers, ['VS Code (desk)']);
  assert.deepEqual(one.hidden.map((c) => c.id), [convs[0].id]);
  assert.deepEqual(one.shown.map((c) => c.id), [convs[1].id, convs[2].id]);
  // a name that is no bridge device, and a bridge with no conversations, hide nothing
  assert.equal(splitHiddenDeviceChats(convs, providers, ['iPhone', 'VS Code (other)']).hidden.length, 0);
  // a provider that is not a bridge has no device: never hidden
  assert.equal(splitHiddenDeviceChats([conv('/z', 1, 'o')], providers, ['VS Code (http://x)']).hidden.length, 0);
});
