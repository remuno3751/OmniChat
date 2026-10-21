// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/openLink.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpenableLink, openLinkPlan } from '../openLink';

const pair = 'vscode://omnichat.omnichat-vscode/pair?code=abc';

test('web: custom scheme navigates the current tab, https opens a tab', () => {
  assert.equal(openLinkPlan('web', false, pair), 'location');
  assert.equal(openLinkPlan('web', false, 'https://example.com/x'), 'window-open');
});

test('desktop app (web platform with the shell bridge) uses the bridge', () => {
  assert.equal(openLinkPlan('web', true, pair), 'desktop');
  assert.equal(openLinkPlan('web', true, 'https://example.com'), 'desktop');
});

test('native platforms use Linking', () => {
  assert.equal(openLinkPlan('ios', false, pair), 'linking');
  assert.equal(openLinkPlan('android', false, pair), 'linking');
});

test('unusable links are refused', () => {
  assert.equal(openLinkPlan('web', true, ''), 'none');
  assert.equal(openLinkPlan('web', false, 'no scheme here'), 'none');
  assert.equal(openLinkPlan('web', false, 'vscode://x/pair\n?code=1'), 'none');
  assert.equal(openLinkPlan('web', false, 'https://e.com/' + 'a'.repeat(8200)), 'none');
  assert.equal(openLinkPlan('ios', false, undefined), 'none');
  assert.equal(isOpenableLink(pair), true);
});
