// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/tips.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeText, searchTips, highlightParts, tipOfTheDay, latestWhatsNew } from '../tips/search';
import { SLASH_COMMANDS } from '../slashCommands';
import en from '../i18n/en';
import ja from '../i18n/ja';

const tip = (id, over = {}) => ({ id, section: 'keys', title: id, body: '', keywords: '', ...over });

// ---------- normalizeText ----------

test('normalizeText lowercases, folds width and collapses whitespace', () => {
  assert.equal(normalizeText('  Hello   WORLD \n x '), 'hello world x');
  assert.equal(normalizeText('ＡＢＣ　ｄｅｆ'), 'abc def');
  assert.equal(normalizeText('ｶﾀｶﾅ'), normalizeText('カタカナ'));
});

test('normalizeText folds katakana to hiragana', () => {
  assert.equal(normalizeText('ノート'), normalizeText('のーと'));
  assert.equal(normalizeText('ノート'), 'のーと');
});

// ---------- searchTips ----------

const SAMPLE = [
  tip('a', { title: 'Compact the chat', body: 'Summarize older messages', keywords: 'summary' }),
  tip('b', { title: 'Notes', body: 'Open the ノート panel', keywords: 'memo' }),
  tip('c', { title: 'Shortcuts', body: 'Press Enter to send', example: 'Ctrl+K', keywords: '' }),
  tip('d', { title: 'Web search', body: 'Use smart mode', keywords: 'compact ネット' }),
];

test('searchTips returns the same entries for an empty or blank query', () => {
  assert.equal(searchTips(SAMPLE, ''), SAMPLE);
  assert.equal(searchTips(SAMPLE, '   '), SAMPLE);
});

test('searchTips matches Japanese substrings across katakana/hiragana', () => {
  assert.deepEqual(searchTips(SAMPLE, 'のーと').map((t) => t.id), ['b']);
  assert.deepEqual(searchTips(SAMPLE, 'ノート').map((t) => t.id), ['b']);
});

test('searchTips requires every term (AND) and is case-insensitive', () => {
  assert.deepEqual(searchTips(SAMPLE, 'ENTER send').map((t) => t.id), ['c']);
  assert.deepEqual(searchTips(SAMPLE, 'enter smart'), []);
});

test('searchTips ranks title matches before keyword matches before body matches', () => {
  const ranked = searchTips(SAMPLE, 'compact');
  assert.deepEqual(ranked.map((t) => t.id), ['a', 'd']); // a: title; d: keyword only
  const body = searchTips([tip('x', { body: 'mode' }), tip('y', { keywords: 'mode' }), tip('z', { title: 'Mode' })], 'mode');
  assert.deepEqual(body.map((t) => t.id), ['z', 'y', 'x']);
});

test('searchTips returns nothing when no entry matches', () => {
  assert.deepEqual(searchTips(SAMPLE, 'zzzz'), []);
});

// ---------- highlightParts ----------

const joined = (parts) => parts.map((p) => p.text).join('');

test('highlightParts never loses characters', () => {
  const cases = [
    ['Open the ノート panel', 'のーと'],
    ['Hello WORLD hello', 'hello world'],
    ['ＡＢＣ abc', 'abc'],
    ['', 'x'],
    ['abc', ''],
    ['no match here', 'zzz'],
    ['  spaced  text ', '  '],
  ];
  for (const [text, q] of cases) assert.equal(joined(highlightParts(text, q)), text);
});

test('highlightParts marks matches and keeps the original text in hit parts', () => {
  assert.deepEqual(highlightParts('Open the ノート panel', 'のーと'), [
    { text: 'Open the ', hit: false },
    { text: 'ノート', hit: true },
    { text: ' panel', hit: false },
  ]);
  assert.deepEqual(highlightParts('Hello WORLD', 'world'), [
    { text: 'Hello ', hit: false },
    { text: 'WORLD', hit: true },
  ]);
});

test('highlightParts returns a single non-hit part for an empty query', () => {
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(highlightParts('abc', '   '), [{ text: 'abc', hit: false }]);
});

// ---------- tipOfTheDay ----------

test('tipOfTheDay is null for an empty list', () => {
  assert.equal(tipOfTheDay([], new Date(2026, 0, 5)), null);
});

test('tipOfTheDay is deterministic per local date and changes the next day', () => {
  const list = [tip('p'), tip('q'), tip('r')];
  const day1a = tipOfTheDay(list, new Date(2026, 0, 5, 9, 30));
  const day1b = tipOfTheDay(list, new Date(2026, 0, 5, 23, 59));
  const day2 = tipOfTheDay(list, new Date(2026, 0, 6, 0, 1));
  assert.equal(day1a, day1b);
  assert.notEqual(day1a.id, day2.id);
  const seen = new Set();
  for (let d = 1; d <= 3; d++) seen.add(tipOfTheDay(list, new Date(2026, 0, d, 12)).id);
  assert.equal(seen.size, 3);
});

// ---------- latestWhatsNew ----------

test('latestWhatsNew sorts by date descending, stable for ties, and caps at n', () => {
  const items = [
    { date: '2026-01-02', k: 'a' },
    { date: '2026-03-01', k: 'b' },
    { date: '2026-01-02', k: 'c' },
    { date: '2025-12-31', k: 'd' },
  ];
  assert.deepEqual(latestWhatsNew(items, 3).map((i) => i.k), ['b', 'a', 'c']);
  assert.deepEqual(latestWhatsNew(items).map((i) => i.k), ['b', 'a', 'c', 'd']);
  assert.equal(items[0].k, 'a'); // input not mutated
  assert.deepEqual(latestWhatsNew([]), []);
});

// ---------- content (needs the other agents' files) ----------

const CONTENT_FILES = ['sections1.ts', 'sections2.ts', 'strings1.ts', 'strings2.ts', 'stringsChrome.ts', 'whatsnew.ts'];
const haveContent = CONTENT_FILES.every((f) => existsSync(join('src', 'tips', f)));
const skipReason = haveContent ? false : 'src/tips content files not present yet';

test('TIPS_EN and TIPS_JA have identical key sets', { skip: skipReason }, async () => {
  const { TIPS_EN, TIPS_JA } = await import('../tips/content');
  assert.deepEqual(Object.keys(TIPS_EN).sort(), Object.keys(TIPS_JA).sort());
});

test('every key used by static tips and what-is-new exists in both languages', { skip: skipReason }, async () => {
  const { TIPS_EN, TIPS_JA, STATIC_TIPS } = await import('../tips/content');
  const { WHATS_NEW } = await import('../tips/whatsnew');
  const keys = [];
  for (const e of STATIC_TIPS) {
    keys.push(e.titleKey, e.bodyKey);
    if (e.exampleKey) keys.push(e.exampleKey);
    if (e.keywordsKey) keys.push(e.keywordsKey);
    if (e.action?.labelKey) keys.push(e.action.labelKey);
  }
  for (const w of WHATS_NEW) keys.push(w.titleKey, w.bodyKey);
  const missing = keys.filter((k) => !(k in TIPS_EN) || !(k in TIPS_JA));
  assert.deepEqual([...new Set(missing)], []);
});

test('every slash command description key exists in en and ja messages', () => {
  for (const def of SLASH_COMMANDS) {
    assert.ok(def.descKey in en, `en missing ${def.descKey}`);
    assert.ok(def.descKey in ja, `ja missing ${def.descKey}`);
  }
});

test('resolveSlashTips yields one command entry per SLASH_COMMANDS with correct syntax', { skip: skipReason }, async () => {
  const { resolveSlashTips } = await import('../tips/content');
  const tr = (k) => k;
  const tips = resolveSlashTips({ templates: [], projectId: null, tr });
  const cmds = tips.filter((t) => t.id.startsWith('slash.cmd:'));
  assert.equal(cmds.length, SLASH_COMMANDS.length);
  assert.ok(cmds.every((t) => t.section === 'slash'));
  const compact = cmds.find((t) => t.id === 'slash.cmd:compact');
  assert.equal(compact.title, '/compact [focus]');
  assert.equal(compact.insertText, '/compact ');
  const pin = cmds.find((t) => t.id === 'slash.cmd:pin');
  assert.match(pin.body, /tips\.slash\.notInEphemeral/);
});
