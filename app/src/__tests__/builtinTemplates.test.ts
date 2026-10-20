// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/builtinTemplates.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import en from '../i18n/en';
import ja from '../i18n/ja';
import { BUILTIN_PROMPTS, buildSlashEntries, extractVars } from '../templates';

const trEn = (k: string) => en[k] ?? k;
const trJa = (k: string) => ja[k] ?? en[k] ?? k;
const userTpl = { id: 'u1', name: 'mine', description: '', kind: 'prompt', body: 'hello', projectId: null, deleted: false };

test('built-in email prompts are slash entries of kind prompt, before user templates', () => {
  const entries = buildSlashEntries([userTpl], null, trEn);
  const prompts = entries.filter((e) => e.key.startsWith('builtin:email.'));
  assert.equal(prompts.length, 5);
  assert.deepEqual(prompts.map((e) => e.key), BUILTIN_PROMPTS.map((p) => 'builtin:' + p.id));
  for (const p of prompts) assert.equal(p.kind, 'prompt');
  const idxLast = entries.findIndex((e) => e.key === 'builtin:email.schedule');
  const idxUser = entries.findIndex((e) => e.key === 'tpl:u1');
  assert.ok(idxLast < idxUser, 'built-in prompts come before user templates');
  // commands come first, then the built-in actions
  assert.equal(entries.find((e) => e.kind !== 'command').kind, 'action');
});

test('built-in prompts have localized names, descriptions and bodies', () => {
  const en5 = buildSlashEntries([], null, trEn).filter((e) => e.key.startsWith('builtin:email.'));
  for (const e of en5) {
    assert.ok(e.name && !e.name.startsWith('tpl.'), `en name for ${e.key}`);
    assert.ok(e.description && !e.description.startsWith('tpl.'), `en desc for ${e.key}`);
    assert.ok(e.body && !e.body.startsWith('tpl.'), `en body for ${e.key}`);
  }
  const ja5 = buildSlashEntries([], null, trJa).filter((e) => e.key.startsWith('builtin:email.'));
  assert.equal(ja5.find((e) => e.key === 'builtin:email.reply').name, '返信を作成');
  assert.equal(ja5.find((e) => e.key === 'builtin:email.schedule').name, '日程調整の返信');
  assert.notEqual(ja5[0].body, en5[0].body);
});

test('built-in prompt variables are extractable', () => {
  const entries = buildSlashEntries([], null, trEn);
  const vars = (id) => extractVars(entries.find((e) => e.key === 'builtin:' + id).body);
  assert.deepEqual(vars('email.reply'), ['email']);
  assert.deepEqual(vars('email.decline'), ['email']);
  assert.deepEqual(vars('email.shorten'), ['email']);
  assert.deepEqual(vars('email.polish'), ['text']);
  assert.deepEqual(vars('email.schedule').sort(), ['dates', 'email']);

  const jaEntries = buildSlashEntries([], null, trJa);
  assert.deepEqual(extractVars(jaEntries.find((e) => e.key === 'builtin:email.reply').body), ['email']);
  assert.deepEqual(extractVars(jaEntries.find((e) => e.key === 'builtin:email.polish').body), ['text']);
});

test('built-in prompt bodies ask for an artifact type=email answer', () => {
  const entries = buildSlashEntries([], null, trEn).filter((e) => e.key.startsWith('builtin:email.'));
  for (const e of entries) assert.match(e.body, /artifact type=email/, e.key);
});
