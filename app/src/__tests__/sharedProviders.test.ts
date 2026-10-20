// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/sharedProviders.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedModelsOf, buildGrantLines, canAddOwnProvider, grantBodyFor, grantChoiceOf, grantDisplayName,
  orphanGrants, parseDefaultSharedAccess, providerActions, validateGrantModels, GRANT_MODELS_MAX, GRANT_MODEL_CHARS_MAX,
} from '../sharedProviders';
import { en, ja } from '../i18n/sharedStrings';

test('provider actions: a read-only shared provider has no edit, delete or share', () => {
  const a = providerActions({ kind: 'openai-compatible', readOnly: true, shared: true }, true);
  assert.equal(a.readOnly, true);
  assert.equal(a.canEdit, false);
  assert.equal(a.canDelete, false);
  assert.equal(a.canShare, false);
  assert.equal(a.showSharedBadge, true);
});

test('provider actions: the admin can share an own provider, but not a dsh-bridge', () => {
  assert.equal(providerActions({ kind: 'openai-compatible', shared: false }, true).canShare, true);
  assert.equal(providerActions({ kind: 'dsh-bridge', shared: false }, true).canShare, false);
  assert.equal(providerActions({ kind: 'openai-compatible', shared: false }, false).canShare, false);
});

test('provider actions: an own provider shows the badge only when shared; an old server (no flags) is editable', () => {
  assert.equal(providerActions({ kind: 'openai-compatible', shared: true }, true).showSharedBadge, true);
  assert.equal(providerActions({ kind: 'openai-compatible', shared: false }, true).showSharedBadge, false);
  const old = providerActions({ kind: 'openai-compatible' }, false);
  assert.equal(old.canEdit, true);
  assert.equal(old.canDelete, true);
  assert.equal(old.showSharedBadge, false);
});

test('adding own providers: admin always; others only when not turned off (unknown = allowed)', () => {
  assert.equal(canAddOwnProvider(true, false), true);
  assert.equal(canAddOwnProvider(false, false), false);
  assert.equal(canAddOwnProvider(false, true), true);
  assert.equal(canAddOwnProvider(false, undefined), true);
});

test('allowed models: list or all, default all', () => {
  assert.equal(allowedModelsOf({ allowedModels: 'all' }), 'all');
  assert.deepEqual(allowedModelsOf({ allowedModels: ['a', 'b'] }), ['a', 'b']);
  assert.equal(allowedModelsOf({}), 'all');
});

test('default shared access: only "all" opens access, anything else is none', () => {
  assert.equal(parseDefaultSharedAccess('all'), 'all');
  assert.equal(parseDefaultSharedAccess('none'), 'none');
  assert.equal(parseDefaultSharedAccess(undefined), 'none');
  assert.equal(parseDefaultSharedAccess('yes'), 'none');
});

test('grant choice and body: default removes the row, list keeps distinct trimmed ids', () => {
  assert.equal(grantChoiceOf(undefined), 'default');
  assert.equal(grantChoiceOf({ providerId: 'p', mode: 'none', models: [] }), 'none');
  assert.equal(grantBodyFor('default', []), null);
  assert.deepEqual(grantBodyFor('all', ['x']), { mode: 'all' });
  assert.deepEqual(grantBodyFor('none', []), { mode: 'none' });
  assert.deepEqual(grantBodyFor('list', [' a ', 'b', 'a', '']), { mode: 'list', models: ['a', 'b'] });
});

test('grant model validation: at least one model, bounded count and length', () => {
  assert.equal(validateGrantModels(['']), 'shared.grant.needModel');
  assert.equal(validateGrantModels(['a']), null);
  const many = Array.from({ length: GRANT_MODELS_MAX + 1 }, (_, i) => 'm' + i);
  assert.equal(validateGrantModels(many), 'shared.grant.tooMany');
  assert.equal(validateGrantModels(['x'.repeat(GRANT_MODEL_CHARS_MAX + 1)]), 'shared.grant.modelTooLong');
});

test('grant lines: one per shared provider, with the name and the current choice', () => {
  const shared = [{ id: 'p1', name: 'Home LLM', kind: 'openai-compatible', ownerUserId: 'admin' }, { id: 'p2', name: 'API', kind: 'openai-compatible', ownerUserId: 'admin' }];
  const grants = [{ providerId: 'p2', mode: 'list', models: ['gpt'] }];
  const lines = buildGrantLines(shared, grants);
  assert.deepEqual(lines, [
    { providerId: 'p1', name: 'Home LLM', choice: 'default', models: [] },
    { providerId: 'p2', name: 'API', choice: 'list', models: ['gpt'] },
  ]);
});

test('grants on a provider that is no longer shared are reported as orphans; names fall back to the id', () => {
  const shared = [{ id: 'p1', name: 'Home LLM', kind: 'x', ownerUserId: 'admin' }];
  const grants = [{ providerId: 'p1', mode: 'all', models: [] }, { providerId: 'gone', mode: 'all', models: [] }];
  assert.deepEqual(orphanGrants(shared, grants).map((g) => g.providerId), ['gone']);
  assert.equal(grantDisplayName('p1', [{ id: 'p1', name: 'Home LLM' }]), 'Home LLM');
  assert.equal(grantDisplayName('gone', []), 'gone');
});

test('shared strings: English and Japanese have the same keys and no empty text', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort());
  for (const [k, v] of Object.entries({ ...en, ...ja })) assert.ok(v.trim().length > 0, k);
});
