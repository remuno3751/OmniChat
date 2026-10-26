// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/ariaProtocol.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addUserText, applyServerMsg, buildLiveUrl, clampAriaSettings, downsampleTo16k, floatToPcm16,
  parseServerMessage, pcm16ToFloat, pcmChunkDurationSec, settingsFromPrefs, TurnGate,
} from '../voice/ariaProtocol.ts';

// ---- buildLiveUrl -------------------------------------------------------------------------------

test('buildLiveUrl: each scheme maps to ws / wss, and ws / wss pass through', () => {
  assert.equal(buildLiveUrl('http://aria.local:8000', 'default', ''), 'ws://aria.local:8000/live/ws?user=default');
  assert.equal(buildLiveUrl('https://aria.example.ts.net:8443', 'default', ''), 'wss://aria.example.ts.net:8443/live/ws?user=default');
  assert.equal(buildLiveUrl('ws://127.0.0.1:8000', 'default', ''), 'ws://127.0.0.1:8000/live/ws?user=default');
  assert.equal(buildLiveUrl('wss://aria.example.ts.net', 'default', ''), 'wss://aria.example.ts.net/live/ws?user=default');
});

test('buildLiveUrl: the path is replaced by /live/ws (trailing slash and old path dropped)', () => {
  assert.equal(buildLiveUrl('https://aria.example.ts.net:8443/', 'u', ''), 'wss://aria.example.ts.net:8443/live/ws?user=u');
  assert.equal(buildLiveUrl('https://aria.example.ts.net:8443/some/old/path/?x=1#frag', 'u', ''), 'wss://aria.example.ts.net:8443/live/ws?user=u');
});

test('buildLiveUrl: user and token are encoded with URLSearchParams; an empty user becomes default; an empty token is omitted', () => {
  const url = buildLiveUrl('https://h.example', 'a b&c', 'x+y/z=');
  assert.equal(new URL(url).searchParams.get('user'), 'a b&c');
  assert.equal(new URL(url).searchParams.get('token'), 'x+y/z=');
  assert.equal(new URL(url).search, '?user=a+b%26c&token=x%2By%2Fz%3D');
  assert.equal(buildLiveUrl('https://h.example', '', ''), 'wss://h.example/live/ws?user=default');
  assert.equal(new URL(buildLiveUrl('https://h.example', 'me', '')).searchParams.has('token'), false);
});

test('buildLiveUrl: invalid input gives null', () => {
  assert.equal(buildLiveUrl('', 'default', ''), null);
  assert.equal(buildLiveUrl('ftp://host', 'default', ''), null);
  assert.equal(buildLiveUrl('http://', 'default', ''), null);
  assert.equal(buildLiveUrl('not a url', 'default', ''), null);
});

// ---- parseServerMessage -------------------------------------------------------------------------

test('parseServerMessage: ready converts snake_case to camelCase and keeps the tts modes', () => {
  assert.deepEqual(
    parseServerMessage('{"type":"ready","codec":"pcm16","sample_rate":24000,"tts_modes":["balanced","fast"]}'),
    { type: 'ready', codec: 'pcm16', sampleRate: 24000, ttsModes: ['balanced', 'fast'] },
  );
  // tts_modes が無ければ空配列
  assert.deepEqual(parseServerMessage('{"type":"ready","codec":"pcm16","sample_rate":16000}').ttsModes, []);
});

test('parseServerMessage: audio, transcript and turn_end', () => {
  assert.deepEqual(
    parseServerMessage('{"type":"audio","turn":3,"seq":1,"text":"はい","codec":"pcm16","sample_rate":24000,"frames":2}'),
    { type: 'audio', turn: 3, seq: 1, text: 'はい', codec: 'pcm16', sampleRate: 24000, frames: 2 },
  );
  assert.deepEqual(
    parseServerMessage('{"type":"transcript","turn":3,"text":"こんにちは","final":true,"source":"asr"}'),
    { type: 'transcript', turn: 3, text: 'こんにちは', final: true, source: 'asr' },
  );
  assert.equal(parseServerMessage('{"type":"turn_end","turn":3,"interrupted":true}').interrupted, true);
  // interrupted は真偽値だけ true とみなす
  assert.equal(parseServerMessage('{"type":"turn_end","turn":3,"interrupted":"yes"}').interrupted, false);
});

test('parseServerMessage: settings fills changed and rejected with []', () => {
  assert.deepEqual(
    parseServerMessage('{"type":"settings","settings":{"speed":1.2}}'),
    { type: 'settings', settings: { speed: 1.2 }, changed: [], rejected: [] },
  );
});

test('parseServerMessage: an unknown type becomes {type:"unknown", raw}', () => {
  assert.deepEqual(parseServerMessage('{"type":"future_thing","x":1}'), { type: 'unknown', raw: { type: 'future_thing', x: 1 } });
});

test('parseServerMessage: broken input gives null', () => {
  for (const bad of ['not json', '', '42', 'null', '[1,2]', '{"type":5}', '{}', '"str"']) {
    assert.equal(parseServerMessage(bad), null, JSON.stringify(bad));
  }
});

// ---- clampAriaSettings / settingsFromPrefs ------------------------------------------------------

test('clampAriaSettings: out-of-range numbers are pulled to the nearest end, ms values rounded to integers', () => {
  assert.deepEqual(clampAriaSettings({ speed: 9, pitch: -1, pre_ms: 2.6 }), { speed: 2, pitch: -0.15, pre_ms: 3 });
  assert.deepEqual(clampAriaSettings({ speed: 0, response_delay_ms: 99999, end_of_turn_ms: 1, barge_in_db: -100 }), {
    speed: 0.5, response_delay_ms: 3000, end_of_turn_ms: 200, barge_in_db: -70,
  });
  assert.deepEqual(clampAriaSettings({ barge_in_min_ms: 5000, volume: -3, intonation: 1.5 }), { barge_in_min_ms: 1500, volume: 0, intonation: 1.5 });
});

test('clampAriaSettings: unknown keys dropped, wrong types dropped, numeric strings accepted', () => {
  const out = clampAriaSettings({
    nope: 1, barge_in: 'yes', speed: 'abc', pitch: NaN, volume: Infinity, pause_scale: '1.5', pre_ms: null, tempo_dynamics: true,
  });
  assert.deepEqual(out, { pause_scale: 1.5 });
  assert.deepEqual(clampAriaSettings({ barge_in: false }), { barge_in: false });
});

test('clampAriaSettings: tts_mode only balanced or fast; voice up to 200 characters', () => {
  assert.deepEqual(clampAriaSettings({ tts_mode: 'fast' }), { tts_mode: 'fast' });
  assert.deepEqual(clampAriaSettings({ tts_mode: 'slow' }), {});
  assert.deepEqual(clampAriaSettings({ voice: 'v1' }), { voice: 'v1' });
  assert.deepEqual(clampAriaSettings({ voice: 'v'.repeat(201) }), {});
  assert.deepEqual(clampAriaSettings({ voice: 'v'.repeat(200) }), { voice: 'v'.repeat(200) });
});

test('settingsFromPrefs: out-of-range prefs are clamped to the Aria ranges', () => {
  assert.equal(settingsFromPrefs({ speed: 7 }).speed, 2);
  assert.equal(settingsFromPrefs({ endOfTurnMs: 1 }).end_of_turn_ms, 200);
  assert.equal(settingsFromPrefs({ responseDelayMs: 99999 }).response_delay_ms, 3000);
  assert.equal(settingsFromPrefs({ bargeInDb: 0 }).barge_in_db, -10);
});

// ---- audio --------------------------------------------------------------------------------------

test('floatToPcm16: the edges and the asymmetric scale (negative x32768, positive x32767), with clipping', () => {
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 0.5, -0.5]))), [0, 32767, -32768, 16384, -16384]);
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([2, -2, 1.5, -7]))), [32767, -32768, 32767, -32768]);
  assert.deepEqual(Array.from(floatToPcm16(new Float32Array([NaN]))), [0]);
});

test('pcm16ToFloat: little-endian bytes, and an odd byte length drops the last byte', () => {
  assert.deepEqual(Array.from(pcm16ToFloat(new Uint8Array([0x00, 0x40]).buffer)), [0.5]);
  assert.deepEqual(Array.from(pcm16ToFloat(new Uint8Array([0x00, 0x80]).buffer)), [-1]);
  assert.equal(pcm16ToFloat(new Uint8Array(5).buffer).length, 2);
  assert.deepEqual(Array.from(pcm16ToFloat(new Int16Array([16384, -32768]))), [0.5, -1]);
});

test('PCM round trip: each sample is within 1.5/32768 of the original (the bound from the x32767 / 32768 asymmetry)', () => {
  const xs = new Float32Array(2000);
  for (let i = 0; i < xs.length; i++) xs[i] = Math.sin(i * 0.37) * 0.999 + ((i % 7) - 3) / 3000;
  const back = pcm16ToFloat(floatToPcm16(xs).buffer);
  let worst = 0;
  for (let i = 0; i < xs.length; i++) worst = Math.max(worst, Math.abs(back[i] - xs[i]));
  assert.ok(worst <= 1.5 / 32768 + 1e-12, `worst error ${worst}`);
  // 端の値は 1/32768 以内
  assert.ok(Math.abs(pcm16ToFloat(floatToPcm16(new Float32Array([1, -1])))[0] - 1) <= 1 / 32768 + 1e-12);
});

test('downsampleTo16k: output length is floor(length * 16000 / inRate); 16 kHz input is returned as is', () => {
  const a = new Float32Array(48000);
  assert.equal(downsampleTo16k(a, 48000).length, 16000);
  assert.equal(downsampleTo16k(new Float32Array(1000), 24000).length, 666);
  assert.equal(downsampleTo16k(new Float32Array(44100), 44100).length, 16000);
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(downsampleTo16k(same, 16000), same);
  // 16 kHz より小さい入力はアップサンプルしない
  assert.equal(downsampleTo16k(same, 8000), same);
});

test('downsampleTo16k: each output sample averages its input range', () => {
  // 32 kHz -> 16 kHz: 2 入力ごとに平均
  const out = downsampleTo16k(new Float32Array([1, 0, 1, 0]), 32000);
  assert.deepEqual(Array.from(out), [0.5, 0.5]);
  const flat = downsampleTo16k(new Float32Array(300).fill(0.25), 48000);
  assert.ok(flat.every((x) => Math.abs(x - 0.25) < 1e-6));
});

test('pcmChunkDurationSec: mono 16-bit, zero for a rate of 0 or less', () => {
  assert.equal(pcmChunkDurationSec(32000, 16000), 1);
  assert.equal(pcmChunkDurationSec(3200, 16000), 0.1);
  assert.equal(pcmChunkDurationSec(0, 16000), 0);
  assert.equal(pcmChunkDurationSec(100, 0), 0);
});

// ---- TurnGate -----------------------------------------------------------------------------------

test('TurnGate: a stale turn is dropped, and the current and later turns are accepted', () => {
  const g = new TurnGate();
  assert.equal(g.current, 0);
  g.start(2);
  assert.equal(g.current, 2);
  assert.equal(g.accept(1), false);
  assert.equal(g.accept(2), true);
  assert.equal(g.accept(3), true);
  g.start(1); // 巻き戻さない
  assert.equal(g.current, 2);
});

test('TurnGate: interrupting the current turn drops its later data; the next turn is accepted', () => {
  const g = new TurnGate();
  g.start(1);
  g.interrupt();
  assert.equal(g.accept(1), false);
  g.start(2);
  assert.equal(g.accept(2), true);
  assert.equal(g.accept(1), false);
});

test('TurnGate: a restart of an interrupted turn stays interrupted; interrupt(turn) marks that turn', () => {
  const g = new TurnGate();
  g.start(1);
  g.interrupt(1);
  g.start(1);
  assert.equal(g.accept(1), false);
  g.interrupt(4);
  assert.equal(g.current, 4);
  assert.equal(g.accept(4), false);
  assert.equal(g.accept(5), true);
});

// ---- applyServerMsg / addUserText ---------------------------------------------------------------

test('applyServerMsg: partial transcript updates the same line, final confirms it', () => {
  let lines = [];
  lines = applyServerMsg(lines, { type: 'transcript', turn: 1, text: 'こん', final: false, source: 'asr' });
  assert.deepEqual(lines, [{ id: 'u1', role: 'user', text: 'こん', final: false, turn: 1 }]);
  lines = applyServerMsg(lines, { type: 'transcript', turn: 1, text: 'こんにちは', final: false, source: 'asr' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'こんにちは');
  lines = applyServerMsg(lines, { type: 'transcript', turn: 1, text: 'こんにちは。', final: true, source: 'asr' });
  assert.deepEqual(lines, [{ id: 'u1', role: 'user', text: 'こんにちは。', final: true, turn: 1 }]);
});

test('applyServerMsg: transcript_retract removes the last user line', () => {
  let lines = [];
  lines = applyServerMsg(lines, { type: 'transcript', turn: 1, text: 'A', final: true, source: 'asr' });
  lines = applyServerMsg(lines, { type: 'text', turn: 1, delta: 'x' });
  lines = applyServerMsg(lines, { type: 'transcript', turn: 2, text: 'B', final: false, source: 'asr' });
  lines = applyServerMsg(lines, { type: 'transcript_retract' });
  assert.deepEqual(lines.map((l) => l.id), ['u1', 'a1']);
});

test('applyServerMsg: text deltas concatenate on the assistant line; turn_end and interrupted finalize it', () => {
  let lines = [];
  lines = applyServerMsg(lines, { type: 'text', turn: 1, delta: 'こ' });
  lines = applyServerMsg(lines, { type: 'text', turn: 1, delta: 'んにちは' });
  assert.deepEqual(lines, [{ id: 'a1', role: 'assistant', text: 'こんにちは', final: false, turn: 1 }]);
  lines = applyServerMsg(lines, { type: 'turn_end', turn: 1, interrupted: false });
  assert.equal(lines[0].final, true);
  assert.equal(lines[0].text, 'こんにちは');

  let lines2 = applyServerMsg([], { type: 'text', turn: 2, delta: 'abc' });
  lines2 = applyServerMsg(lines2, { type: 'interrupted', turn: 2 });
  assert.deepEqual(lines2, [{ id: 'a2', role: 'assistant', text: 'abc', final: true, turn: 2 }]);
});

test('applyServerMsg: other messages return the same array; input arrays are not mutated', () => {
  const lines = [{ id: 'u1', role: 'user', text: 'A', final: true, turn: 1 }];
  const snapshot = JSON.stringify(lines);
  assert.equal(applyServerMsg(lines, { type: 'turn_start', turn: 2 }), lines);
  assert.equal(applyServerMsg(lines, { type: 'pong' }), lines);
  const out = applyServerMsg(lines, { type: 'text', turn: 1, delta: 'z' });
  assert.notEqual(out, lines);
  assert.equal(JSON.stringify(lines), snapshot);
});

test('addUserText: appends a final user line; the same turn replaces its line', () => {
  let lines = addUserText([], 'やあ', 3);
  assert.deepEqual(lines, [{ id: 'u3', role: 'user', text: 'やあ', final: true, turn: 3 }]);
  lines = addUserText(lines, 'やっほー', 3);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'やっほー');
});
