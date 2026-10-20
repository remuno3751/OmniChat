// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/serverUrlField.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowServerUrlField, serverOriginForPage } from '../serverUrlField';
import { clientVersionLine, desktopVersionFromWindow } from '../clientVersion';

test('web served by the server itself hides the server URL field', () => {
  const loc = { origin: 'http://192.168.1.5:8787', protocol: 'http:', port: '8787' };
  assert.equal(shouldShowServerUrlField('web', loc), false);
  assert.equal(serverOriginForPage(loc), 'http://192.168.1.5:8787');
});

test('web behind a reverse proxy on https (default port) hides the field', () => {
  assert.equal(shouldShowServerUrlField('web', { origin: 'https://chat.example.com', protocol: 'https:', port: '' }), false);
});

test('Expo dev server on web keeps the field', () => {
  for (const port of ['8081', '19006']) {
    const loc = { origin: `http://localhost:${port}`, protocol: 'http:', port };
    assert.equal(shouldShowServerUrlField('web', loc), true, port);
    assert.equal(serverOriginForPage(loc), null, port);
  }
});

test('native platforms always keep the field', () => {
  assert.equal(shouldShowServerUrlField('android', { origin: 'http://localhost', protocol: 'http:', port: '' }), true);
  assert.equal(shouldShowServerUrlField('ios', undefined), true);
});

test('web without a usable location keeps the field', () => {
  assert.equal(shouldShowServerUrlField('web', undefined), true);
  assert.equal(shouldShowServerUrlField('web', { origin: 'file://', protocol: 'file:', port: '' }), true);
});

test('client version: native shows the app version', () => {
  assert.deepEqual(clientVersionLine('android', '1.2.3'), { key: 'update.appVersion', version: '1.2.3' });
  assert.deepEqual(clientVersionLine('ios', '1.2.3', '9.9.9'), { key: 'update.appVersion', version: '1.2.3' });
});

test('client version: web shows the web client version, or the desktop shell version when exposed', () => {
  assert.deepEqual(clientVersionLine('web', '1.2.3'), { key: 'update.webVersion', version: '1.2.3' });
  assert.deepEqual(clientVersionLine('web', '1.2.3', ''), { key: 'update.webVersion', version: '1.2.3' });
  assert.deepEqual(clientVersionLine('web', '1.2.3', '2.0.0-beta.2'), { key: 'update.desktopVersion', version: '2.0.0-beta.2' });
});

test('desktop version is read only when it is a non-empty string', () => {
  assert.equal(desktopVersionFromWindow({ __OMNICHAT_DESKTOP__: { version: ' 2.0.0 ' } }), '2.0.0');
  assert.equal(desktopVersionFromWindow({ __OMNICHAT_DESKTOP__: { appIcon: 1 } }), null);
  assert.equal(desktopVersionFromWindow({ __OMNICHAT_DESKTOP__: { version: 3 } }), null);
  assert.equal(desktopVersionFromWindow(undefined), null);
});

test('the desktop app names its device after the app and the OS, not the webview browser', async () => {
  const { webDeviceName } = await import('../deviceName');
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  assert.equal(webDeviceName(edge, false), 'Web (Edge)');
  assert.equal(webDeviceName(edge, true), 'OmniChat Desktop (Windows)');
  assert.equal(webDeviceName(mac, true), 'OmniChat Desktop (macOS)');
  assert.equal(webDeviceName('', true), 'OmniChat Desktop');
});

test('a context bar keeps the last known limit while a fresh value is on its way', async () => {
  const { rememberLimit } = await import('../contextLimitMemory');
  const u = (limit: number | null) => ({ limit, limitSource: 'unknown', total: 10, reserve: 1024, fits: true });
  assert.equal(rememberLimit('p', 'm', u(65536)).limit, 65536);
  assert.equal(rememberLimit('p', 'm', u(null)).limit, 65536);
  assert.equal(rememberLimit('p', 'other', u(null)).limit, null, 'another model keeps its own');
  assert.equal(rememberLimit(null, 'm', u(null)).limit, null);
});

test('marquee distance: only text wider than its box travels', async () => {
  const { marqueeDistance, marqueeDuration } = await import('../marquee');
  assert.equal(marqueeDistance(100, 200), 0);
  assert.equal(marqueeDistance(200, 200), 0);
  assert.equal(marqueeDistance(0, 200), 0);
  assert.equal(marqueeDistance(300.4, 200), 101);
  assert.equal(marqueeDuration(40), 1000);
  assert.equal(marqueeDuration(400), 10000);
});

test('desktop DSH pairing frame: URL gate and the relayed socket', async () => {
  const { desktopDshFrameUrl, frameWsFactory } = await import('../desktopFrameWs');
  const w = (frame: unknown, origin: string) => ({ __OMNICHAT_DESKTOP__: { dshFrame: frame }, location: { origin } });
  assert.equal(desktopDshFrameUrl(w('http://tauri.localhost/dsh-bridge-frame.html', 'http://192.168.0.10:8787')), 'http://tauri.localhost/dsh-bridge-frame.html');
  assert.equal(desktopDshFrameUrl(w('http://tauri.localhost/dsh-bridge-frame.html', 'http://tauri.localhost')), null, 'the shell page itself needs no frame');
  assert.equal(desktopDshFrameUrl(w('http://tauri.localhost/other.html', 'http://x')), null);
  assert.equal(desktopDshFrameUrl(w('nope', 'http://x')), null);
  assert.equal(desktopDshFrameUrl({}), null);

  const sent: any[] = [];
  let deliver: (m: any) => void = () => {};
  const factory = frameWsFactory({ post: (m) => sent.push(m), onMessage: (fn) => { deliver = fn; } });
  const ws = factory('ws://127.0.0.1:19401/omnichat-bridge');
  const got: string[] = [];
  ws.addEventListener('open', () => got.push('open'));
  ws.addEventListener('message', (e) => got.push('msg:' + e.data));
  ws.addEventListener('close', (e) => got.push('close:' + e.code));
  assert.deepEqual(sent[0], { t: 'open', id: 's1', url: 'ws://127.0.0.1:19401/omnichat-bridge' });
  assert.equal(ws.readyState, 0);
  deliver({ t: 'ev', id: 's1', kind: 'open' });
  assert.equal(ws.readyState, 1);
  ws.send('{"type":"hello"}');
  assert.deepEqual(sent[1], { t: 'send', id: 's1', data: '{"type":"hello"}' });
  deliver({ t: 'ev', id: 's1', kind: 'message', data: 'x' });
  deliver({ t: 'ev', id: 'other', kind: 'message', data: 'ignored' });
  deliver({ t: 'ev', id: 's1', kind: 'close', code: 4403 });
  assert.deepEqual(got, ['open', 'msg:x', 'close:4403']);
  assert.equal(ws.readyState, 3);
});
