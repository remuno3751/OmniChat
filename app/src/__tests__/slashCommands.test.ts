// @ts-nocheck -- node:test typings are not available in this tsconfig.
// Run: node --import tsx --test src/__tests__/slashCommands.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLASH_COMMANDS, parseSlashCommand, isTypedCommand, commandUsage, commandAvailable,
  parseEffortArg, parseExportArg, parseUsageArg, matchModel,
} from '../slashCommands';
import { buildSlashEntries, filterSlash } from '../templates';

const tr = (k: string) => 'T:' + k;
const userTpl = (id: string, name: string) => ({ id, name, description: '', kind: 'prompt', body: 'hello', projectId: null, deleted: false });
const names = (entries) => entries.map((e) => e.key);

// ---------- command table ----------

test('SLASH_COMMANDS has the twelve commands in order with the expected flags', () => {
  assert.deepEqual(SLASH_COMMANDS.map((d) => d.name), [
    'compact', 'context', 'usage', 'clear', 'help', 'rename', 'model', 'effort', 'export', 'pin', 'unpin', 'retry',
  ]);
  const hints = Object.fromEntries(SLASH_COMMANDS.map((d) => [d.name, d.argHint]));
  assert.deepEqual(hints, {
    compact: '[focus]', context: undefined, usage: '[today|week|month|all]', clear: undefined, help: undefined,
    rename: '<title>', model: '[model]', effort: '<off|low|medium|high|max|default>', export: '[md|json]',
    pin: undefined, unpin: undefined, retry: undefined,
  });
  for (const d of SLASH_COMMANDS) assert.equal(d.descKey, 'slash.cmd.' + d.name);
  const flags = (pred) => SLASH_COMMANDS.filter(pred).map((d) => d.name);
  assert.deepEqual(flags((d) => d.codeHidden), ['compact', 'context', 'effort']);
  assert.deepEqual(flags((d) => d.ephemeralHidden), ['usage', 'rename', 'export', 'pin', 'unpin']);
  assert.deepEqual(flags((d) => d.needsConv), ['compact', 'context', 'rename', 'export', 'pin', 'unpin', 'retry']);
});

// ---------- parseSlashCommand ----------

test('parseSlashCommand recognises commands with an argument', () => {
  assert.deepEqual(parseSlashCommand('/compact focus on the API'), { name: 'compact', arg: 'focus on the API' });
  assert.deepEqual(parseSlashCommand('/rename My Title'), { name: 'rename', arg: 'My Title' });
  assert.deepEqual(parseSlashCommand('/model gpt-4o'), { name: 'model', arg: 'gpt-4o' });
  assert.deepEqual(parseSlashCommand('/usage week'), { name: 'usage', arg: 'week' });
  assert.deepEqual(parseSlashCommand('/effort HIGH'), { name: 'effort', arg: 'HIGH' });
  assert.deepEqual(parseSlashCommand('/export json'), { name: 'export', arg: 'json' });
});

test('parseSlashCommand gives an empty arg when none is present', () => {
  for (const t of ['/compact', '/compact ', '/compact\n', '/compact   ', '/rename', '/pin', '/retry']) {
    const r = parseSlashCommand(t);
    assert.ok(r, t);
    assert.equal(r.arg, '', JSON.stringify(t));
  }
  assert.deepEqual(parseSlashCommand('/clear'), { name: 'clear', arg: '' });
  assert.deepEqual(parseSlashCommand('/help'), { name: 'help', arg: '' });
});

test('parseSlashCommand ignores leading whitespace and lowercases the name', () => {
  assert.deepEqual(parseSlashCommand('  /compact keep code  '), { name: 'compact', arg: 'keep code' });
  assert.deepEqual(parseSlashCommand('\n\t/COMPACT x'), { name: 'compact', arg: 'x' });
  assert.deepEqual(parseSlashCommand('/Rename Mixed Case'), { name: 'rename', arg: 'Mixed Case' });
  assert.deepEqual(parseSlashCommand('/UsAgE all'), { name: 'usage', arg: 'all' });
});

test('parseSlashCommand accepts tabs and multi-line arguments and trims the arg', () => {
  assert.deepEqual(parseSlashCommand('/compact\tfocus'), { name: 'compact', arg: 'focus' });
  assert.deepEqual(parseSlashCommand('/compact\nline one\nline two\n'), { name: 'compact', arg: 'line one\nline two' });
  assert.deepEqual(parseSlashCommand('/rename   spaced   '), { name: 'rename', arg: 'spaced' });
  assert.deepEqual(parseSlashCommand('/rename a\n\nb'), { name: 'rename', arg: 'a\n\nb' });
});

test('parseSlashCommand keeps extra text after a no-argument command', () => {
  assert.deepEqual(parseSlashCommand('/context please'), { name: 'context', arg: 'please' });
  assert.deepEqual(parseSlashCommand('/pin now'), { name: 'pin', arg: 'now' });
  assert.deepEqual(parseSlashCommand('/clear   x'), { name: 'clear', arg: 'x' });
});

test('parseSlashCommand returns null for non-commands', () => {
  const cases = [
    '/new', '/search off', '/search', '/approval ask', '/approval rules', '/foo', '/', '/ compact', '/ ',
    '/usr/bin', '/usr/bin/env', '/compactfoo', '/compact-now', '/compact1', 'compact', 'hello /compact',
    '', '   ', 'please /pin', '//compact', '/1compact',
  ];
  for (const t of cases) assert.equal(parseSlashCommand(t), null, JSON.stringify(t));
});

// ---------- isTypedCommand ----------

test('isTypedCommand is true only once whitespace follows a parsed command name', () => {
  assert.equal(isTypedCommand('/compact'), false);
  assert.equal(isTypedCommand('/compact '), true);
  assert.equal(isTypedCommand('/context '), true);
  assert.equal(isTypedCommand('/compact focus'), true);
  assert.equal(isTypedCommand('/compact\nfocus'), true);
  assert.equal(isTypedCommand('  /pin '), true);
  assert.equal(isTypedCommand('/PIN\t'), true);
  assert.equal(isTypedCommand('/pin'), false);
  assert.equal(isTypedCommand('/new '), false);
  assert.equal(isTypedCommand('/usr/bin '), false);
  assert.equal(isTypedCommand('/compactfoo '), false);
  assert.equal(isTypedCommand('/ compact '), false);
  assert.equal(isTypedCommand('compact '), false);
  assert.equal(isTypedCommand(''), false);
});

// ---------- commandUsage / commandAvailable ----------

test('commandUsage shows the argument hint, or just the name when there is none', () => {
  assert.equal(commandUsage('rename'), '/rename <title>');
  assert.equal(commandUsage('usage'), '/usage [today|week|month|all]');
  assert.equal(commandUsage('pin'), '/pin');
  assert.equal(commandUsage('context'), '/context');
  assert.equal(commandUsage('effort'), '/effort <off|low|medium|high|max|default>');
});

test('commandAvailable reports code and ephemeral hiding', () => {
  assert.equal(commandAvailable('compact', { mode: 'code', ephemeral: false }), 'code');
  assert.equal(commandAvailable('context', { mode: 'code', ephemeral: true }), 'code');
  assert.equal(commandAvailable('effort', { mode: 'code', ephemeral: false }), 'code');
  assert.equal(commandAvailable('rename', { mode: 'chat', ephemeral: true }), 'ephemeral');
  assert.equal(commandAvailable('usage', { mode: 'chat', ephemeral: true }), 'ephemeral');
  assert.equal(commandAvailable('usage', { mode: 'code', ephemeral: false }), 'ok');
  assert.equal(commandAvailable('model', { mode: 'code', ephemeral: true }), 'ok');
  assert.equal(commandAvailable(SLASH_COMMANDS.find((d) => d.name === 'export'), { mode: 'chat', ephemeral: false }), 'ok');
  assert.equal(commandAvailable('retry', { mode: 'chat', ephemeral: true }), 'ok');
});

// ---------- argument parsers ----------

test('parseEffortArg accepts only the six levels, case-insensitively', () => {
  for (const [input, out] of [
    ['low', 'low'], ['MEDIUM', 'medium'], [' high ', 'high'], ['max', 'max'], ['Default', 'default'], ['OFF', 'off'],
  ]) assert.equal(parseEffortArg(input), out, input);
  for (const input of ['', '   ', 'xhigh', 'none', 'mid', 'lowest']) assert.equal(parseEffortArg(input), null, JSON.stringify(input));
});

test('parseExportArg defaults to md and accepts markdown and json', () => {
  assert.equal(parseExportArg(''), 'md');
  assert.equal(parseExportArg('   '), 'md');
  assert.equal(parseExportArg('md'), 'md');
  assert.equal(parseExportArg('Markdown'), 'md');
  assert.equal(parseExportArg('json'), 'json');
  assert.equal(parseExportArg(' JSON '), 'json');
  assert.equal(parseExportArg('pdf'), null);
  assert.equal(parseExportArg('md json'), null);
});

test('parseUsageArg defaults to today and maps the aliases', () => {
  assert.equal(parseUsageArg(''), 'today');
  assert.equal(parseUsageArg('today'), 'today');
  assert.equal(parseUsageArg('day'), 'today');
  assert.equal(parseUsageArg('week'), 'week');
  assert.equal(parseUsageArg('7d'), 'week');
  assert.equal(parseUsageArg('month'), 'month');
  assert.equal(parseUsageArg('30d'), 'month');
  assert.equal(parseUsageArg('All'), 'all');
  assert.equal(parseUsageArg(' all '), 'all');
  assert.equal(parseUsageArg('year'), null);
  assert.equal(parseUsageArg('14d'), null);
});

// ---------- matchModel ----------

const CANDS = [
  { providerId: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3' },   // A
  { providerId: 'openai', model: 'gpt-4o', label: 'GPT-4o' },                  // B
  { providerId: 'openai', model: 'gpt-4o-mini', label: 'GPT-4o mini' },        // C
  { providerId: 'openai', model: 'gpt-4.1', label: 'GPT-4.1' },                // D
  { providerId: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet' }, // E
  { providerId: 'anthropic', model: 'claude-haiku', label: 'Haiku' },          // F
];
const A = CANDS[0], B = CANDS[1], C = CANDS[2], D = CANDS[3], E = CANDS[4], F = CANDS[5];

test('matchModel prefers an exact match on model or label, ignoring case and separators', () => {
  assert.deepEqual(matchModel('gpt-4o', CANDS), { best: B, ambiguous: [] });
  assert.deepEqual(matchModel('GPT 4O', CANDS), { best: B, ambiguous: [] });
  assert.deepEqual(matchModel('gpt4o', CANDS), { best: B, ambiguous: [] });
  assert.deepEqual(matchModel('gpt-4o-mini', CANDS), { best: C, ambiguous: [] });
  assert.deepEqual(matchModel('gpt-4.1', CANDS), { best: D, ambiguous: [] });
  assert.deepEqual(matchModel('haiku', CANDS), { best: F, ambiguous: [] });
  assert.deepEqual(matchModel('deepseek v3', CANDS), { best: A, ambiguous: [] });
});

test('matchModel: exact beats prefix regardless of order', () => {
  const pre = { providerId: 'x', model: 'gpt-4o-mini', label: 'mini' };
  const ex = { providerId: 'x', model: 'gpt-4o', label: 'full' };
  assert.equal(matchModel('gpt-4o', [pre, ex]).best, ex);
  assert.equal(matchModel('gpt-4o', [ex, pre]).best, ex);
});

test('matchModel: a single prefix match is the best', () => {
  assert.deepEqual(matchModel('deepseek', CANDS), { best: A, ambiguous: [] });
  assert.deepEqual(matchModel('claude-s', CANDS), { best: E, ambiguous: [] });
});

test('matchModel: a single substring match is the best', () => {
  assert.deepEqual(matchModel('chat', CANDS), { best: A, ambiguous: [] });
  assert.deepEqual(matchModel('sonnet', CANDS), { best: E, ambiguous: [] });
});

test('matchModel: several candidates at the top rank are ambiguous', () => {
  // 'gpt4' is a prefix of gpt-4o, gpt-4o-mini and gpt-4.1
  assert.deepEqual(matchModel('gpt4', CANDS), { best: null, ambiguous: [B, C, D] });
  // 'o' matches only as a substring; B, C and E contain it
  assert.deepEqual(matchModel('o', CANDS), { best: null, ambiguous: [B, C, E] });
});

test('matchModel: multi-token substring queries need every token', () => {
  assert.deepEqual(matchModel('claude sonnet', CANDS), { best: E, ambiguous: [] });
  assert.deepEqual(matchModel('deepseek nope', CANDS), { best: null, ambiguous: [] });
});

test('matchModel: no match or empty query gives nothing', () => {
  assert.deepEqual(matchModel('nope', CANDS), { best: null, ambiguous: [] });
  assert.deepEqual(matchModel('', CANDS), { best: null, ambiguous: [] });
  assert.deepEqual(matchModel('   ', CANDS), { best: null, ambiguous: [] });
  assert.deepEqual(matchModel('-_.', CANDS), { best: null, ambiguous: [] });
  assert.deepEqual(matchModel('gpt-4o', []), { best: null, ambiguous: [] });
});

test('matchModel collapses duplicate providerId+model pairs', () => {
  const dup = [B, { providerId: 'openai', model: 'gpt-4o', label: 'other label' }];
  assert.deepEqual(matchModel('gpt-4o', dup), { best: B, ambiguous: [] });
  // same model under different providers is not a duplicate
  const twoProviders = [{ providerId: 'a', model: 'x', label: 'x' }, { providerId: 'b', model: 'x', label: 'x' }];
  const r = matchModel('x', twoProviders);
  assert.equal(r.best, null);
  assert.deepEqual(r.ambiguous, twoProviders);
});

test('matchModel caps the ambiguous list at six', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ providerId: 'p', model: 'model-' + i, label: 'M' + i }));
  const r = matchModel('model', many);
  assert.equal(r.best, null);
  assert.equal(r.ambiguous.length, 6);
  assert.deepEqual(r.ambiguous, many.slice(0, 6));
});

// ---------- buildSlashEntries ----------

test('buildSlashEntries puts all twelve commands first in chat mode', () => {
  const entries = buildSlashEntries([], null, tr);
  const cmds = entries.filter((e) => e.kind === 'command');
  assert.deepEqual(cmds.map((e) => e.name), SLASH_COMMANDS.map((d) => d.name));
  assert.deepEqual(entries.slice(0, 12).map((e) => e.kind), Array(12).fill('command'));
  assert.equal(entries[12].kind, 'action');
});

test('buildSlashEntries command entry shape and translated descriptions', () => {
  const entries = buildSlashEntries([], null, tr);
  const compact = entries.find((e) => e.key === 'cmd:compact');
  assert.deepEqual(compact, {
    key: 'cmd:compact', name: 'compact', description: 'T:slash.cmd.compact', kind: 'command',
    body: 'compact', command: 'compact', argHint: '[focus]',
  });
  for (const e of entries.filter((x) => x.kind === 'command')) {
    assert.equal(e.description, 'T:slash.cmd.' + e.name, e.key);
    assert.equal(e.command, e.name);
    assert.equal(e.body, e.name);
    assert.ok(!e.name.includes(' '), 'name is just the command name');
  }
  const context = entries.find((e) => e.key === 'cmd:context');
  assert.equal(context.argHint, undefined);
  assert.equal('argHint' in context, false);
  assert.equal(entries.find((e) => e.key === 'cmd:rename').argHint, '<title>');
});

test('buildSlashEntries code mode hides compact, context and effort', () => {
  const names = buildSlashEntries([], null, tr, { mode: 'code' }).filter((e) => e.kind === 'command').map((e) => e.name);
  assert.deepEqual(names, ['usage', 'clear', 'help', 'rename', 'model', 'export', 'pin', 'unpin', 'retry']);
});

test('buildSlashEntries ephemeral hides rename, export, pin, unpin and usage', () => {
  const names = buildSlashEntries([], null, tr, { ephemeral: true }).filter((e) => e.kind === 'command').map((e) => e.name);
  assert.deepEqual(names, ['compact', 'context', 'clear', 'help', 'model', 'effort', 'retry']);
});

test('buildSlashEntries code and ephemeral together keep only the common commands', () => {
  const names = buildSlashEntries([], null, tr, { mode: 'code', ephemeral: true }).filter((e) => e.kind === 'command').map((e) => e.name);
  assert.deepEqual(names, ['clear', 'help', 'model', 'retry']);
});

test('buildSlashEntries keeps the built-in actions, prompts and user templates after the commands', () => {
  const entries = buildSlashEntries([userTpl('u1', 'mine')], null, tr);
  const lastCmd = entries.reduce((acc, e, i) => (e.kind === 'command' ? i : acc), -1);
  const firstAction = entries.findIndex((e) => e.kind === 'action');
  const firstPrompt = entries.findIndex((e) => e.key === 'builtin:email.reply');
  const user = entries.findIndex((e) => e.key === 'tpl:u1');
  assert.ok(lastCmd < firstAction && firstAction < firstPrompt && firstPrompt < user);
  assert.equal(entries.filter((e) => e.kind === 'action').length, 7);
  assert.equal(entries.filter((e) => e.key.startsWith('builtin:email.')).length, 5);
  assert.equal(entries.find((e) => e.key === 'builtin:new_session').kind, 'action');
});

test('buildSlashEntries still respects project scoping for user templates', () => {
  const other = { ...userTpl('p2', 'proj-only'), projectId: 'other' };
  const mine = { ...userTpl('p1', 'proj-mine'), projectId: 'proj' };
  const keys = names(buildSlashEntries([other, mine], 'proj', tr));
  assert.ok(keys.includes('tpl:p1'));
  assert.ok(!keys.includes('tpl:p2'));
});

test('buildSlashEntries with no opts behaves like chat mode', () => {
  assert.deepEqual(names(buildSlashEntries([], null, tr)), names(buildSlashEntries([], null, tr, { mode: 'chat', ephemeral: false })));
});

// ---------- filterSlash ----------

test('filterSlash keeps everything for an empty or blank query', () => {
  const entries = buildSlashEntries([], null, tr);
  assert.equal(filterSlash(entries, ''), entries);
  assert.equal(filterSlash(entries, '   '), entries);
});

test('filterSlash matches case-insensitively and lists names starting with the query first', () => {
  const entries = buildSlashEntries([userTpl('x1', 'xrefactor')], null, tr);
  const r = filterSlash(entries, 'RE');
  assert.deepEqual(r.slice(0, 2).map((e) => e.key), ['cmd:rename', 'cmd:retry']);
  assert.ok(r.findIndex((e) => e.key === 'tpl:x1') > 1, 'a name that only contains the query sorts after prefix matches');
});

test('filterSlash lists the command for a query that carries arguments', () => {
  const entries = buildSlashEntries([], null, tr);
  assert.deepEqual(names(filterSlash(entries, 'compact focus on x')), ['cmd:compact']);
  assert.deepEqual(names(filterSlash(entries, 'usage week')), ['cmd:usage']);
  assert.deepEqual(names(filterSlash(entries, 'effort high')), ['cmd:effort']);
  assert.deepEqual(names(filterSlash(entries, '  Export   json  ')), ['cmd:export']);
});

test('filterSlash still matches multi-word action names by the full query', () => {
  const entries = buildSlashEntries([], null, tr);
  assert.deepEqual(names(filterSlash(entries, 'search off')), ['builtin:search:off']);
  const smart = filterSlash(entries, 'search smart').map((e) => e.key);
  assert.deepEqual(smart, ['builtin:search:smart']);
  assert.deepEqual(names(filterSlash(entries, 'approval ask')), ['builtin:approval_mode:ask']);
});

test('filterSlash matches command names by prefix in the menu', () => {
  const entries = buildSlashEntries([], null, tr);
  assert.equal(filterSlash(entries, 'comp')[0].key, 'cmd:compact');
  assert.equal(filterSlash(entries, 'un')[0].key, 'cmd:unpin');
  assert.equal(filterSlash(entries, 'zzz').length, 0);
});
