// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/pluginsAdmin.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmMatches, countFindings, diffIsEmpty, formatBytes, groupFindings, normalizeRepo, normalizeSubdir,
  optionalText, shortSha, sortFindings,
} from '../pluginsAdminLogic';

test('normalizeRepo: accepts owner/name and GitHub URLs', () => {
  assert.deepEqual(normalizeRepo('acme/tool'), { ok: true, repo: 'acme/tool' });
  assert.deepEqual(normalizeRepo('  acme/tool  '), { ok: true, repo: 'acme/tool' });
  assert.deepEqual(normalizeRepo('https://github.com/acme/tool'), { ok: true, repo: 'acme/tool' });
  assert.deepEqual(normalizeRepo('https://github.com/acme/tool.git'), { ok: true, repo: 'acme/tool' });
  assert.deepEqual(normalizeRepo('https://github.com/acme/tool/'), { ok: true, repo: 'acme/tool' });
  assert.deepEqual(normalizeRepo('github.com/acme/tool'), { ok: true, repo: 'acme/tool' });
});

test('normalizeRepo: rejects empty, other hosts and malformed input', () => {
  assert.deepEqual(normalizeRepo(''), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeRepo('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(normalizeRepo('https://gitlab.com/acme/tool'), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeRepo('http://github.com/acme/tool'), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeRepo('acme'), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeRepo('acme/tool/extra'), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeRepo('acme/..'), { ok: false, reason: 'bad' });
  assert.deepEqual(normalizeRepo('acme/tool with space'), { ok: false, reason: 'bad' });
});

test('normalizeSubdir: empty is fine, traversal and absolute paths are refused', () => {
  assert.equal(normalizeSubdir(''), '');
  assert.equal(normalizeSubdir('  plugins/foo/ '), 'plugins/foo');
  assert.equal(normalizeSubdir('/plugins/foo'), 'plugins/foo');
  assert.equal(normalizeSubdir('plugins\\foo'), 'plugins/foo');
  assert.equal(normalizeSubdir('../etc'), null);
  assert.equal(normalizeSubdir('a/../../b'), null);
});

test('optionalText: blank becomes undefined', () => {
  assert.equal(optionalText('   '), undefined);
  assert.equal(optionalText(' v1.2.0 '), 'v1.2.0');
});

test('sortFindings: high first, then medium, then info, stable inside a severity', () => {
  const input = [
    { rule: 'a', severity: 'info' },
    { rule: 'b', severity: 'high' },
    { rule: 'c', severity: 'medium' },
    { rule: 'd', severity: 'high' },
    { rule: 'e', severity: 'weird' },
  ];
  assert.deepEqual(sortFindings(input).map((f) => f.rule), ['b', 'd', 'c', 'a', 'e']);
  assert.equal(input[0].rule, 'a'); // does not mutate
});

test('groupFindings and countFindings: unknown severity counts as info', () => {
  const f = [
    { rule: 'x', severity: 'high' },
    { rule: 'y', severity: 'medium' },
    { rule: 'z', severity: 'info' },
    { rule: 'w', severity: 'other' },
  ];
  const g = groupFindings(f);
  assert.deepEqual(g.high.map((x) => x.rule), ['x']);
  assert.deepEqual(g.medium.map((x) => x.rule), ['y']);
  assert.deepEqual(g.info.map((x) => x.rule), ['z', 'w']);
  assert.deepEqual(countFindings(f), { high: 1, medium: 1, info: 2 });
  assert.deepEqual(countFindings([]), { high: 0, medium: 0, info: 0 });
});

test('confirmMatches: exact id only', () => {
  assert.equal(confirmMatches('weather-tools', 'weather-tools'), true);
  assert.equal(confirmMatches('weather-tools', 'weather-tool'), false);
  assert.equal(confirmMatches('weather-tools', 'Weather-tools'), false);
  assert.equal(confirmMatches('weather-tools', 'weather-tools '), false);
  assert.equal(confirmMatches('weather-tools', ''), false);
  assert.equal(confirmMatches('', ''), false);
});

test('diffIsEmpty: true only without any change', () => {
  const empty = { added: [], removed: [], changed: [], toolsAdded: [], toolsRemoved: [], permissionsAdded: [] };
  assert.equal(diffIsEmpty(empty), true);
  assert.equal(diffIsEmpty({ ...empty, changed: ['main.js'] }), false);
  assert.equal(diffIsEmpty({ ...empty, permissionsAdded: [{ tool: 't', permission: 'network' }] }), false);
});

test('formatBytes and shortSha', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(shortSha('0123456789abcdef0123456789abcdef01234567'), '0123456');
  assert.equal(shortSha(undefined), '');
});
