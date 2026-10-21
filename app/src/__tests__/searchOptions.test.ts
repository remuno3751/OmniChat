// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/searchOptions.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEARCH_OPTIONS, clampInt, guardSourceLabel, normalizeSearchMode, parseDomainList, resolveSearchOptions, truncateExcerpt } from '../searchOptions';

test('normalizeSearchMode: auto becomes smart, unknown falls back to smart', () => {
  assert.equal(normalizeSearchMode('auto'), 'smart');
  assert.equal(normalizeSearchMode('off'), 'off');
  assert.equal(normalizeSearchMode('always'), 'always');
  assert.equal(normalizeSearchMode('smart'), 'smart');
  assert.equal(normalizeSearchMode('weird'), 'smart');
});

test('clampInt keeps values in range and handles junk', () => {
  assert.equal(clampInt(0, 1, 30, 5), 1);
  assert.equal(clampInt(99, 1, 30, 5), 30);
  assert.equal(clampInt('7', 1, 30, 5), 7);
  assert.equal(clampInt(undefined, 1, 30, 5), 5);
  assert.equal(clampInt(NaN, 1, 10, 3), 3);
});

test('parseDomainList: trims, lower-cases, drops empty lines and duplicates', () => {
  assert.deepEqual(parseDomainList('  Example.com \n\n example.com\r\n  wiki.org  '), ['example.com', 'wiki.org']);
  assert.deepEqual(parseDomainList(''), []);
});

test('resolveSearchOptions: fills defaults for an absent or partial object', () => {
  assert.deepEqual(resolveSearchOptions(undefined), DEFAULT_SEARCH_OPTIONS);
  const r = resolveSearchOptions({ maxSites: 50, guard: 'strict', visionModel: 'search' });
  assert.equal(r.maxSites, 30);
  assert.equal(r.guard, 'strict');
  assert.equal(r.visionModel, 'search');
  assert.equal(r.maxSearches, 3);
  assert.equal(resolveSearchOptions({ guard: 'bogus' }).guard, 'standard');
});

test('truncateExcerpt caps at 200 chars and collapses whitespace', () => {
  assert.equal(truncateExcerpt('a  b\n c'), 'a b c');
  const long = 'x'.repeat(300);
  const out = truncateExcerpt(long);
  assert.equal(out.length, 200);
  assert.ok(out.endsWith('…'));
});

test('guardSourceLabel: title, else host, else raw url', () => {
  assert.equal(guardSourceLabel({ url: 'https://ex.com/a', title: ' Page ' }), 'Page');
  assert.equal(guardSourceLabel({ url: 'https://ex.com/a' }), 'ex.com');
  assert.equal(guardSourceLabel({ url: 'not a url' }), 'not a url');
});
