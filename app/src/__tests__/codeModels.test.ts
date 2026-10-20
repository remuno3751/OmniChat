// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/codeModels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { codeModelView } from '../codeModels';

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
  assert.equal(v.groups.length, 3);
  assert.deepEqual(v.groups.map((g) => g.providerId), ['openai', 'pc1', 'pc2']);
});

test('no groups at all: null -> empty list with fallback', () => {
  assert.deepEqual(codeModelView(null, null, LABELS), { groups: [], fallback: true });
  assert.deepEqual(codeModelView(null, 'pc1', LABELS), { groups: [], fallback: true });
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
