// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCompactCard,
  buildContextCard,
  buildHelpCard,
  buildUsageCard,
  textCard,
} from '../slashCards'

// Fake translator: returns `key|k=v,k=v` with params sorted, so assertions check keys and params.
const tr = (key, params) => {
  if (!params || Object.keys(params).length === 0) return key
  const p = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join(',')
  return `${key}|${p}`
}

const usage = (over = {}) => ({
  limit: 8000,
  limitSource: 'backend',
  total: 2000,
  used: { system: 500, history: 1200, attachments: 0, tools: 0, input: 300 },
  reasoning: 0,
  lastReasoning: 0,
  estimated: false,
  reserve: 0,
  fits: true,
  headId: null,
  ...over,
})

const settingsOn = { contextCompressAt: 80, contextCompressTarget: 50, contextOverflow: 'summarize' }

const totals = (over = {}) => ({
  promptTokens: 4000,
  completionTokens: 3000,
  reasoningTokens: 1000,
  totalTokens: 7000,
  messages: 10,
  chats: 3,
  avgTokensPerAnswer: 700,
  estimatedMessages: 0,
  ...over,
})

const summary = (over = {}) => ({
  from: null,
  to: null,
  tz: 0,
  totals: totals(),
  estimated: false,
  topModel: { providerId: 'p', providerName: 'P', model: 'm-big', totalTokens: 5000 },
  ...over,
})

test('textCard: unique ids, defaults lines to []', () => {
  const a = textCard('error', 'Oops')
  const b = textCard('busy', 'Wait', ['one'])
  assert.equal(a.tone, 'error')
  assert.equal(a.title, 'Oops')
  assert.deepEqual(a.lines, [])
  assert.deepEqual(b.lines, ['one'])
  assert.notEqual(a.id, b.id)
  assert.notEqual(a.id, textCard('info', 'x').id)
})

test('buildContextCard: limit known -> used line, bar, title key', () => {
  const c = buildContextCard(usage(), { model: null, settings: null }, tr)
  assert.equal(c.title, 'slash.card.contextTitle')
  assert.equal(c.tone, 'info')
  assert.equal(c.lines[0], 'slash.card.contextUsed|limit=8k,pct=25,used=2k')
  assert.deepEqual(c.bar, { pct: 25, warn: false })
})

test('buildContextCard: limit null -> no limit line and no bar', () => {
  const c = buildContextCard(usage({ limit: null }), { model: null, settings: null }, tr)
  assert.equal(c.lines[0], 'slash.card.contextNoLimit|used=2k')
  assert.equal(c.bar, undefined)
  assert.equal('bar' in c, false)
})

test('buildContextCard: bar warns at 85 and clamps above 100', () => {
  const at85 = buildContextCard(usage({ total: 6800 }), { model: null, settings: null }, tr)
  assert.deepEqual(at85.bar, { pct: 85, warn: true })
  const at84 = buildContextCard(usage({ total: 6720 }), { model: null, settings: null }, tr)
  assert.deepEqual(at84.bar, { pct: 84, warn: false })
  const over = buildContextCard(usage({ total: 12000 }), { model: null, settings: null }, tr)
  assert.equal(over.lines[0], 'slash.card.contextUsed|limit=8k,pct=150,used=12k')
  assert.deepEqual(over.bar, { pct: 100, warn: true })
})

test('buildContextCard: rows, summary split out of system, zero rows omitted', () => {
  const u = usage({ summaryTokens: 200 })
  const c = buildContextCard(u, { model: null, settings: null }, tr)
  const labels = c.rows.map((r) => r.label)
  assert.deepEqual(labels, [
    'slash.card.ctxSystem',
    'slash.card.ctxSummary',
    'slash.card.ctxHistory',
    'slash.card.ctxInput',
  ])
  // system = 500 - 200 = 300 -> 300/2000 = 15%
  assert.deepEqual(c.rows[0], { label: 'slash.card.ctxSystem', value: '300', pct: 15 })
  assert.deepEqual(c.rows[1], { label: 'slash.card.ctxSummary', value: '200', pct: 10 })
  assert.deepEqual(c.rows[2], { label: 'slash.card.ctxHistory', value: '1.2k', pct: 60 })
  assert.deepEqual(c.rows[3], { label: 'slash.card.ctxInput', value: '300', pct: 15 })
})

test('buildContextCard: summary absent or zero -> no summary row; history kept even at 0', () => {
  const c = buildContextCard(
    usage({ used: { system: 500, history: 0, attachments: 0, tools: 0, input: 0 }, summaryTokens: 0 }),
    { model: null, settings: null },
    tr,
  )
  assert.deepEqual(c.rows.map((r) => r.label), ['slash.card.ctxSystem', 'slash.card.ctxHistory'])
  assert.deepEqual(c.rows[1], { label: 'slash.card.ctxHistory', value: '0', pct: 0 })
})

test('buildContextCard: system never negative when summary exceeds it', () => {
  const c = buildContextCard(usage({ summaryTokens: 900 }), { model: null, settings: null }, tr)
  // system = max(0, 500 - 900) = 0 -> zero row omitted; summary row present
  assert.equal(c.rows.some((r) => r.label === 'slash.card.ctxSystem'), false)
  assert.deepEqual(c.rows[0], { label: 'slash.card.ctxSummary', value: '900', pct: 45 })
})

test('buildContextCard: attachments and tools shown only when > 0', () => {
  const c = buildContextCard(
    usage({ total: 4000, used: { system: 1000, history: 1000, attachments: 500, tools: 1500, input: 0 } }),
    { model: null, settings: null },
    tr,
  )
  assert.deepEqual(c.rows.map((r) => r.label), [
    'slash.card.ctxSystem',
    'slash.card.ctxHistory',
    'slash.card.ctxAttach',
    'slash.card.ctxTools',
  ])
  assert.equal(c.rows[2].pct, 13)
  assert.equal(c.rows[3].pct, 38)
})

test('buildContextCard: model, auto-compress on, overflow, estimated lines', () => {
  const c = buildContextCard(usage({ estimated: true }), { model: 'qwen', settings: settingsOn }, tr)
  assert.deepEqual(c.lines.slice(1), [
    'slash.card.ctxModel|model=qwen',
    'slash.card.ctxAuto|at=80,target=50',
    'slash.card.ctxOverflow|mode=summarize',
    'slash.card.ctxEstimated',
  ])
})

test('buildContextCard: auto-compress off when contextCompressAt null', () => {
  const c = buildContextCard(
    usage(),
    { model: null, settings: { contextCompressAt: null, contextCompressTarget: 50, contextOverflow: 'stop' } },
    tr,
  )
  assert.deepEqual(c.lines.slice(1), ['slash.card.ctxAutoOff', 'slash.card.ctxOverflow|mode=stop'])
})

test('buildContextCard: settings null -> no settings lines, no model line when model null', () => {
  const c = buildContextCard(usage(), { model: null, settings: null }, tr)
  assert.deepEqual(c.lines, ['slash.card.contextUsed|limit=8k,pct=25,used=2k'])
})

test('buildUsageCard: non-empty -> title, totals, top model, action, no estimate note', () => {
  const c = buildUsageCard(
    { period: 'week', summary: summary(), chat: null, chats: [] },
    tr,
  )
  assert.equal(c.title, 'slash.card.usageTitle|period=slash.period.week')
  assert.deepEqual(c.lines, [
    'usage.kpi.total: 7k',
    'slash.card.usageTotals|in=4k,out=2k,reasoning=1k',
    'slash.card.usageTopModel|model=m-big,total=5k',
  ])
  assert.deepEqual(c.action, { label: 'slash.card.usageOpen', kind: 'openUsage' })
  assert.equal(c.rowsTitle, undefined)
  assert.equal('rows' in c, false)
  assert.equal('bar' in c, false)
})

test('buildUsageCard: out never negative when reasoning exceeds completion', () => {
  const c = buildUsageCard(
    { period: 'today', summary: summary({ totals: totals({ completionTokens: 100, reasoningTokens: 400 }) }), chat: null, chats: [] },
    tr,
  )
  assert.equal(c.lines[1], 'slash.card.usageTotals|in=4k,out=0,reasoning=400')
})

test('buildUsageCard: topModel null -> no top model line; model null shows "-"', () => {
  const none = buildUsageCard(
    { period: 'all', summary: summary({ topModel: null }), chat: null, chats: [] },
    tr,
  )
  assert.equal(none.lines.length, 2)
  const dash = buildUsageCard(
    { period: 'all', summary: summary({ topModel: { providerId: null, providerName: null, model: null, totalTokens: 999 } }), chat: null, chats: [] },
    tr,
  )
  assert.equal(dash.lines[2], 'slash.card.usageTopModel|model=-,total=999')
})

test('buildUsageCard: this-chat line when chat has messages; estimated note added', () => {
  const chat = summary({ totals: totals({ totalTokens: 1500, messages: 2 }) })
  const c = buildUsageCard(
    { period: 'month', summary: summary({ estimated: true }), chat, chats: [] },
    tr,
  )
  assert.ok(c.lines.includes('slash.card.usageThisChat|messages=2,total=1.5k'))
  assert.equal(c.lines[c.lines.length - 1], 'usage.estimatedNote')
})

test('buildUsageCard: top 3 chats sorted desc, pct relative to top row, untitled fallback', () => {
  const chats = [
    { conversationId: 'a', title: 'Small', models: [], promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 1000, messages: 1, estimatedMessages: 0, lastActivity: 0 },
    { conversationId: 'b', title: 'Big', models: [], promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 8000, messages: 1, estimatedMessages: 0, lastActivity: 0 },
    { conversationId: 'c', title: '', models: [], promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 4000, messages: 1, estimatedMessages: 0, lastActivity: 0 },
    { conversationId: 'd', title: 'Fourth', models: [], promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 500, messages: 1, estimatedMessages: 0, lastActivity: 0 },
  ]
  const c = buildUsageCard({ period: 'all', summary: summary(), chat: null, chats }, tr)
  assert.equal(c.rowsTitle, 'slash.card.usageTopChats')
  assert.deepEqual(c.rows, [
    { label: 'Big', value: '8k', pct: 100 },
    { label: 'usage.noTitle', value: '4k', pct: 50 },
    { label: 'Small', value: '1k', pct: 13 },
  ])
})

test('buildUsageCard: empty summary -> usageEmpty only, action still present', () => {
  const c = buildUsageCard({ period: 'today', summary: null, chat: null, chats: [] }, tr)
  assert.equal(c.title, 'slash.card.usageTitle|period=slash.period.today')
  assert.deepEqual(c.lines, ['slash.card.usageEmpty'])
  assert.equal(c.action.kind, 'openUsage')
  assert.equal('rows' in c, false)
})

test('buildUsageCard: summary with zero messages is empty, but this-chat line still shown', () => {
  const emptySummary = summary({ totals: totals({ messages: 0, totalTokens: 0 }), topModel: null })
  const chat = summary({ totals: totals({ totalTokens: 300, messages: 1 }) })
  const c = buildUsageCard({ period: 'week', summary: emptySummary, chat, chats: [] }, tr)
  assert.deepEqual(c.lines, [
    'slash.card.usageEmpty',
    'slash.card.usageThisChat|messages=1,total=300',
  ])
})

test('buildUsageCard: empty summary and chat with no messages -> only usageEmpty', () => {
  const chat = summary({ totals: totals({ totalTokens: 0, messages: 0 }) })
  const c = buildUsageCard({ period: 'week', summary: null, chat, chats: [] }, tr)
  assert.deepEqual(c.lines, ['slash.card.usageEmpty'])
})

test('buildCompactCard: compacted -> title with before/after, note line', () => {
  const c = buildCompactCard(
    {
      ok: true, compacted: true, tokensBefore: 12000, tokensAfter: 3400,
      summarizedMessages: 8, keptMessages: 4, summaryTokens: 500, estimated: false,
    },
    tr,
  )
  assert.equal(c.title, 'slash.card.compacted|after=3.4k,before=12k')
  assert.equal(c.tone, 'info')
  assert.deepEqual(c.lines, ['slash.card.compactedNote|k=4,n=8'])
})

test('buildCompactCard: too_short -> info tone, tooShort title, no lines', () => {
  const c = buildCompactCard({ ok: true, compacted: false, reason: 'too_short' }, tr)
  assert.equal(c.title, 'slash.card.tooShort')
  assert.equal(c.tone, 'info')
  assert.deepEqual(c.lines, [])
})

test('buildHelpCard: rows with slash prefix, arg hint and description, no pct', () => {
  const c = buildHelpCard(
    [
      { name: 'usage', argHint: '[today|week|month|all]', description: 'Show token usage' },
      { name: 'clear', description: 'Start a new chat' },
    ],
    tr,
  )
  assert.equal(c.title, 'slash.card.helpTitle')
  assert.deepEqual(c.rows, [
    { label: '/usage [today|week|month|all]', value: 'Show token usage' },
    { label: '/clear', value: 'Start a new chat' },
  ])
  assert.equal(c.rows[0].pct, undefined)
  assert.equal('pct' in c.rows[1], false)
})

test('buildHelpCard: empty entries -> empty rows array', () => {
  const c = buildHelpCard([], tr)
  assert.deepEqual(c.rows, [])
})
