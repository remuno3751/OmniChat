// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VSCODE_EXT_VERSION, vsixName, installCommand, base64UrlEncode, base64UrlDecode, pairingCode, pairingLink,
  hasVscodeProvider, shouldAutoAddProvider, vscodeProviderBody, vscodeEnabled, vscodeSection, compatState, extensionOutdated,
  startTarget, codeBridgeErrorKey, setPendingCodeStart, takePendingCodeStart,
} from '../vscodeBridge';
import { codeDevices } from '../codeWorkspace';
import { deviceOf } from '../codeGroups';

const vsp = (id, baseUrl, extra = {}) => ({ id, kind: 'vscode-bridge', baseUrl, deleted: false, ...extra });

test('VscodeIntegration shows the vsix name of the current vscode-ext version', () => {
  const ver = JSON.parse(fs.readFileSync(new URL('../../../vscode-ext/package.json', import.meta.url), 'utf8')).version;
  assert.equal(VSCODE_EXT_VERSION, ver, 'update VSCODE_EXT_VERSION in vscodeBridge.ts');
  assert.equal(vsixName(ver), `omnichat-vscode-${ver}.vsix`);
  assert.equal(installCommand('0.1.0'), 'code --install-extension omnichat-vscode-0.1.0.vsix');
});

test('base64url round trip (ASCII, Japanese, emoji) without padding', () => {
  for (const s of ['', 'a', 'ab', 'abc', '{"n":"自分のPC"}', 'x😀y', '???>>>']) {
    const e = base64UrlEncode(s);
    assert.match(e, /^[A-Za-z0-9_-]*$/);
    assert.equal(base64UrlDecode(e), s);
    assert.equal(e, Buffer.from(s, 'utf8').toString('base64url'));
  }
  assert.equal(base64UrlDecode('a'), null);
  assert.equal(base64UrlDecode('a b'), null);
});

test('pairingCode carries {s,t,n} and the link points at the extension', () => {
  const code = pairingCode('http://192.168.0.5:8787', 'tok_123', 'desk');
  assert.deepEqual(JSON.parse(base64UrlDecode(code)), { s: 'http://192.168.0.5:8787', t: 'tok_123', n: 'desk' });
  assert.equal(pairingLink(code), `vscode://omnichat.omnichat-vscode/pair?code=${code}`);
});

test('provider helpers', () => {
  assert.equal(hasVscodeProvider([vsp('a', 'desk')], ' desk '), true);
  assert.equal(hasVscodeProvider([vsp('a', 'desk', { deleted: true })], 'desk'), false);
  assert.equal(hasVscodeProvider([{ id: 'x', kind: 'dsh-bridge', baseUrl: 'desk' }], 'desk'), false);
  assert.equal(shouldAutoAddProvider(true, [], 'desk'), true);
  assert.equal(shouldAutoAddProvider(false, [], 'desk'), false);
  assert.equal(shouldAutoAddProvider(true, [vsp('a', 'desk')], 'desk'), false);
  assert.equal(shouldAutoAddProvider(true, [], '  '), false);
  assert.equal(vscodeProviderBody(' desk ').kind, 'vscode-bridge');
  assert.equal(vscodeProviderBody(' desk ').baseUrl, 'desk');
});

const bridges = [
  { name: 'desk', online: true, kind: 'dsh', workspaces: ['C:\\dsh'] },
  { name: 'laptop', online: false, kind: 'vscode', version: '0.1.0' },
  { name: 'desk', online: true, kind: 'vscode', version: '0.0.9', workspaces: ['C:\\work\\app', 'C:\\work\\lib'], compat: { ok: false, minVersion: '0.1.0' } },
];

test('the VS Code section exists only when a vscode bridge is known', () => {
  assert.equal(vscodeEnabled(null), false);
  assert.equal(vscodeEnabled([bridges[0]]), false);
  assert.deepEqual(vscodeSection([bridges[0]], [], [], {}), []);
  assert.equal(vscodeEnabled(bridges), true);
});

test('vscodeSection lists each PC by name with state and workspaces, online first', () => {
  const provs = [vsp('p1', 'desk')];
  const map = { p1: provs[0] };
  const convs = [{ id: 'c1', providerId: 'p1', cwd: 'C:\\old\\proj', updatedAt: 5, deleted: false }];
  const s = vscodeSection(bridges, provs, convs, map);
  assert.deepEqual(s.map((d) => [d.name, d.online]), [['desk', true], ['laptop', false]]);
  assert.deepEqual(s[0].workspaces, ['C:\\work\\app', 'C:\\work\\lib', 'C:\\old\\proj']);
  assert.equal(s[0].providerId, 'p1');
  assert.equal(s[1].providerId, null);
  assert.deepEqual(s[1].workspaces, []);
});

test('startTarget refuses an offline PC', () => {
  const [desk, laptop] = vscodeSection(bridges, [vsp('p1', 'desk')], [], { p1: vsp('p1', 'desk') });
  assert.deepEqual(startTarget(desk, 'C:\\work\\app'), { ok: true, providerId: 'p1', cwd: 'C:\\work\\app' });
  assert.deepEqual(startTarget(laptop, 'C:\\x'), { ok: false, reason: 'offline' });
});

test('compat and outdated hints', () => {
  assert.equal(compatState(bridges[2]), 'tooOld');
  assert.equal(compatState({ name: 'a', online: true, kind: 'vscode', compat: { ok: true } }), 'ok');
  assert.equal(compatState(bridges[1]), 'unknown');
  assert.equal(extensionOutdated({ name: 'a', online: true, version: '0.0.9' }, '0.1.0'), true);
  assert.equal(extensionOutdated({ name: 'a', online: true, version: '0.1.0' }, '0.1.0'), false);
  assert.equal(extensionOutdated({ name: 'a', online: true }), false);
  assert.equal(extensionOutdated({ name: 'a', online: true, version: 'garbage' }), false);
});

test('error codes map to messages', () => {
  assert.equal(codeBridgeErrorKey('workspace_not_open'), 'code.vscode.err.workspaceNotOpen');
  assert.equal(codeBridgeErrorKey('model_conflict'), null);
  assert.equal(codeBridgeErrorKey(undefined), null);
});

test('pending code start is taken once', () => {
  setPendingCodeStart({ providerId: 'p1', cwd: 'C:\\x' });
  assert.deepEqual(takePendingCodeStart(), { providerId: 'p1', cwd: 'C:\\x' });
  assert.equal(takePendingCodeStart(), null);
});

test('vscode-bridge providers are Code devices, matched to the vscode bridge of the same name', () => {
  const provs = [{ id: 'd', kind: 'dsh-bridge', baseUrl: 'desk' }, vsp('v', 'desk')];
  const devs = codeDevices(provs, bridges);
  assert.deepEqual(devs.map((d) => [d.providerId, d.kind, d.online, d.workspaces]), [['d', 'dsh', true, false], ['v', 'vscode', true, true]]);
  assert.equal(deviceOf({ providerId: 'v' }, { v: provs[1] }), 'desk');
});
