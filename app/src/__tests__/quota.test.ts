// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/quota.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUOTA_MAX, formatTokens, isExhausted, overrideChanged, parseLimitInput, showUsageCard, usageRatio } from '../quota';
import { en, ja } from '../i18n/quotaStrings';

test('the usage card is shown only where the quota applies', () => {
  assert.equal(showUsageCard({ applies: true }), true);
  assert.equal(showUsageCard({ applies: false }), false);
  assert.equal(showUsageCard(null), false);
  assert.equal(showUsageCard(undefined), false);
});

test('usage ratio: capped at 1, null when unlimited', () => {
  assert.equal(usageRatio(50, 200), 0.25);
  assert.equal(usageRatio(500, 200), 1);
  assert.equal(usageRatio(10, null), null);
  assert.equal(usageRatio(10, 0), null);
  assert.equal(usageRatio(-5, 100), 0);
});

test('exhausted: reached or passed the limit, never when unlimited', () => {
  assert.equal(isExhausted(749, 750), false);
  assert.equal(isExhausted(750, 750), true);
  assert.equal(isExhausted(9999, null), false);
  assert.equal(isExhausted(9999, 0), false);
});

test('token amounts are grouped by thousands; bad numbers print as 0', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(12345), '12,345');
  assert.equal(formatTokens(1234567.4), '1,234,567');
  assert.equal(formatTokens(NaN), '0');
  assert.equal(formatTokens(-3), '0');
});

test('limit input: blank is the default only for overrides; digits only; bounded', () => {
  assert.equal(parseLimitInput(' 1500 ', false), 1500);
  assert.equal(parseLimitInput('0', false), 0);
  assert.equal(parseLimitInput('', false), 'invalid');
  assert.equal(parseLimitInput('   ', true), null);
  assert.equal(parseLimitInput('1.5', true), 'invalid');
  assert.equal(parseLimitInput('-1', true), 'invalid');
  assert.equal(parseLimitInput('12a', true), 'invalid');
  assert.equal(parseLimitInput(String(QUOTA_MAX), false), QUOTA_MAX);
  assert.equal(parseLimitInput(String(QUOTA_MAX + 1), false), 'invalid');
  assert.equal(parseLimitInput('9007199254740993', false), 'invalid');
});

test('an override is changed only when a field differs from the saved one', () => {
  assert.equal(overrideChanged(null, { dailyTokens: null, monthlyTokens: null }), false);
  assert.equal(overrideChanged(null, { dailyTokens: 0, monthlyTokens: null }), true);
  assert.equal(overrideChanged({ dailyTokens: 0, monthlyTokens: 5 }, { dailyTokens: 0, monthlyTokens: 5 }), false);
  assert.equal(overrideChanged({ dailyTokens: 0, monthlyTokens: 5 }, { dailyTokens: 0, monthlyTokens: null }), true);
});

test('en and ja define the same quota keys, and every key has a value', () => {
  const ek = Object.keys(en).sort();
  const jk = Object.keys(ja).sort();
  assert.deepEqual(jk, ek);
  for (const k of ek) {
    assert.ok(en[k].length > 0, k);
    assert.ok(ja[k].length > 0, k);
  }
});
