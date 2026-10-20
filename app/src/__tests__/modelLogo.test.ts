// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/modelLogo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFamily, genericFamily, brandFor, normalizeModelName } from '../components/modelFamily.ts';
import { FAMILY_STYLES, GENERIC_PALETTE } from '../components/modelLogoData.ts';

test('bonsai variants share one generic family, badge and colour', () => {
  const ids = ['bonsai2-4b-long', 'bonsai2-9b', 'bonsai2-9b-long', 'bonsai2-4b', 'bonsai2'];
  const fams = ids.map((id) => resolveFamily(id));
  for (const f of fams) {
    assert.equal(f.key, 'x:bonsai');
    assert.equal(f.name, 'Bonsai');
    assert.equal(f.monogram, 'B');
    assert.equal(f.bg, fams[0].bg);
    assert.equal(f.mark, undefined);
  }
});

test('ornith gets a monogram badge, not "?"', () => {
  const f = resolveFamily('ornith9b');
  assert.equal(f.key, 'x:ornith');
  assert.equal(f.monogram, 'O');
  assert.ok(GENERIC_PALETTE.includes(f.bg));
});

test('qwen3.8-flash-next-iq3_xxs resolves to the Qwen brand with its mark', () => {
  const f = resolveFamily('qwen3.8-flash-next-iq3_xxs');
  assert.equal(f.key, 'qwen');
  assert.equal(f.mark, 'qwen');
  assert.equal(f.name, 'Qwen');
});

test('case, separators, org prefix and :tag do not change the family', () => {
  assert.equal(resolveFamily('Qwen/Qwen3-8B:latest').key, 'qwen');
  assert.equal(resolveFamily('QWEN_3_8B').key, 'qwen');
  assert.equal(resolveFamily('lmstudio-community/Llama-3.2-1B-Instruct-GGUF').key, 'meta');
  assert.equal(resolveFamily('llama3:8b').key, 'meta');
  assert.equal(resolveFamily('google/gemma-3-4b-it').key, 'google');
  assert.equal(resolveFamily('gemma3:latest').key, 'google');
  assert.equal(resolveFamily('gpt-oss-20b').key, 'openai');
  assert.equal(resolveFamily('gptoss-120b').key, 'openai');
  assert.equal(resolveFamily('claude-3-5-haiku').key, 'anthropic');
  assert.equal(resolveFamily('Mistral-Small-3.1-24B').key, 'mistral');
  assert.equal(resolveFamily('DeepSeek-R1-Distill-Qwen-7B').key, 'deepseek');
  assert.equal(resolveFamily('phi4-mini').key, 'microsoft');
});

test('boundary-aware patterns do not match inside other words', () => {
  // 'phi' inside a longer word must not pick Microsoft; 'yi' inside 'yield' not 01.AI
  assert.notEqual(resolveFamily('graphibox-2b').key, 'microsoft');
  assert.notEqual(resolveFamily('yieldbot-1b').key, 'yi');
  assert.equal(resolveFamily('yi-coder-9b').key, 'yi');
});

test('family token skips size, quantisation and build tokens', () => {
  assert.equal(genericFamily('acme-270m-q4_k_m'), 'acme');
  assert.equal(genericFamily('4b-zephyr'), 'zephyr');
  assert.equal(genericFamily('zephyr-8bit-instruct'), 'zephyr');
  assert.equal(genericFamily('ornith9b'), 'ornith');
  assert.equal(genericFamily('bonsai2-4b-long'), 'bonsai');
  assert.equal(genericFamily('h2o-danube'), 'danube');
});

test('publisher is a secondary brand signal when the model name has no brand', () => {
  assert.equal(resolveFamily('some-model-7b', 'deepseek-ai').key, 'deepseek');
  // the model name still wins over the publisher when it has its own brand
  assert.equal(resolveFamily('llama-3-8b', 'Qwen').key, 'meta');
  // repackagers carry no maker information: the model's own family is used
  assert.equal(resolveFamily('bonsai2-9b', 'lmstudio-community').key, 'x:bonsai');
});

test('empty names keep "?"; everything else gets a real glyph', () => {
  for (const id of ['', '   ', undefined, null]) {
    const f = resolveFamily(id as string);
    assert.equal(f.key, '');
    assert.equal(f.monogram, '?');
  }
  for (const id of ['123', '---', 'h2o']) {
    const f = resolveFamily(id);
    assert.notEqual(f.monogram, '?');
    assert.ok(f.monogram.length >= 1);
  }
});

test('generic colour is stable for a family and every table brand has a style', () => {
  assert.equal(resolveFamily('ornith9b').bg, resolveFamily('ornith-2b').bg);
  for (const [key, st] of Object.entries(FAMILY_STYLES)) {
    assert.ok(st.mark || st.monogram, `${key} needs a mark or a monogram`);
    assert.match(st.bg, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('brandFor and normalizeModelName are exported and consistent', () => {
  assert.equal(normalizeModelName('Org/Model-X:Q4'), 'model-x');
  assert.equal(brandFor('qwq-32b'), 'qwen');
  assert.equal(brandFor('bonsai2-9b'), null);
});
