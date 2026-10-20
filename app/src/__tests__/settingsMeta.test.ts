// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/settingsMeta.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SETTINGS_PAGES, SETTINGS_META } from '../settingsMeta';
import en from '../i18n/en';
import ja from '../i18n/ja';

test('Updates is its own settings page, between Plugins and Connections', () => {
  const ids = SETTINGS_PAGES.map((p) => p.id);
  assert.ok(ids.includes('updates'));
  assert.equal(ids.indexOf('updates'), ids.indexOf('plugins') + 1);
  assert.equal(ids.indexOf('connections'), ids.indexOf('updates') + 1);
  for (const p of SETTINGS_PAGES) {
    assert.ok(en[p.titleKey], p.titleKey);
    assert.ok(ja[p.titleKey], p.titleKey);
  }
  assert.equal(ja['settings.page.updates'], 'アップデート');
});

test('the search metadata for updates is on the updates page, not General', () => {
  const metas = Object.values(SETTINGS_META);
  assert.ok(metas.some((m) => m.page === 'updates'));
  for (const m of metas.filter((m) => m.page === 'updates')) {
    assert.ok(en[m.labelKey] && ja[m.labelKey], m.labelKey);
  }
  assert.ok(!metas.some((m) => m.page === 'general' && /update/i.test(m.labelKey)));
});

test('GeneralPage no longer renders the updates section', () => {
  const src = readFileSync(join(__dirname, '..', 'screens', 'settings', 'GeneralPage.tsx'), 'utf8');
  assert.ok(!/UpdatesSection/.test(src));
  const upd = readFileSync(join(__dirname, '..', 'screens', 'settings', 'UpdatesPage.tsx'), 'utf8');
  assert.ok(/UpdatesSection/.test(upd));
});
