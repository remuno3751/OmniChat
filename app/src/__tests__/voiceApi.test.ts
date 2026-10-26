// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/voiceApi.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelayUrl, defaultSpeed, deleteVoiceModel, effectiveSpeed, getDiagnose, getMe, getStatus, getUsage, isAriaUnreachable,
  isNotSupportedYet, isUnprocessable, isUnsupportedFormat, isVoiceOff, listVoices, PIPER_ID_RE, piperUploadPath, previewVoice,
  putMe, uploadVoiceModel, voiceModelUploadPath,
} from '../voice/voiceApi.ts';
import { settingsFromPrefs } from '../voice/ariaProtocol.ts';
import { parseServerVoices } from '../voice/ariaVoices.ts';
import { AriaHttpError } from '../voice/ariaRest.ts';

const TOKEN = 'SECRETTOKEN';
const BASE = 'https://omni.example';

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A fake fetch that records each call and answers with `status` / `body`. */
function fake(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return res(status, body);
  };
  return { fetchImpl, calls };
}

const ctx = (fetchImpl) => ({ base: BASE, token: TOKEN, fetchImpl });

// ---- paths, methods and headers ------------------------------------------------------------------

test('getStatus / getMe: GET on the /voice paths with the bearer token in the header only', async () => {
  const f = fake(200, { mode: 'hosted' });
  assert.deepEqual(await getStatus(ctx(f.fetchImpl)), { mode: 'hosted' });
  assert.equal(f.calls[0].url, `${BASE}/voice/status`);
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0].init.body, undefined);

  const g = fake(200, {});
  await getMe(ctx(g.fetchImpl));
  assert.equal(g.calls[0].url, `${BASE}/voice/me`);
  assert.equal(g.calls[0].init.method, 'GET');
});

test('putMe: PUT /voice/me with a JSON body, and the token stays out of the URL and the body', async () => {
  const f = fake(200, { ttsMode: 'fast' });
  await putMe(ctx(f.fetchImpl), { ttsMode: 'fast', speed: 1 });
  const { url, init } = f.calls[0];
  assert.equal(url, `${BASE}/voice/me`);
  assert.equal(init.method, 'PUT');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.body, '{"ttsMode":"fast","speed":1}');
  assert.ok(!url.includes(TOKEN) && !init.body.includes(TOKEN));
});

test('listVoices: GET /voice/voices', async () => {
  const f = fake(200, []);
  await listVoices(ctx(f.fetchImpl));
  assert.equal(f.calls[0].url, `${BASE}/voice/voices`);
  assert.equal(f.calls[0].init.method, 'GET');
});

test('deleteVoiceModel: DELETE /voice/voices/models/<uuid>, uuid encoded', async () => {
  const f = fake(200, {});
  await deleteVoiceModel(ctx(f.fetchImpl), 'a/b');
  assert.equal(f.calls[0].url, `${BASE}/voice/voices/models/a%2Fb`);
  assert.equal(f.calls[0].init.method, 'DELETE');
  assert.equal(f.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
});

test('uploadVoiceModel: POST raw bytes to /voice/voices/models?name=<encoded Japanese name>', async () => {
  const f = fake(200, { uuid: 'u1' });
  const bytes = new Uint8Array([1, 2, 3]);
  await uploadVoiceModel(ctx(f.fetchImpl), '声 モデル.aivmx', bytes);
  const { url, init } = f.calls[0];
  assert.equal(url, `${BASE}/voice/voices/models?name=${encodeURIComponent('声 モデル.aivmx')}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, bytes);
  assert.equal(init.headers['content-type'], 'application/octet-stream');
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!url.includes(TOKEN));
});

test('voiceModelUploadPath: the name is encoded (spaces, &, Japanese)', () => {
  assert.equal(voiceModelUploadPath('a b&c.onnx'), '/voice/voices/models?name=a%20b%26c.onnx');
  assert.equal(voiceModelUploadPath('声.aivmx'), '/voice/voices/models?name=%E5%A3%B0.aivmx');
});

test('no token: the Authorization header is left out', async () => {
  const f = fake(200, {});
  await getStatus({ base: BASE, token: null, fetchImpl: f.fetchImpl });
  assert.equal(f.calls[0].init.headers.authorization, undefined);
});

// ---- errors ----------------------------------------------------------------------------------------

test('415 unsupported_format from the upload is recognised', async () => {
  const f = fake(415, { code: 'unsupported_format', message: 'use .aivmx or a supported .onnx' });
  const err = await uploadVoiceModel(ctx(f.fetchImpl), 'x.onnx', new Uint8Array([1])).catch((e) => e);
  assert.ok(err instanceof AriaHttpError);
  assert.equal(err.status, 415);
  assert.equal(isUnsupportedFormat(err), true);
  assert.equal(isAriaUnreachable(err), false);
  assert.equal(isVoiceOff(err), false);
});

test('502 aria_unreachable is recognised, and is not an unsupported format', async () => {
  const f = fake(502, { code: 'aria_unreachable', message: 'voice engine is not reachable' });
  const err = await getStatus(ctx(f.fetchImpl)).catch((e) => e);
  assert.equal(isAriaUnreachable(err), true);
  assert.equal(isUnsupportedFormat(err), false);
  assert.equal(isVoiceOff(err), false);
});

test('409 voice_off is recognised', async () => {
  const f = fake(409, { code: 'voice_off', message: 'voice is off' });
  const err = await getMe(ctx(f.fetchImpl)).catch((e) => e);
  assert.equal(isVoiceOff(err), true);
  assert.equal(isAriaUnreachable(err), false);
});

test('the classifiers ignore other values', () => {
  for (const x of [null, undefined, new Error('x'), { status: 502 }, 'aria_unreachable']) {
    assert.equal(isAriaUnreachable(x), false);
    assert.equal(isUnsupportedFormat(x), false);
    assert.equal(isVoiceOff(x), false);
  }
});

test('errors never carry the token (network failure and server message)', async () => {
  const boom = async () => { throw new Error(`boom ${TOKEN}`); };
  const e1 = await getStatus(ctx(boom)).catch((e) => e);
  assert.ok(e1 instanceof AriaHttpError);
  assert.equal(e1.status, 0);
  assert.equal(e1.message, 'network');
  assert.ok(!String(e1.message).includes(TOKEN) && !String(e1.stack ?? '').includes(TOKEN));

  const f = fake(500, { message: 'failed with token' });
  const e2 = await getStatus(ctx(f.fetchImpl)).catch((e) => e);
  assert.equal(e2.status, 500);
  assert.equal(e2.message, 'failed with token');
});

// ---- relay URL -------------------------------------------------------------------------------------

test('buildRelayUrl: http -> ws, https -> wss, ws / wss pass through; path is /voice/ws', () => {
  assert.equal(buildRelayUrl('http://omni.local:8080', 'T'), 'ws://omni.local:8080/voice/ws?token=T');
  assert.equal(buildRelayUrl('https://omni.example', 'T'), 'wss://omni.example/voice/ws?token=T');
  assert.equal(buildRelayUrl('ws://127.0.0.1:8080', 'T'), 'ws://127.0.0.1:8080/voice/ws?token=T');
  assert.equal(buildRelayUrl('wss://omni.example', 'T'), 'wss://omni.example/voice/ws?token=T');
});

test('buildRelayUrl: the old path and query and hash are replaced', () => {
  assert.equal(buildRelayUrl('https://omni.example/some/path/?x=1#frag', 'T'), 'wss://omni.example/voice/ws?token=T');
  assert.equal(buildRelayUrl('https://omni.example/', 'T'), 'wss://omni.example/voice/ws?token=T');
});

test('buildRelayUrl: no token or no usable URL gives null', () => {
  assert.equal(buildRelayUrl('https://omni.example', null), null);
  assert.equal(buildRelayUrl('https://omni.example', ''), null);
  assert.equal(buildRelayUrl('', 'T'), null);
  assert.equal(buildRelayUrl('   ', 'T'), null);
  assert.equal(buildRelayUrl('ftp://omni.example', 'T'), null);
  assert.equal(buildRelayUrl('not a url', 'T'), null);
  assert.equal(buildRelayUrl('https://', 'T'), null);
});

test('buildRelayUrl: conversationId and the token are encoded, and omitted when absent', () => {
  const u = new URL(buildRelayUrl('https://omni.example', 'x+y/z=', 'a b&c'));
  assert.equal(u.searchParams.get('token'), 'x+y/z=');
  assert.equal(u.searchParams.get('conversationId'), 'a b&c');
  assert.ok(buildRelayUrl('https://omni.example', 'x+y/z=', 'a b&c').includes('conversationId=a+b%26c'));
  assert.equal(new URL(buildRelayUrl('https://omni.example', 'T')).searchParams.has('conversationId'), false);
});

// ---- speed and settings ------------------------------------------------------------------------------

test('defaultSpeed: balanced reads at 1.3, fast at 1.0', () => {
  assert.equal(defaultSpeed('balanced'), 1.3);
  assert.equal(defaultSpeed('fast'), 1);
  assert.equal(defaultSpeed(undefined), 1.3);
});

test('effectiveSpeed: the mode default unless the user chose a speed', () => {
  assert.equal(effectiveSpeed(undefined), 1.3);
  assert.equal(effectiveSpeed({}), 1.3);
  assert.equal(effectiveSpeed({ ttsMode: 'fast' }), 1);
  assert.equal(effectiveSpeed({ ttsMode: 'fast', speed: 1.5 }), 1.5);
  assert.equal(effectiveSpeed({ ttsMode: 'balanced', speed: 0.8 }), 0.8);
});

test('settingsFromPrefs: balanced at speed 1.3 by default; the prefs map to the Aria keys', () => {
  assert.deepEqual(settingsFromPrefs({}), { tts_mode: 'balanced', speed: 1.3 });
  assert.deepEqual(settingsFromPrefs({ ttsMode: 'fast' }), { tts_mode: 'fast', speed: 1 });
  assert.deepEqual(
    settingsFromPrefs({ ttsMode: 'fast', speed: 1.5, pauseScale: 0.5, responseDelayMs: 200, endOfTurnMs: 400, bargeIn: false, bargeInDb: -40, voice: 'spk-1' }),
    { tts_mode: 'fast', speed: 1.5, pause_scale: 0.5, response_delay_ms: 200, end_of_turn_ms: 400, barge_in: false, barge_in_db: -40, voice: 'spk-1' },
  );
  assert.equal('voice' in settingsFromPrefs({ voice: '' }), false);
});

// ---- server voice list ---------------------------------------------------------------------------------

test('parseServerVoices: keeps ownerUserId and mine; a missing mine is false', () => {
  const r = parseServerVoices({
    voices: [
      { uuid: 'u1', name: 'A', license: 'CC-BY', speakers: [{ name: 'sp', styles: [{ id: 1, name: 'n' }] }], ownerUserId: 'user-7', mine: true },
      { uuid: 'u2', name: 'B', ownerUserId: 'user-8', mine: false },
      { uuid: 'u3', name: 'C' },
      null,
      {},
    ],
  });
  assert.deepEqual(r.map((m) => m.uuid), ['u1', 'u2', 'u3']);
  assert.equal(r[0].name, 'A');
  assert.equal(r[0].license, 'CC-BY');
  assert.deepEqual(r[0].speakers, [{ name: 'sp', styles: [{ id: '1', name: 'n' }] }]);
  assert.equal(r[0].ownerUserId, 'user-7');
  assert.equal(r[0].mine, true);
  assert.equal(r[1].mine, false);
  assert.equal('ownerUserId' in r[2], false);
  assert.equal(r[2].mine, false);
});

test('parseServerVoices: a bare array works, mine is true only for a boolean true, and bad input gives []', () => {
  assert.equal(parseServerVoices([{ uuid: 'x', name: 'N', mine: 'yes' }])[0].mine, false);
  assert.equal(parseServerVoices([{ uuid: 'x', name: 'N', mine: true }])[0].mine, true);
  for (const x of [null, undefined, 5, 'x', {}, { voices: 'no' }]) assert.deepEqual(parseServerVoices(x), []);
});

// ---- piper (fast), usage, diagnose, preview ------------------------------------------------------

test('piperUploadPath: kind=piper, the id encoded, file=zip | model | config', () => {
  assert.equal(piperUploadPath('my-voice_1', 'zip'), '/voice/voices/models?kind=piper&name=my-voice_1&file=zip');
  assert.equal(piperUploadPath('a&b', 'model'), '/voice/voices/models?kind=piper&name=a%26b&file=model');
  assert.equal(piperUploadPath('v', 'config'), '/voice/voices/models?kind=piper&name=v&file=config');
});
test('PIPER_ID_RE: lowercase, digits, - and _, 1..40', () => {
  for (const ok of ['a', 'my-voice_1', '0123456789'.repeat(4)]) assert.ok(PIPER_ID_RE.test(ok), ok);
  for (const bad of ['', 'Upper', 'a b', 'a.b', 'a/b', 'x'.repeat(41), 'あ']) assert.ok(!PIPER_ID_RE.test(bad), bad);
});
test('422 is "not piper-plus ONNX"; 501 not_supported_yet is "not supported yet"', () => {
  assert.ok(isUnprocessable(Object.assign(new AriaHttpError(422, 'x'), {})));
  assert.ok(!isUnprocessable(new AriaHttpError(415, 'x')));
  assert.ok(isNotSupportedYet(new AriaHttpError(501, 'x', 'not_supported_yet')));
  assert.ok(isNotSupportedYet(new AriaHttpError(501, 'x')));
  assert.ok(!isNotSupportedYet(new AriaHttpError(502, 'x', 'aria_unreachable')));
});
test('getUsage / getDiagnose: GET with the bearer token; the list comes back as it is', async () => {
  const u = fake(200, { callSeconds: 90, turns: 4 });
  assert.deepEqual(await getUsage(ctx(u.fetchImpl)), { callSeconds: 90, turns: 4 });
  assert.equal(u.calls[0].url, `${BASE}/voice/usage`);
  assert.equal(u.calls[0].init.method, 'GET');
  assert.equal(u.calls[0].init.headers.authorization, `Bearer ${TOKEN}`);

  const d = fake(200, [{ id: 'aria', ok: true, message: 'up' }, { id: 'stt', ok: false, message: 'no', hint: 'h' }]);
  const items = await getDiagnose(ctx(d.fetchImpl));
  assert.equal(items.length, 2);
  assert.equal(d.calls[0].url, `${BASE}/voice/diagnose`);
});
test('previewVoice: POST JSON to /voice/preview and returns the WAV bytes', async () => {
  const wav = new Uint8Array([82, 73, 70, 70]).buffer;
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, arrayBuffer: async () => wav }; };
  const out = await previewVoice(ctx(fetchImpl), { text: 'hi', voice: '7', ttsMode: 'balanced' });
  assert.equal(out, wav);
  assert.equal(calls[0].url, `${BASE}/voice/preview`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'hi', voice: '7', ttsMode: 'balanced' });
  assert.ok(!calls[0].init.body.includes(TOKEN));
});
test('previewVoice: 501 not_supported_yet is recognised and carries no token', async () => {
  const fetchImpl = async () => ({ ok: false, status: 501, json: async () => ({ code: 'not_supported_yet', message: 'later' }) });
  try {
    await previewVoice(ctx(fetchImpl), { ttsMode: 'fast' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(isNotSupportedYet(e));
    assert.ok(!String(e.message).includes(TOKEN));
  }
});
