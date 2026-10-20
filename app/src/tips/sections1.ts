// Static Tips entries for the sections: keys, search, ephemeral, artifacts, code. All text lives in strings1.ts.
import type { TipEntry } from './types';

export const SECTIONS_1: TipEntry[] = [
  // ---- keys: keyboard shortcuts (only ones found in app code) ----
  {
    id: 'keys.enter', section: 'keys',
    titleKey: 'tips.keys.enter.title', bodyKey: 'tips.keys.enter.body',
    exampleKey: 'tips.keys.enter.example', keywordsKey: 'tips.keys.enter.kw',
  },
  {
    id: 'keys.search', section: 'keys',
    titleKey: 'tips.keys.search.title', bodyKey: 'tips.keys.search.body',
    exampleKey: 'tips.keys.search.example', keywordsKey: 'tips.keys.search.kw',
  },
  {
    id: 'keys.slash', section: 'keys',
    titleKey: 'tips.keys.slash.title', bodyKey: 'tips.keys.slash.body',
    exampleKey: 'tips.keys.slash.example', keywordsKey: 'tips.keys.slash.kw',
  },
  {
    id: 'keys.esc', section: 'keys',
    titleKey: 'tips.keys.esc.title', bodyKey: 'tips.keys.esc.body',
    exampleKey: 'tips.keys.esc.example', keywordsKey: 'tips.keys.esc.kw',
  },
  {
    id: 'keys.slider', section: 'keys',
    titleKey: 'tips.keys.slider.title', bodyKey: 'tips.keys.slider.body',
    exampleKey: 'tips.keys.slider.example', keywordsKey: 'tips.keys.slider.kw',
  },

  // ---- search: web search modes ----
  {
    id: 'search.modes', section: 'search',
    titleKey: 'tips.search.modes.title', bodyKey: 'tips.search.modes.body',
    exampleKey: 'tips.search.modes.example', keywordsKey: 'tips.search.modes.kw',
  },
  {
    id: 'search.smart', section: 'search',
    titleKey: 'tips.search.smart.title', bodyKey: 'tips.search.smart.body',
    keywordsKey: 'tips.search.smart.kw',
  },
  {
    id: 'search.auto', section: 'search',
    titleKey: 'tips.search.auto.title', bodyKey: 'tips.search.auto.body',
    keywordsKey: 'tips.search.auto.kw',
  },
  {
    id: 'search.always', section: 'search',
    titleKey: 'tips.search.always.title', bodyKey: 'tips.search.always.body',
    keywordsKey: 'tips.search.always.kw',
  },
  {
    id: 'search.where', section: 'search',
    titleKey: 'tips.search.where.title', bodyKey: 'tips.search.where.body',
    exampleKey: 'tips.search.where.example', keywordsKey: 'tips.search.where.kw',
    action: { action: { kind: 'settings', page: 'plugins' }, labelKey: 'tips.search.openPlugins' },
  },

  // ---- ephemeral: 消えるチャット ----
  {
    id: 'ephemeral.start', section: 'ephemeral',
    titleKey: 'tips.ephemeral.start.title', bodyKey: 'tips.ephemeral.start.body',
    keywordsKey: 'tips.ephemeral.start.kw',
    action: { action: { kind: 'ephemeral' }, labelKey: 'tips.ephemeral.start' },
  },
  {
    id: 'ephemeral.delete', section: 'ephemeral',
    titleKey: 'tips.ephemeral.delete.title', bodyKey: 'tips.ephemeral.delete.body',
    keywordsKey: 'tips.ephemeral.delete.kw',
  },
  {
    id: 'ephemeral.limits', section: 'ephemeral',
    titleKey: 'tips.ephemeral.limits.title', bodyKey: 'tips.ephemeral.limits.body',
    keywordsKey: 'tips.ephemeral.limits.kw',
  },
  {
    id: 'ephemeral.provider', section: 'ephemeral',
    titleKey: 'tips.ephemeral.provider.title', bodyKey: 'tips.ephemeral.provider.body',
    keywordsKey: 'tips.ephemeral.provider.kw',
  },

  // ---- artifacts: preview, download, import, email ----
  {
    id: 'artifacts.preview', section: 'artifacts',
    titleKey: 'tips.artifacts.preview.title', bodyKey: 'tips.artifacts.preview.body',
    keywordsKey: 'tips.artifacts.preview.kw',
  },
  {
    id: 'artifacts.download', section: 'artifacts',
    titleKey: 'tips.artifacts.download.title', bodyKey: 'tips.artifacts.download.body',
    keywordsKey: 'tips.artifacts.download.kw',
  },
  {
    id: 'artifacts.import', section: 'artifacts',
    titleKey: 'tips.artifacts.import.title', bodyKey: 'tips.artifacts.import.body',
    keywordsKey: 'tips.artifacts.import.kw',
  },
  {
    id: 'artifacts.email', section: 'artifacts',
    titleKey: 'tips.artifacts.email.title', bodyKey: 'tips.artifacts.email.body',
    keywordsKey: 'tips.artifacts.email.kw',
  },

  // ---- code: Code tab and DeepSeek Harness connection ----
  {
    id: 'code.tab', section: 'code',
    titleKey: 'tips.code.tab.title', bodyKey: 'tips.code.tab.body',
    keywordsKey: 'tips.code.tab.kw',
  },
  {
    id: 'code.connect', section: 'code',
    titleKey: 'tips.code.connect.title', bodyKey: 'tips.code.connect.body',
    keywordsKey: 'tips.code.connect.kw',
    action: { action: { kind: 'settings', page: 'plugins' }, labelKey: 'tips.code.openPlugins' },
  },
  {
    id: 'code.provider', section: 'code',
    titleKey: 'tips.code.provider.title', bodyKey: 'tips.code.provider.body',
    keywordsKey: 'tips.code.provider.kw',
  },
];
