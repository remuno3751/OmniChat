// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/diagnose.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  micErrorState, micRow, OPEN_TIMEOUT_MS, probeRelay, READY_TIMEOUT_MS, runDiagnose, serverRows, withPrivate, wsRows,
} from '../voice/diagnose';

const TOKEN = 'SECRETTOKEN';
/** Fake translator: the key, plus the vars, so the tests can read which text was chosen. */
const tr = (key, vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);

/** A manual clock: timers run only when the test fires them. */
function clock() {
  let t = 0;
  const list = [];
  return {
    now: () => t,
    advance(ms) { t += ms; },
    schedule(fn, ms) { const h = { fn, ms, live: true }; list.push(h); return h; },
    cancel(h) { if (h) h.live = false; },
    liveMs: () => list.filter((h) => h.live).map((h) => h.ms),
    fireLive() { for (const h of list) if (h.live) { h.live = false; h.fn(); } },
  };
}

/** A fake WebSocket class that records the sockets it made. */
function fakeWs() {
  const sockets = [];
  class W {
    constructor(url) { this.url = url; this.closed = 0; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; sockets.push(this); }
    close() { this.closed++; }
  }
  return { W, sockets };
}

// ---- pure helpers -----------------------------------------------------------------------------------

test('withPrivate: adds private=1, keeps the other parameters, replaces an existing private=', () => {
  assert.equal(withPrivate('wss://h/voice/ws?token=T'), 'wss://h/voice/ws?token=T&private=1');
  assert.equal(withPrivate('wss://h/voice/ws'), 'wss://h/voice/ws?private=1');
  assert.equal(withPrivate('wss://h/voice/ws?private=0&token=T'), 'wss://h/voice/ws?token=T&private=1');
  assert.equal(withPrivate('wss://h/voice/ws?private=1'), 'wss://h/voice/ws?private=1');
});

test('micErrorState: permission errors are denied, no device is missing, the rest failed', () => {
  assert.equal(micErrorState('NotAllowedError'), 'denied');
  assert.equal(micErrorState('SecurityError'), 'denied');
  assert.equal(micErrorState('NotFoundError'), 'missing');
  assert.equal(micErrorState('OverconstrainedError'), 'missing');
  assert.equal(micErrorState('NotReadableError'), 'failed');
  assert.equal(micErrorState(undefined), 'failed');
});

test('micRow: each state has its text and level; skipped is a skip, not a failure', () => {
  assert.deepEqual(micRow('granted', tr), { id: 'mic', level: 'ok', message: 'host.diag.mic.ok' });
  assert.deepEqual(micRow('denied', tr), { id: 'mic', level: 'ng', message: 'host.diag.mic.denied', hint: 'host.diag.mic.deniedHint' });
  assert.equal(micRow('missing', tr).message, 'host.diag.mic.missing');
  assert.equal(micRow('failed', tr).message, 'host.diag.mic.failed');
  assert.deepEqual(micRow('skipped', tr), { id: 'mic', level: 'skip', message: 'host.diag.mic.skipped' });
});

test('serverRows: the server ok flag becomes ok / ng, the server message and hint are kept', () => {
  const rows = serverRows([{ id: 'aria', ok: true, message: 'up' }, { id: 'stt', ok: false, message: 'down', hint: 'start it' }]);
  assert.deepEqual(rows, [
    { id: 'srv.aria', level: 'ok', message: 'up' },
    { id: 'srv.stt', level: 'ng', message: 'down', hint: 'start it' },
  ]);
});

test('wsRows: connected + ready in ms; voice off, busy and timeouts get their own texts', () => {
  assert.deepEqual(wsRows({ opened: true, readyMs: 412.4 }, tr), [
    { id: 'ws', level: 'ok', message: 'host.diag.ws.ok' },
    { id: 'ready', level: 'ok', message: 'host.diag.ready.ok{"ms":412}' },
  ]);
  const [ws1, ready1] = wsRows({ opened: true, error: 'ready-timeout' }, tr);
  assert.equal(ws1.level, 'ok');
  assert.equal(ready1.message, 'host.diag.ready.timeout');
  assert.equal(ready1.hint, 'host.diag.ready.hint');
  assert.equal(wsRows({ opened: false, error: 'open-timeout' }, tr)[0].message, 'host.diag.ws.timeout');
  assert.equal(wsRows({ opened: false, error: 'closed', closeCode: 4409 }, tr)[0].message, 'host.set.off');
  assert.equal(wsRows({ opened: false, error: 'closed', closeCode: 4429 }, tr)[0].message, 'host.diag.ws.busy');
  const [ws2, ready2] = wsRows({ opened: false, error: 'open-error' }, tr);
  assert.equal(ws2.message, 'host.diag.ws.fail');
  assert.equal(ws2.hint, 'host.diag.ws.hint');
  assert.equal(ready2.level, 'skip');
});

// ---- the relay probe ----------------------------------------------------------------------------------

test('probeRelay: opens with the URL as given, gets ready, reports ms from the connect, and closes once', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay('wss://h/voice/ws?token=T&private=1', { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  assert.equal(sockets[0].url, 'wss://h/voice/ws?token=T&private=1');
  assert.deepEqual(c.liveMs(), [OPEN_TIMEOUT_MS]);
  c.advance(120);
  sockets[0].onopen();
  assert.deepEqual(c.liveMs(), [READY_TIMEOUT_MS]);
  c.advance(300);
  sockets[0].onmessage({ data: JSON.stringify({ type: 'ready', codec: 'pcm16' }) });
  assert.deepEqual(await p, { opened: true, readyMs: 420 });
  assert.equal(sockets[0].closed, 1);
  assert.deepEqual(c.liveMs(), []);
});

test('probeRelay: a non-ready or non-JSON message does not finish the probe', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay('wss://h/voice/ws', { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  sockets[0].onopen();
  sockets[0].onmessage({ data: 'not json' });
  sockets[0].onmessage({ data: JSON.stringify({ type: 'hello' }) });
  sockets[0].onmessage({ data: new Uint8Array([1, 2]) });
  c.fireLive();
  const r = await p;
  assert.deepEqual(r, { opened: true, error: 'ready-timeout' });
});

test('probeRelay: no open within 5 s gives open-timeout, and the socket is closed', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay('wss://h/voice/ws', { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  c.fireLive();
  assert.deepEqual(await p, { opened: false, error: 'open-timeout' });
  assert.equal(sockets[0].closed, 1);
});

test('probeRelay: opened but no ready within 8 s gives ready-timeout (opened, no ms)', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay('wss://h/voice/ws', { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  sockets[0].onopen();
  c.fireLive();
  const r = await p;
  assert.equal(r.opened, true);
  assert.equal(r.readyMs, undefined);
  assert.equal(r.error, 'ready-timeout');
});

test('probeRelay: a close before open carries the close code (4409 voice off); a socket that cannot be made is open-error', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay('wss://h/voice/ws', { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  sockets[0].onclose({ code: 4409 });
  assert.deepEqual(await p, { opened: false, error: 'open-error', closeCode: 4409 });

  const bad = probeRelay('wss://h/voice/ws', { WebSocketImpl: class { constructor() { throw new Error('nope'); } }, now: c.now, schedule: c.schedule, cancel: c.cancel });
  assert.deepEqual(await bad, { opened: false, error: 'open-error' });
});

test('probeRelay: a close after open is "closed"; the result never carries the URL', async () => {
  const { W, sockets } = fakeWs();
  const c = clock();
  const p = probeRelay(`wss://h/voice/ws?token=${TOKEN}&private=1`, { WebSocketImpl: W, now: c.now, schedule: c.schedule, cancel: c.cancel });
  sockets[0].onopen();
  sockets[0].onerror();
  const r = await p;
  assert.deepEqual(r, { opened: true, error: 'closed' });
  assert.ok(!JSON.stringify(r).includes(TOKEN));
});

// ---- the runner -----------------------------------------------------------------------------------------

test('runDiagnose: server, microphone and the probe (with private=1) make the rows, no URL or token in them', async () => {
  const seen = [];
  const rows = await runDiagnose({
    server: async () => [{ id: 'aria', ok: true, message: 'up' }],
    mic: async () => 'granted',
    relayUrl: `wss://h/voice/ws?token=${TOKEN}`,
    probe: async (url) => { seen.push(url); return { opened: true, readyMs: 50 }; },
  }, tr);
  assert.equal(seen[0], `wss://h/voice/ws?token=${TOKEN}&private=1`);
  assert.deepEqual(rows.map((r) => r.id), ['srv.aria', 'mic', 'ws', 'ready']);
  assert.ok(!JSON.stringify(rows).includes(TOKEN));
  assert.ok(!JSON.stringify(rows).includes('wss://'));
});

test('runDiagnose: no URL means the connection is not tried; a failing check gives its own ng row', async () => {
  let probed = false;
  const rows = await runDiagnose({
    server: async () => { throw new Error('boom'); },
    mic: async () => { throw new Error('boom'); },
    relayUrl: null,
    probe: async () => { probed = true; return { opened: true }; },
  }, tr);
  assert.equal(probed, false);
  assert.deepEqual(rows[0], { id: 'srv', level: 'ng', message: 'host.diag.server.fail' });
  assert.deepEqual(rows[1], { id: 'mic', level: 'ng', message: 'host.diag.mic.failed', hint: 'host.diag.mic.failedHint' });
  assert.deepEqual(rows[2], { id: 'ws', level: 'ng', message: 'host.diag.ws.noUrl' });
});

test('runDiagnose: a probe that throws is an ng row for the connection', async () => {
  const rows = await runDiagnose({
    server: async () => [],
    mic: async () => 'skipped',
    relayUrl: 'wss://h/voice/ws',
    probe: async () => { throw new Error('x'); },
  }, tr);
  assert.deepEqual(rows.find((r) => r.id === 'ws'), { id: 'ws', level: 'ng', message: 'host.diag.ws.fail' });
  assert.equal(rows.find((r) => r.id === 'mic').level, 'skip');
});
