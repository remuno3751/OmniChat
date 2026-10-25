// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeModels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeErrorKey, codeModelView, codeStartSel, fromCodeSel, isPlaceholderModel, isWrappedCodeSel, lastCodeSel, toCodeSel } from '../codeModels';

const LABELS = { current: 'DSH current', imported: 'OmniChat' };

const chat = {
  providerId: 'openai',
  providerName: 'OpenAI',
  kind: 'openai',
  models: [{ id: 'gpt-x', name: 'GPT X' }],
};

function bridge(providerId, providerName, models, extra = {}) {
  return { providerId, providerName, kind: 'dsh-bridge', models, ...extra };
}

test('chat groups are hidden in code view when a bridge has models', () => {
  const groups = [chat, bridge('pc1', 'PC', [{ id: 'lmstudio::a', name: 'A', group: 'LM Studio' }])];
  const v = codeModelView(groups, null, LABELS);
  assert.equal(v.fallback, false);
  assert.deepEqual(v.groups.map((g) => g.providerId), ['pc1']);
});

test('bridge models are sub-grouped by dsh group with titles', () => {
  const groups = [
    bridge('pc1', 'PC', [
      { id: 'lmstudio::a', name: 'A', group: 'LM Studio' },
      { id: 'ollama::b', name: 'B', group: 'Ollama' },
      { id: 'lmstudio::c', name: 'C', group: 'LM Studio' },
    ]),
  ];
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.equal(v.groups.length, 2);
  assert.equal(v.groups[0].providerName, 'PC · LM Studio');
  assert.equal(v.groups[0].subKey, 'LM Studio');
  assert.deepEqual(v.groups[0].models.map((m) => m.id), ['lmstudio::a', 'lmstudio::c']);
  assert.equal(v.groups[1].providerName, 'PC · Ollama');
  assert.equal(v.groups[1].subKey, 'Ollama');
  assert.deepEqual(v.groups[1].models.map((m) => m.id), ['ollama::b']);
  // original provider fields are kept
  assert.equal(v.groups[1].providerId, 'pc1');
  assert.equal(v.groups[1].kind, 'dsh-bridge');
});

test('selected bridge limits the view; other selection shows all bridges', () => {
  const groups = [
    chat,
    bridge('pc1', 'PC 1', [{ id: 'p::a', name: 'A', group: 'G1' }]),
    bridge('pc2', 'PC 2', [{ id: 'q::b', name: 'B', group: 'G2' }]),
  ];
  const only2 = codeModelView(groups, 'pc2', LABELS);
  assert.deepEqual(only2.groups.map((g) => g.providerId), ['pc2']);

  const selectedChat = codeModelView(groups, 'openai', LABELS);
  assert.deepEqual(selectedChat.groups.map((g) => g.providerId), ['pc1', 'pc2']);

  const none = codeModelView(groups, null, LABELS);
  assert.deepEqual(none.groups.map((g) => g.providerId), ['pc1', 'pc2']);
});

test('current and imported decorate names, current first', () => {
  const groups = [
    bridge('pc1', 'PC', [
      { id: 'p::a', name: 'A', group: 'G', current: true },
      { id: 'p::b', name: 'B', group: 'G', imported: true },
      { id: 'p::c', name: 'C', group: 'G', current: true, imported: true },
      { id: 'p::d', name: 'D', group: 'G' },
    ]),
  ];
  const names = codeModelView(groups, 'pc1', LABELS).groups[0].models.map((m) => m.name);
  assert.deepEqual(names, ['A · DSH current', 'B · OmniChat', 'C · DSH current · OmniChat', 'D']);
});

test('old plugin (no group fields) is grouped by id prefix', () => {
  const groups = [
    bridge('pc1', 'PC', [
      { id: 'lmstudio::a', name: 'a (lmstudio)' },
      { id: 'ollama::b', name: 'b (ollama)' },
      { id: 'lmstudio::c', name: 'c (lmstudio)' },
    ]),
  ];
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.equal(v.fallback, false);
  assert.deepEqual(v.groups.map((g) => g.subKey), ['lmstudio', 'ollama']);
  assert.deepEqual(v.groups.map((g) => g.providerName), ['PC · lmstudio', 'PC · ollama']);
  assert.deepEqual(v.groups[0].models.map((m) => m.name), ['a (lmstudio)', 'c (lmstudio)']);
});

test('no bridge with models -> fallback with all groups returned', () => {
  const groups = [
    chat,
    bridge('pc1', 'PC', [], { error: 'DSH unreachable' }),
    bridge('pc2', 'PC 2', []),
  ];
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.equal(v.fallback, true);
  assert.equal(v.dshNote, true);
  // the bridges themselves are never listed as models
  assert.deepEqual(v.groups.map((g) => g.providerId), ['openai']);
});

test('no groups at all: null -> empty list with fallback', () => {
  assert.deepEqual(codeModelView(null, null, LABELS), { groups: [], fallback: true, dshNote: true });
  assert.deepEqual(codeModelView(null, 'pc1', LABELS), { groups: [], fallback: true, dshNote: true });
});

test('input is not mutated and output objects are new', () => {
  const groups = [
    bridge('pc1', 'PC', [
      { id: 'p::a', name: 'A', group: 'G', current: true },
      { id: 'q::b', name: 'B', group: '' },
    ]),
  ];
  const snapshot = JSON.parse(JSON.stringify(groups));
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.deepEqual(groups, snapshot);
  assert.equal(groups[0].subKey, undefined);
  assert.equal(groups[0].models[0].name, 'A');
  for (const g of v.groups) {
    assert.notEqual(g, groups[0]);
    for (const m of g.models) assert.ok(!groups[0].models.includes(m));
  }
});

test('empty dsh group name keeps the bridge name only', () => {
  const groups = [bridge('pc1', 'PC', [{ id: 'x::a', name: 'A', group: '' }])];
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.equal(v.groups.length, 1);
  assert.equal(v.groups[0].subKey, '');
  assert.equal(v.groups[0].providerName, 'PC');
});

const KINDS: Record<string, string> = { openai: 'openai', bonsai: 'openai-compatible', vs: 'vscode-bridge', vs2: 'vscode-bridge', dsh: 'dsh-bridge' };
const kindOf = (id: string) => KINDS[id];
const CUSTOM = { id: 'custom', name: 'カスタムのモデル (ID…)' };

test('VS Code bridge with only placeholder models: fallback to model providers, no DSH note', () => {
  const groups = [
    chat,
    { providerId: 'bonsai', providerName: 'Bonsai', kind: 'openai-compatible', models: [{ id: 'bonsai2', name: 'Bonsai 2' }] },
    { providerId: 'vs', providerName: 'VS CODE (PC BRIDGE)', kind: 'vscode-bridge', models: [CUSTOM, CUSTOM, CUSTOM] },
  ];
  const v = codeModelView(groups, 'vs', LABELS);
  assert.equal(v.fallback, true);
  assert.equal(v.dshNote, false);
  assert.deepEqual(v.groups.map((g) => g.providerId), ['openai', 'bonsai']);
});

test('placeholder entries are dropped from a bridge that also has real models', () => {
  const groups = [bridge('pc1', 'PC', [CUSTOM, { id: 'lmstudio::a', name: 'A', group: 'LM Studio' }])];
  const v = codeModelView(groups, 'pc1', LABELS);
  assert.equal(v.fallback, false);
  assert.deepEqual(v.groups[0].models.map((m) => m.id), ['lmstudio::a']);
});

test('isPlaceholderModel recognises the custom entries only', () => {
  assert.equal(isPlaceholderModel(CUSTOM), true);
  assert.equal(isPlaceholderModel({ id: '', name: 'x' }), true);
  assert.equal(isPlaceholderModel({ id: 'bonsai2', name: 'Bonsai 2' }), false);
});

test('toCodeSel keeps the bridge and wraps the picked model', () => {
  const cur = { providerId: 'vs', model: null };
  assert.deepEqual(toCodeSel(cur, { providerId: 'bonsai', model: 'bonsai2' }, kindOf), { providerId: 'vs', model: 'bonsai::bonsai2' });
  // picking another bridge (a device) is taken as it is
  assert.deepEqual(toCodeSel(cur, { providerId: 'vs2', model: null }, kindOf), { providerId: 'vs2', model: null });
  // not a Code selection: unchanged
  assert.deepEqual(toCodeSel({ providerId: 'openai', model: 'gpt-x' }, { providerId: 'bonsai', model: 'bonsai2' }, kindOf), { providerId: 'bonsai', model: 'bonsai2' });
  assert.deepEqual(toCodeSel(null, { providerId: 'bonsai', model: 'bonsai2' }, kindOf), { providerId: 'bonsai', model: 'bonsai2' });
});

test('fromCodeSel splits a wrapped model and leaves a bridge own model alone', () => {
  assert.deepEqual(fromCodeSel({ providerId: 'vs', model: 'bonsai::bonsai2' }, kindOf), { providerId: 'bonsai', model: 'bonsai2' });
  assert.deepEqual(fromCodeSel({ providerId: 'vs', model: 'bonsai2' }, kindOf), { providerId: 'vs', model: 'bonsai2' });
  // a DSH model id "lmstudio::a" where lmstudio is not a provider id
  assert.deepEqual(fromCodeSel({ providerId: 'dsh', model: 'lmstudio::a' }, kindOf), { providerId: 'dsh', model: 'lmstudio::a' });
  assert.deepEqual(fromCodeSel({ providerId: 'vs', model: null }, kindOf), { providerId: 'vs', model: null });
});

test('toCodeSel then fromCodeSel round-trips the picked model', () => {
  const sel = toCodeSel({ providerId: 'vs', model: null }, { providerId: 'bonsai', model: 'bonsai2' }, kindOf);
  assert.equal(isWrappedCodeSel(sel, kindOf), true);
  assert.deepEqual(fromCodeSel(sel, kindOf), { providerId: 'bonsai', model: 'bonsai2' });
});

test('codeStartSel: wrapped prior selection first, then the device own model, else null', () => {
  const wrapped = { providerId: 'vs', model: 'bonsai::bonsai2' };
  assert.deepEqual(codeStartSel('vs2', [null, wrapped], kindOf, 'own'), { providerId: 'vs2', model: 'bonsai::bonsai2' });
  // a plain chat model or a DSH own model is not carried to another device
  assert.deepEqual(codeStartSel('vs2', [{ providerId: 'openai', model: 'gpt-x' }, { providerId: 'dsh', model: 'lmstudio::a' }], kindOf, null), null);
  assert.deepEqual(codeStartSel('dsh', [], kindOf, 'lmstudio::a'), { providerId: 'dsh', model: 'lmstudio::a' });
  assert.equal(codeStartSel('vs', [], kindOf, null), null);
});

test('lastCodeSel: newest Code conversation with a wrapped model', () => {
  const convs = [
    { id: 'a', mode: 'chat', providerId: 'bonsai', model: 'bonsai2', updatedAt: 9 },
    { id: 'b', mode: 'code', providerId: 'vs', model: 'bonsai::bonsai2', updatedAt: 5 },
    { id: 'c', mode: 'code', providerId: 'vs', model: 'openai::gpt-x', updatedAt: 7 },
    { id: 'd', mode: 'code', providerId: 'vs', model: 'bonsai2', updatedAt: 8 },
  ] as any[];
  assert.deepEqual(lastCodeSel(convs, kindOf), { providerId: 'vs', model: 'openai::gpt-x' });
  assert.equal(lastCodeSel([], kindOf), null);
});

test('codeErrorKey maps the known English send error and the bridge code', () => {
  assert.equal(codeErrorKey('Choose a model for this Code chat (a provider and a model); the VS Code bridge itself has none.'), 'code.pickModelFirst');
  assert.equal(codeErrorKey('この Code の会話にはモデルが選ばれていません。'), 'code.pickModelFirst');
  assert.equal(codeErrorKey('whatever', 'code_not_bridge'), 'code.notBridge');
  assert.equal(codeErrorKey('Other error'), null);
  assert.equal(codeErrorKey(null), null);
});

test('codeErrorKey maps confirm_required and the no-tools error of the VS Code device', () => {
  assert.equal(codeErrorKey('approvalMode full needs confirmFull: true', 'confirm_required'), 'code.confirmRequired');
  assert.equal(codeErrorKey('VS Code から使えるツールがありません（拡張のバージョン・フォルダの信頼設定）'), 'code.noTools');
  assert.equal(codeErrorKey('Something else entirely'), null);
});
