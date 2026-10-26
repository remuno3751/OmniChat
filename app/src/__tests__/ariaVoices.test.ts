// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/ariaVoices.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callTimeParts, checkVoiceFile, deletePath, isBuiltinVoice, isCurrentStyle, kindForTtsMode, MAX_VOICE_BYTES, modelKind,
  modelVoiceId, parseServerVoices, parseVoices, uploadPath,
} from '../voice/ariaVoices';

test('parseVoices: array of models with speakers and styles', () => {
  const r = parseVoices([{ uuid: 'u1', name: 'A', license: 'CC-BY', speakers: [{ name: 'sp', styles: [{ id: 10, name: 'normal' }, { id: 'x', name: 'soft' }] }] }]);
  assert.deepEqual(r, [{ uuid: 'u1', name: 'A', license: 'CC-BY', speakers: [{ name: 'sp', styles: [{ id: '10', name: 'normal' }, { id: 'x', name: 'soft' }] }] }]);
});
test('parseVoices: wrapped object, alternative keys, license object, styles as map / bare ids', () => {
  const r = parseVoices({ models: [{ id: 'm', model_name: 'B', license: { name: 'Custom' }, speakers: [{ styles: { a: 1, b: 2 } }, { styles: [5, 6] }] }] });
  assert.equal(r[0].uuid, 'm'); assert.equal(r[0].name, 'B'); assert.equal(r[0].license, 'Custom');
  assert.deepEqual(r[0].speakers[0].styles, [{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
  assert.deepEqual(r[0].speakers[1].styles.map((x) => x.id), ['5', '6']);
});
test('parseVoices: missing / unknown values never throw', () => {
  for (const x of [null, undefined, 5, 'x', {}, [], [null, 1, 'a', {}], { voices: 'no' }, [{ name: 'N' }], [{ speakers: [{ styles: [null, {}] }] }]]) {
    assert.ok(Array.isArray(parseVoices(x)));
  }
  assert.deepEqual(parseVoices([{ name: 'N' }]), [{ uuid: '', name: 'N', license: '', speakers: [] }]);
  assert.equal(parseVoices([null, {}, { name: 'ok' }]).length, 1);
});
test('isCurrentStyle', () => {
  assert.ok(isCurrentStyle('10', '10')); assert.ok(!isCurrentStyle('', '')); assert.ok(!isCurrentStyle('1', '10'));
});
test('checkVoiceFile (standard): only .aivmx, with the part', () => {
  assert.deepEqual(checkVoiceFile('aivmx', 'a.AIVMX', 100), { ok: true, name: 'a.AIVMX', part: 'aivmx' });
  assert.deepEqual(checkVoiceFile('aivmx', 'C:\\x\\v.aivmx', 1), { ok: true, name: 'v.aivmx', part: 'aivmx' });
  assert.deepEqual(checkVoiceFile('aivmx', 'm.onnx', 100), { ok: false, reason: 'ext' });
  assert.deepEqual(checkVoiceFile('aivmx', 'a.pth', 100), { ok: false, reason: 'ext' });
  assert.deepEqual(checkVoiceFile('aivmx', 'a.aivm', 100), { ok: false, reason: 'ext' });
  assert.deepEqual(checkVoiceFile('aivmx', '.aivmx', 100), { ok: false, reason: 'ext' });
  assert.deepEqual(checkVoiceFile('aivmx', 'a', 100), { ok: false, reason: 'ext' });
});
test('checkVoiceFile (fast / piper): .onnx is the model, .json the config, .zip both; others refused', () => {
  assert.deepEqual(checkVoiceFile('piper', 'v.onnx', 100), { ok: true, name: 'v.onnx', part: 'model' });
  assert.deepEqual(checkVoiceFile('piper', 'v.ONNX.json', 100), { ok: true, name: 'v.ONNX.json', part: 'config' });
  assert.deepEqual(checkVoiceFile('piper', 'v.zip', 100), { ok: true, name: 'v.zip', part: 'zip' });
  assert.deepEqual(checkVoiceFile('piper', 'v.aivmx', 100), { ok: false, reason: 'ext' });
  assert.deepEqual(checkVoiceFile('piper', 'v.pth', 100), { ok: false, reason: 'ext' });
});
test('checkVoiceFile: empty, size cap and name', () => {
  assert.deepEqual(checkVoiceFile('aivmx', 'a.aivmx', 0), { ok: false, reason: 'empty' });
  assert.deepEqual(checkVoiceFile('piper', 'a.onnx', NaN), { ok: false, reason: 'empty' });
  assert.deepEqual(checkVoiceFile('aivmx', 'a.aivmx', MAX_VOICE_BYTES), { ok: true, name: 'a.aivmx', part: 'aivmx' });
  assert.deepEqual(checkVoiceFile('piper', 'a.zip', MAX_VOICE_BYTES + 1), { ok: false, reason: 'size' });
  assert.deepEqual(checkVoiceFile('aivmx', '', 5), { ok: false, reason: 'name' });
});
test('kinds: a model without a kind is standard; the mode picks the kind', () => {
  assert.equal(modelKind({}), 'aivmx');
  assert.equal(modelKind({ kind: 'piper' }), 'piper');
  assert.equal(kindForTtsMode('fast'), 'piper');
  assert.equal(kindForTtsMode('balanced'), 'aivmx');
  assert.equal(kindForTtsMode(undefined), 'aivmx');
});
test('isBuiltinVoice: builtin flag or the tsukuyomi id', () => {
  assert.ok(isBuiltinVoice({ uuid: 'tsukuyomi' }));
  assert.ok(isBuiltinVoice({ uuid: 'x', builtin: true }));
  assert.ok(!isBuiltinVoice({ uuid: 'x', builtin: false }));
});
test('modelVoiceId: piper uses the id (uuid, else name); aivmx uses the first style', () => {
  const m = { uuid: '', name: 'jp-voice', speakers: [{ name: 'sp', styles: [{ id: '7', name: 'n' }] }] };
  assert.equal(modelVoiceId({ ...m, uuid: 'pid' }, 'piper'), 'pid');
  assert.equal(modelVoiceId(m, 'piper'), 'jp-voice');
  assert.equal(modelVoiceId(m, 'aivmx'), '7');
  assert.equal(modelVoiceId({ uuid: 'u', name: 'n', speakers: [] }, 'aivmx'), '');
});
test('callTimeParts: whole minutes and seconds; bad input is 0', () => {
  assert.deepEqual(callTimeParts(125.9), { min: 2, sec: 5 });
  assert.deepEqual(callTimeParts(59), { min: 0, sec: 59 });
  assert.deepEqual(callTimeParts(0), { min: 0, sec: 0 });
  assert.deepEqual(callTimeParts(-3), { min: 0, sec: 0 });
  assert.deepEqual(callTimeParts(NaN), { min: 0, sec: 0 });
});
test('parseServerVoices keeps kind and builtin only when they are given', () => {
  const [a, b] = parseServerVoices([{ uuid: 'p', name: 'P', kind: 'piper', speakers: [] }, { uuid: 't', name: 'T', kind: 'nope', builtin: true }]);
  assert.equal(a.kind, 'piper'); assert.equal(a.builtin, undefined);
  assert.equal(b.kind, undefined); assert.equal(b.builtin, true);
});
test('paths are encoded', () => {
  assert.equal(uploadPath('a b&c.aivmx'), '/voices/models?name=a%20b%26c.aivmx');
  assert.equal(deletePath('a/b'), '/voices/models/a%2Fb');
});
