// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/ariaVoiceO.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSettings, FrameChunker, opusFrameSamples, opusInputRate, resolveCodec, settingsFromPrefs } from '../voice/ariaProtocol.ts';
import { normalizeVoice, VOICE_DEFAULTS } from '../voice/voiceSettings.ts';

test('normalizeVoice: codec defaults to pcm16 and only accepts the two values', () => {
  assert.equal(VOICE_DEFAULTS.codec, 'pcm16');
  assert.equal(normalizeVoice(undefined).codec, 'pcm16');
  assert.equal(normalizeVoice({ codec: 'opus' }).codec, 'opus');
  assert.equal(normalizeVoice({ codec: 'pcm16' }).codec, 'pcm16');
  assert.equal(normalizeVoice({ codec: 'mp3' }).codec, 'pcm16');
  assert.equal(normalizeVoice({ codec: 5 }).codec, 'pcm16');
});

test('normalizeVoice: old stored objects (url, token, ...) reduce to the device-local fields', () => {
  assert.deepEqual(normalizeVoice({ url: 'https://a', user: 'u', token: 'T', adminToken: 'A', speed: 9, codec: 'opus', pushToTalk: true }), { codec: 'opus', pushToTalk: true, privateDefault: false });
  assert.deepEqual(normalizeVoice({ url: 'https://a', token: 'T' }), { codec: 'pcm16', pushToTalk: false, privateDefault: false });
});

test('diffSettings: only the changed keys', () => {
  const base = { speed: 1, tts_mode: 'balanced', barge_in: true };
  assert.deepEqual(diffSettings(base, { ...base }), {});
  assert.deepEqual(diffSettings(base, { ...base, speed: 1.2 }), { speed: 1.2 });
  assert.deepEqual(diffSettings(base, { ...base, tts_mode: 'fast', barge_in: false }), { tts_mode: 'fast', barge_in: false });
  // a key that is new in next is sent; a key missing from next is not
  assert.deepEqual(diffSettings(base, { speed: 1, voice: 'x' }), { voice: 'x' });
});

test('diffSettings works on settingsFromPrefs output', () => {
  const prev = settingsFromPrefs({});
  assert.deepEqual(diffSettings(prev, settingsFromPrefs({ bargeInDb: -50, speed: 1.2 })), { speed: 1.2, barge_in_db: -50 });
  assert.deepEqual(diffSettings(prev, settingsFromPrefs({})), {});
});

test('opusFrameSamples: 20 ms', () => {
  assert.equal(opusFrameSamples(48000), 960);
  assert.equal(opusFrameSamples(16000), 320);
});

test('opusInputRate: 48 kHz stays, others go to 16 kHz, below 16 kHz is unusable', () => {
  assert.equal(opusInputRate(48000), 48000);
  assert.equal(opusInputRate(44100), 16000);
  assert.equal(opusInputRate(16000), 16000);
  assert.equal(opusInputRate(8000), null);
});

test('resolveCodec: falls back to pcm16 only when opus was wanted and is missing', () => {
  assert.deepEqual(resolveCodec('opus', true), { codec: 'opus', fellBack: false });
  assert.deepEqual(resolveCodec('opus', false), { codec: 'pcm16', fellBack: true });
  assert.deepEqual(resolveCodec('pcm16', false), { codec: 'pcm16', fellBack: false });
  assert.deepEqual(resolveCodec('pcm16', true), { codec: 'pcm16', fellBack: false });
});

test('FrameChunker: exact frames, remainder carried over', () => {
  const c = new FrameChunker(4);
  assert.equal(c.push(Float32Array.from([1, 2, 3])).length, 0);
  const out = c.push(Float32Array.from([4, 5, 6, 7, 8, 9]));
  assert.equal(out.length, 2);
  assert.deepEqual(Array.from(out[0]), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(out[1]), [5, 6, 7, 8]);
  const rest = c.push(Float32Array.from([10, 11, 12]));
  assert.deepEqual(Array.from(rest[0]), [9, 10, 11, 12]);
  c.push(Float32Array.from([1]));
  c.reset();
  assert.equal(c.push(Float32Array.from([1, 2, 3])).length, 0);
});

test('FrameChunker: frames do not alias the internal buffer', () => {
  const c = new FrameChunker(2);
  const [a] = c.push(Float32Array.from([1, 2]));
  c.push(Float32Array.from([3, 4]));
  assert.deepEqual(Array.from(a), [1, 2]);
});
