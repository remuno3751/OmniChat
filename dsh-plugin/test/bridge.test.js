import { test, afterEach } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { apply } from '../dist/index.js'
import { makeCtx, makeServer, until, sleep } from './helpers.js'

// Runs without a configured cwd fall back to process.cwd(); keep that out of the real repository
// (every run takes a git checkpoint of its cwd).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-plugin-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

async function boot(overrides = {}, ctxOpts = {}, serverOpts = {}) {
  const server = await makeServer(serverOpts)
  const dsh = makeCtx(ctxOpts)
  if (overrides.setup) overrides.setup(dsh)
  const logs = []
  const { config: cfgOverrides, bridge: bridgeOpts } = { config: {}, bridge: {}, ...overrides.opts }
  const { config, errors } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'pc-test', token: 'SECRET-TOKEN-123', ...cfgOverrides })
  assert.deepEqual(errors, [])
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, (m) => logs.push(m)),
    config,
    log: (m) => logs.push(m),
    reconnectMinMs: 30,
    reconnectMaxMs: 120,
    textBatchMs: 5,
    mirrorFlushMs: 10,
    cancelGraceMs: 150,
    modelsPollMs: 10000,
    dshVersion: '0.2.0-test',
    ...bridgeOpts,
  })
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    dsh.dispose()
    await server.close()
  })
  if (!overrides.noWait) await until(() => server.framesOf('ready').length === 1, 4000, 'ready')
  return { server, dsh, bridge, logs }
}

const run = (server, o) => server.send({ type: 'run', runId: 'r1', sessionId: null, prompt: 'hello', ...o })
const doneFrames = (server) => server.framesOf('done')
const eventsOf = (server, runId = 'r1') => server.framesOf('event').filter((f) => f.runId === runId).map((f) => f.event)

/** Simulates dsh executing the turn of an accepted prompt. */
function simulateTurn(dsh, sid, turn, rpcId, { text = 'Hi there', tool = true, endReason = { kind: 'completed' }, hold = false } = {}) {
  dsh.startTurn(sid, turn, 'hello', rpcId)
  dsh.stream(sid, undefined, 'start')
  dsh.stream(sid, { type: 'reasoning-delta', index: 0, text: 'hmm' })
  dsh.stream(sid, { type: 'text-delta', index: 1, text: text.slice(0, 3) })
  dsh.stream(sid, { type: 'text-delta', index: 1, text: text.slice(3) })
  dsh.event(sid, 'assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text }] } })
  dsh.stream(sid, undefined, 'end')
  if (tool) {
    dsh.event(sid, 'tool/call', { turn, step: 1, callId: 'c1', name: 'glob', arguments: '{"p":"*.ts"}' })
    dsh.event(sid, 'tool/result', { turn, step: 1, callId: 'c1', message: { content: [{ type: 'text', text: 'a.ts' }] } })
  }
  if (!hold) dsh.event(sid, 'turn/end', { turn, reason: endReason })
}

// ---------------------------------------------------------------------------- config

test('config validation: errors are clear and never contain secrets', () => {
  let r = validateConfig({ mode: 'remote' })
  assert.equal(r.config, null)
  assert.match(r.errors.join(';'), /serverUrl is required/)
  assert.match(r.errors.join(';'), /credentials missing/)

  r = validateConfig({ mode: 'remote', serverUrl: 'ftp://x', token: 'SECRET' })
  assert.match(r.errors.join(';'), /http\(s\):\/\/ or ws\(s\)/)
  assert.ok(!r.errors.join(';').includes('SECRET'))

  r = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', token: 't', mirrorScope: 'nope', approvals: 'x', mirror: 'maybe' })
  assert.equal(r.errors.length, 3)

  r = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', username: 'u', password: 'p' }, {})
  assert.ok(r.config)
  assert.equal(r.config.mirror, true)
  assert.equal(r.config.mirrorScope, 'all')
  assert.equal(r.config.approvals, 'remote')
  assert.ok(r.config.name.length > 0)

  // env fallback + warnings for unknown keys
  r = validateConfig({ mode: 'remote', bogus: 1 }, { OMNICHAT_SERVER_URL: 'https://c.example.com', OMNICHAT_TOKEN: 'tok' })
  assert.ok(r.config)
  assert.match(r.warnings.join(';'), /bogus/)
  // blank !!js env results (undefined/empty) fall through to the defaults
  r = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', token: 't', name: '', cwd: undefined, mirror: undefined })
  assert.ok(r.config)
})

test('apply never throws: bad config, missing service, broken ctx', () => {
  const lines = []
  const orig = console.error
  console.error = (m) => lines.push(String(m))
  try {
    assert.doesNotThrow(() => apply(makeCtx().ctx, { mode: 'remote' }))
    assert.doesNotThrow(() => apply({}, { mode: 'remote', serverUrl: 'http://h:1', token: 'SECRET-TOKEN-123' }))
    assert.doesNotThrow(() => apply({ get: () => { throw new Error('boom') }, effect() { throw new Error('boom') } }, { mode: 'remote', serverUrl: 'http://h:1', token: 't' }))
  } finally {
    console.error = orig
  }
  assert.ok(lines.some((l) => l.startsWith('[omnichat]') && /invalid configuration/.test(l)))
  assert.ok(lines.some((l) => /lacks sessionController/.test(l)))
  assert.ok(!lines.join('\n').includes('SECRET-TOKEN-123'))
})

test('apply wires start/stop through ctx.effect', async () => {
  const server = await makeServer()
  const dsh = makeCtx()
  const orig = console.error
  console.error = () => {}
  try {
    apply(dsh.ctx, { mode: 'remote', serverUrl: server.url, name: 'eff', token: 't' })
  } finally {
    console.error = orig
  }
  await until(() => server.framesOf('ready').length === 1, 4000, 'ready via apply')
  assert.equal(dsh.effects.length, 1)
  dsh.dispose() // plugin dispose => ws closed, subscriptions removed
  await until(() => server.last().ws.readyState >= 2, 3000, 'ws closed')
  assert.equal((dsh.handlers.get('session/event') ?? []).length, 0)
  await server.close()
})

// ---------------------------------------------------------------------------- ready / models

test('ready frame carries cwd, version and models; token+name in the URL; models re-sent on change', async () => {
  const { server, dsh } = await boot({ opts: { config: { cwd: 'C:\\work' } } })
  const ready = server.framesOf('ready')[0]
  assert.equal(ready.name, 'pc-test')
  assert.equal(ready.cwd, 'C:\\work')
  assert.equal(ready.dshVersion, '0.2.0-test')
  assert.deepEqual(ready.models, [
    { provider: 'lmstudio', id: 'm-default', name: 'M Default', providerName: 'LM Studio' },
    { provider: 'lmstudio', id: 'm-other', name: 'M Other', providerName: 'LM Studio' },
  ])
  assert.equal(ready.defaultModel, 'lmstudio::m-default')
  const url = new URL('http://x' + server.rec.urls[0])
  assert.equal(url.pathname, '/bridge')
  assert.equal(url.searchParams.get('token'), 'SECRET-TOKEN-123')
  assert.equal(url.searchParams.get('name'), 'pc-test')

  // a settings event triggers a (debounced) refresh; changed default => `models` frame
  dsh.state.default = { provider: 'lmstudio', model: 'm-other' }
  for (const h of dsh.handlers.get('settings/document-updated') ?? []) h.fn()
  await until(() => server.framesOf('models').length === 1, 3000, 'models frame')
  assert.equal(server.framesOf('models')[0].defaultModel, 'lmstudio::m-other')
})

test('models are polled as a fallback', async () => {
  const { server, dsh } = await boot({ opts: { bridge: { modelsPollMs: 60 } } })
  dsh.state.default = { provider: 'lmstudio', model: 'm-other' }
  await until(() => server.framesOf('models').length >= 1, 3000, 'polled models frame')
})

test('wss/https server URLs map to ws/wss', async () => {
  const { toWsUrl } = await import('../dist/wire.js')
  assert.equal(toWsUrl('https://h.example:8787/', 'n', 't'), 'wss://h.example:8787/bridge?token=t&name=n')
  assert.equal(toWsUrl('http://1.2.3.4:1', 'a b', 't'), 'ws://1.2.3.4:1/bridge?token=t&name=a+b')
})

// ---------------------------------------------------------------------------- runs

test('run: creates a session in the configured cwd, streams events, exactly one done', async () => {
  const { server, dsh } = await boot({ opts: { config: { cwd: 'C:\\work' } } })
  run(server, {})
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt call')
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'create')[1], { cwd: 'C:\\work' })
  const prompt = dsh.calls.find((c) => c[0] === 'prompt')[1]
  assert.equal(prompt.requestId, 'r1')
  assert.equal(prompt.mode, 'queue')
  assert.deepEqual(prompt.content, [{ type: 'text', text: 'hello' }])
  const sid = prompt.sessionId

  simulateTurn(dsh, sid, 1, 'r1')
  await until(() => doneFrames(server).length === 1, 3000, 'done')
  await sleep(50)
  assert.equal(doneFrames(server).length, 1)
  assert.deepEqual(doneFrames(server)[0], { type: 'done', runId: 'r1', ok: true, sessionId: sid, warning: 'not a git repository' })

  const evs = eventsOf(server)
  const types = evs.map((e) => e.type)
  assert.equal(evs[0].type, 'session')
  assert.equal(evs[0].sessionId, sid)
  assert.deepEqual(evs[1], { type: 'status', phase: 'turn_start', turn: 1 })
  const text = evs.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assert.equal(text, 'Hi there') // from stream deltas, not duplicated by assistant/message
  assert.equal(evs.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), 'hmm')
  assert.deepEqual(evs.find((e) => e.type === 'tool_call'), { type: 'tool_call', callId: 'c1', tool: 'glob', input: { p: '*.ts' } })
  assert.deepEqual(evs.find((e) => e.type === 'tool_result'), { type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.ts' })
  assert.ok(types.indexOf('tool_call') < types.indexOf('tool_result'))
  assert.deepEqual(evs.find((e) => e.type === 'status' && e.phase === 'turn_end'), { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(evs.find((e) => e.type === 'final'), { type: 'final', text: 'Hi there' })
  assert.equal(types.at(-1), 'final')
  // a following message resumes the same session without create
  dsh.calls.length = 0
  run(server, { runId: 'r2', sessionId: sid, prompt: 'again' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'second prompt')
  assert.ok(!dsh.calls.some((c) => c[0] === 'create'))
  assert.equal(dsh.calls.find((c) => c[0] === 'prompt')[1].sessionId, sid)
})

test('run: text falls back to assistant/message when no stream deltas were seen; tool errors are reported', async () => {
  const { server, dsh } = await boot()
  run(server, {})
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  const sid = dsh.calls.find((c) => c[0] === 'prompt')[1].sessionId
  dsh.startTurn(sid, 1, 'hello', 'r1')
  dsh.event(sid, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'no stream' }] } })
  dsh.event(sid, 'tool/call', { turn: 1, step: 1, callId: 'c9', name: 'shell', arguments: '{"cmd":"x"}' })
  dsh.event(sid, 'tool/result', { turn: 1, step: 1, callId: 'c9', error: true, message: { content: [{ type: 'text', text: 'Error: boom' }] } })
  dsh.event(sid, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model exploded' } } })
  await until(() => doneFrames(server).length === 1, 3000, 'done')
  const evs = eventsOf(server)
  assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'no stream')
  assert.equal(evs.find((e) => e.type === 'tool_result').status, 'error')
  assert.deepEqual(doneFrames(server)[0], { type: 'done', runId: 'r1', ok: false, sessionId: sid, error: 'model exploded', warning: 'not a git repository' })
})

test('run: prompt rejection yields done ok:false with the error', async () => {
  const { server } = await boot({}, { promptError: 'session/agent-busy' })
  run(server, {})
  await until(() => doneFrames(server).length === 1, 3000, 'done')
  assert.equal(doneFrames(server)[0].ok, false)
  assert.equal(doneFrames(server)[0].error, 'session/agent-busy')
})

test('cancel: sessionController.cancel is called and the run ends ok:false "cancelled"', async () => {
  const { server, dsh } = await boot()
  run(server, {})
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  const sid = dsh.calls.find((c) => c[0] === 'prompt')[1].sessionId
  dsh.startTurn(sid, 1, 'hello', 'r1')
  dsh.stream(sid, undefined, 'start')
  dsh.stream(sid, { type: 'text-delta', index: 0, text: 'working' })
  server.send({ type: 'cancel', runId: 'r1' })
  await until(() => dsh.calls.some((c) => c[0] === 'cancel'), 3000, 'cancel call')
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'cancel')[1], { sessionId: sid })
  dsh.event(sid, 'turn/end', { turn: 1, reason: { kind: 'cancelled' } })
  await until(() => doneFrames(server).length === 1, 3000, 'done')
  assert.deepEqual(doneFrames(server)[0], { type: 'done', runId: 'r1', ok: false, sessionId: sid, error: 'cancelled', warning: 'not a git repository' })
  await sleep(250) // grace timer must not produce a second done
  assert.equal(doneFrames(server).length, 1)
})

test('cancel: falls back to done "cancelled" when dsh never reports turn/end; failing cancel also ends the run', async () => {
  const a = await boot()
  run(a.server, {})
  await until(() => a.dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  a.server.send({ type: 'cancel', runId: 'r1' })
  await until(() => doneFrames(a.server).length === 1, 3000, 'fallback done')
  assert.equal(doneFrames(a.server)[0].error, 'cancelled')

  const b = await boot({}, { cancelError: 'session/not-found' })
  run(b.server, {})
  await until(() => b.dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  b.server.send({ type: 'cancel', runId: 'r1' })
  await until(() => doneFrames(b.server).length === 1, 3000, 'done after failing cancel')
  assert.equal(doneFrames(b.server)[0].error, 'cancelled')
})

test('busy: a session running a turn we do not own is refused; so is a second run on the same session', async () => {
  const { server, dsh } = await boot()
  dsh.event('session-gui', 'turn/start', { turn: 1 })
  dsh.state.running.add('session-gui')
  run(server, { sessionId: 'session-gui' })
  await until(() => doneFrames(server).length === 1, 3000, 'busy done')
  assert.deepEqual(doneFrames(server)[0], { type: 'done', runId: 'r1', ok: false, sessionId: 'session-gui', error: 'session busy in dsh' })
  assert.ok(!dsh.calls.some((c) => c[0] === 'prompt'))
  dsh.state.running.delete('session-gui')

  run(server, { runId: 'r2', sessionId: 'session-gui' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt r2')
  run(server, { runId: 'r3', sessionId: 'session-gui' })
  await until(() => doneFrames(server).some((d) => d.runId === 'r3'), 3000, 'busy r3')
  assert.equal(doneFrames(server).find((d) => d.runId === 'r3').error, 'session busy in dsh')
})

test('connection loss during a run cancels it in dsh (server fails the run itself)', async () => {
  const { server, dsh } = await boot()
  run(server, {})
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  server.dropAll()
  await until(() => dsh.calls.some((c) => c[0] === 'cancel'), 3000, 'cancel on drop')
})

// ---------------------------------------------------------------------------- model selection

test('model: selectModel with save/restore of the GUI default model', async () => {
  const { server, dsh } = await boot()
  run(server, { model: 'lmstudio::m-other' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  const names = dsh.calls.map((c) => c[0])
  assert.ok(names.indexOf('selectModel') < names.indexOf('saveSelection'))
  assert.ok(names.indexOf('saveSelection') < names.indexOf('prompt'))
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'selectModel')[1].model, 'm-other')
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'saveSelection')[1], { provider: 'lmstudio', model: 'm-default' })
  assert.deepEqual(dsh.state.default, { provider: 'lmstudio', model: 'm-default' }) // GUI default restored
})

test('model: bare id resolved from the catalog; default model on a new session is not re-selected; "dsh"/null ignored', async () => {
  const a = await boot()
  run(a.server, { model: 'm-other' })
  await until(() => a.dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  assert.equal(a.dsh.calls.find((c) => c[0] === 'selectModel')[1].provider, 'lmstudio')

  const b = await boot()
  run(b.server, { model: 'lmstudio::m-default' })
  await until(() => b.dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  assert.ok(!b.dsh.calls.some((c) => c[0] === 'selectModel'))

  const c = await boot()
  run(c.server, { model: 'dsh' })
  await until(() => c.dsh.calls.some((x) => x[0] === 'prompt'), 3000, 'prompt')
  assert.ok(!c.dsh.calls.some((x) => x[0] === 'selectModel'))
})

test('model: selectModel unavailable => skipped with one warning, run still goes ahead', async () => {
  const { server, dsh, logs } = await boot({}, { noSelect: true })
  run(server, { model: 'lmstudio::m-other' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  assert.equal(logs.filter((l) => /selectModel is missing/.test(l)).length, 1)
})

// ---------------------------------------------------------------------------- mirror

test('mirror: GUI-typed turn streams as sessions deltas (user, streaming assistant, done); own runs are not mirrored', async () => {
  const { server, dsh } = await boot()
  await until(() => server.framesOf('sessions').length === 1, 3000, 'initial full snapshot')
  assert.deepEqual(server.framesOf('sessions')[0], { type: 'sessions', full: true, sessions: [] })

  // GUI typing
  dsh.startTurn('session-gui', 1, 'typed in the GUI')
  await until(() => server.framesOf('sessions').some((f) => !f.full), 3000, 'user delta')
  const first = server.framesOf('sessions').find((f) => !f.full)
  assert.equal(first.full, false)
  assert.equal(first.sessions[0].sessionId, 'session-gui')
  assert.equal(first.sessions[0].cwd, '/w')
  assert.deepEqual(first.sessions[0].messages.map((m) => [m.key, m.role, m.text, m.status]), [['u:1:0', 'user', 'typed in the GUI', 'done']])

  dsh.stream('session-gui', undefined, 'start')
  dsh.stream('session-gui', { type: 'text-delta', index: 0, text: 'partial' })
  await until(() => server.framesOf('sessions').some((f) => f.sessions[0] && f.sessions[0].messages.some((m) => m.key === 'a:1' && m.status === 'streaming' && m.text === 'partial')), 3000, 'streaming delta')

  dsh.event('session-gui', 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] } })
  dsh.event('session-gui', 'tool/call', { turn: 1, step: 1, callId: 'k', name: 'glob', arguments: '{"p":1}' })
  dsh.event('session-gui', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  dsh.event('session-gui', 'session/title', { title: 'GUI chat' })
  await until(() => server.framesOf('sessions').some((f) => f.sessions[0] && f.sessions[0].messages.some((m) => m.key === 'a:1' && m.status === 'done')), 3000, 'done delta')
  const lastA = server.framesOf('sessions').flatMap((f) => f.sessions.flatMap((s) => s.messages)).filter((m) => m.key === 'a:1').at(-1)
  assert.equal(lastA.text, 'final answer\n\n> \u{1F527} glob {"p":1}\n\n')
  await until(() => server.framesOf('sessions').some((f) => f.sessions[0] && f.sessions[0].title === 'GUI chat'), 3000, 'title')

  // own run => no mirror frames for its turn
  const before = server.framesOf('sessions').length
  run(server, { runId: 'mine', sessionId: 'session-gui' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  simulateTurn(dsh, 'session-gui', 2, 'mine', { tool: false })
  await until(() => doneFrames(server).length === 1, 3000, 'own done')
  await sleep(100)
  const later = server.framesOf('sessions').slice(before).flatMap((f) => f.sessions.flatMap((s) => s.messages))
  assert.deepEqual(later.filter((m) => m.key === 'u:2:0' || m.key === 'a:2'), [])
})

test('mirror: unchanged messages are not re-sent (idempotent deltas)', async () => {
  const { server, dsh } = await boot()
  await until(() => server.framesOf('sessions').length === 1, 3000, 'full')
  dsh.startTurn('s', 1, 'one')
  await until(() => server.framesOf('sessions').length === 2, 3000, 'delta 1')
  dsh.event('s', 'agent/inbox/spliced', {}) // ignored event types don't produce frames
  dsh.event('s', 'step/start', { turn: 1, step: 1 })
  await sleep(80)
  assert.equal(server.framesOf('sessions').length, 2)
})

test('mirror: full snapshot on (re)connect from list()+history, newest 30 sessions, capped at 300 messages', async () => {
  const dsh = makeCtx()
  const now = Date.now()
  for (let i = 0; i < 35; i++) {
    const id = `session-old-${i}`
    dsh.event(id, 'turn/start', { turn: 1 })
    dsh.event(id, 'user/message', { content: [{ type: 'text', text: `q${i}` }], role: 'user', id: `u${i}`, source: { kind: 'user' } })
    dsh.event(id, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } })
    dsh.event(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    dsh.sessions.get(id).events.forEach((e, k) => (e.time = now - (35 - i) * 1000 + k))
  }
  // a long session
  const big = 'session-big'
  for (let t = 1; t <= 200; t++) {
    dsh.event(big, 'turn/start', { turn: t })
    dsh.event(big, 'user/message', { content: [{ type: 'text', text: `u${t}` }], role: 'user', id: `bu${t}`, source: { kind: 'user' } })
    dsh.event(big, 'assistant/message', { turn: t, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `r${t}` }] } })
    dsh.event(big, 'turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  dsh.sessions.get(big).events.forEach((e) => (e.time = now + 1))
  // a subagent session and a blank session must be skipped
  dsh.sessions.set('session-sub', { id: 'session-sub', header: { cwd: '/w', origin: 'subagent' }, events: [{ type: 'user/message', seq: 0, time: now, data: { source: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'x' }] } }] })
  dsh.sessions.set('session-blank', { id: 'session-blank', header: { cwd: '/w' }, events: [] })

  const server = await makeServer()
  const { config } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'snap', token: 't' })
  const bridge = new OmniBridge({ host: createHost(dsh.ctx, () => {}), config, log: () => {}, reconnectMinMs: 30, reconnectMaxMs: 60, mirrorFlushMs: 10 })
  bridge.start()
  cleanup.push(async () => { bridge.stop(); await server.close() })
  await until(() => server.framesOf('sessions').length === 1, 5000, 'snapshot')
  const snap = server.framesOf('sessions')[0]
  assert.equal(snap.full, true)
  assert.equal(snap.sessions.length, 30)
  assert.ok(snap.sessions.every((s) => s.sessionId !== 'session-sub' && s.sessionId !== 'session-blank'))
  const bigS = snap.sessions.find((s) => s.sessionId === 'session-big')
  assert.equal(bigS.messages.length, 300) // 400 messages, newest 300 kept
  assert.equal(bigS.messages.at(-1).key, 'a:200')
  assert.deepEqual(snap.sessions.find((s) => s.sessionId === 'session-old-34').messages.map((m) => [m.key, m.text, m.status]), [['u:1:0', 'q34', 'done'], ['a:1', 'a34', 'done']])
  assert.ok(!snap.sessions.some((s) => s.sessionId === 'session-old-0')) // oldest dropped

  // reconnect => ready + full again
  server.dropAll()
  await until(() => server.rec.conns.length === 2 && server.framesOf('sessions').length === 1 && server.framesOf('ready').length === 1, 5000, 'reconnect + resnapshot')
  assert.equal(server.framesOf('sessions')[0].full, true)
})

test('mirror: mirrorScope "cwd" only mirrors sessions in the configured cwd; mirror:false disables it', async () => {
  const a = await boot({ opts: { config: { mirrorScope: 'cwd', cwd: '/w' } } })
  await until(() => a.server.framesOf('sessions').length === 1, 3000, 'full')
  a.dsh.sessions.set('elsewhere', { id: 'elsewhere', header: { cwd: '/other' }, events: [] })
  a.dsh.event('elsewhere', 'turn/start', { turn: 1 })
  a.dsh.event('elsewhere', 'user/message', { content: [{ type: 'text', text: 'x' }], role: 'user', id: 'e1', source: { kind: 'user' } })
  a.dsh.startTurn('inside', 1, 'in scope')
  await until(() => a.server.framesOf('sessions').some((f) => !f.full), 3000, 'delta')
  await sleep(50)
  const ids = a.server.framesOf('sessions').filter((f) => !f.full).flatMap((f) => f.sessions.map((s) => s.sessionId))
  assert.deepEqual([...new Set(ids)], ['inside'])

  const b = await boot({ opts: { config: { mirror: false } } })
  b.dsh.startTurn('s', 1, 'hello')
  await sleep(80)
  assert.equal(b.server.framesOf('sessions').length, 0)
})

test('mirror: missing history API degrades without crashing (one warning from apply)', async () => {
  const dsh = makeCtx({ noInspect: true })
  dsh.ctx.get = (n) => (n === 'sessions' ? undefined : makeCtx().ctx.get(n))
  const lines = []
  const orig = console.error
  console.error = (m) => lines.push(String(m))
  const server = await makeServer()
  try {
    apply(dsh.ctx, { mode: 'remote', serverUrl: server.url, token: 't', name: 'deg' })
  } finally {
    console.error = orig
  }
  assert.equal(lines.filter((l) => /mirroring is off/.test(l)).length, 1)
  await until(() => server.framesOf('ready').length === 1, 3000, 'still connects')
  dsh.dispose()
  await server.close()
})

// ---------------------------------------------------------------------------- reconnect / auth / approvals / secrets

test('reconnect with backoff after the server drops the connection; ready is re-sent', async () => {
  const { server } = await boot()
  server.dropAll()
  await until(() => server.rec.conns.length === 2 && server.framesOf('ready').length === 1, 5000, 'second ready')
  server.dropAll()
  await until(() => server.rec.conns.length === 3, 5000, 'third connection')
})

test('username/password: logs in via POST /auth/login and retries until it works', async () => {
  const { server } = await boot(
    { opts: { config: { token: undefined, username: 'alice', password: 'PW-SECRET-999' } }, noWait: true },
    {},
    { loginFailures: 2 },
  )
  await until(() => server.framesOf('ready').length === 1, 6000, 'ready after login retries')
  assert.equal(server.rec.logins.length, 3)
  assert.deepEqual(server.rec.logins[0], { username: 'alice', password: 'PW-SECRET-999' })
  assert.equal(new URL('http://x' + server.rec.urls[0]).searchParams.get('token'), 'login-token-xyz')
})

test('approvals: "deny" rejects approval requests of our runs only; "gui" registers nothing', async () => {
  const g = await boot({ opts: { config: { approvals: 'gui' } } })
  assert.equal((g.dsh.handlers.get('approval/request') ?? []).length, 0)

  const { server, dsh } = await boot({ opts: { config: { approvals: 'deny' } } })
  const h = dsh.handlers.get('approval/request')[0]
  assert.equal(h.options.prepend, true)
  run(server, {})
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  const sid = dsh.calls.find((c) => c[0] === 'prompt')[1].sessionId
  assert.equal(h.fn({ agent: { id: sid } }, () => 'next'), 'rejected')
  assert.equal(h.fn({ agent: { id: 'someone-else' } }, () => 'next'), 'next')
})

test('no secret logging: token, password and prompts never appear in logs', async () => {
  const { server, dsh, logs } = await boot({}, { promptError: 'nope' })
  run(server, { prompt: 'PROMPT-TOP-SECRET please' })
  await until(() => doneFrames(server).length === 1, 3000, 'done')
  server.dropAll()
  await until(() => server.rec.conns.length === 2, 3000, 'reconnected')

  const bad = await boot({ opts: { config: { token: undefined, username: 'u', password: 'PW-SECRET-999' } }, noWait: true }, {}, { loginFailures: 99 })
  await until(() => bad.server.rec.logins.length >= 1, 3000, 'login attempt')
  await sleep(100)
  const all = [...logs, ...bad.logs].join('\n')
  assert.ok(all.length > 0)
  for (const secret of ['SECRET-TOKEN-123', 'PROMPT-TOP-SECRET', 'PW-SECRET-999']) assert.ok(!all.includes(secret), `leaked ${secret}`)
  assert.ok(dsh)
})

test('recentCwd: the folder of the session last used in the GUI, skipping the plugin profile folder', async () => {
  const { MirrorState, SessionModel } = await import('../dist/mirror.js')
  const st = new MirrorState({ scope: 'all' })
  const mk = (id, cwd, at, human = true) => {
    const m = new SessionModel(id, cwd)
    m.updatedAt = at
    if (human) m.users.set('u:0:0', { key: 'u:0:0', role: 'user', text: 'hi', createdAt: at, status: 'done', order: 0 })
    st.models.set(id, m)
  }
  assert.equal(st.recentCwd(), undefined, 'nothing known yet')
  mk('a', 'C:\work\old', 100)
  mk('b', 'C:\work\recent', 300)
  mk('c', 'C:\Users\me\.dsh\profiles\desktop', 500)
  mk('d', 'C:\work\no-human', 900, false)
  assert.equal(st.recentCwd(['C:\Users\me\.dsh\profiles\desktop']), 'C:\work\recent')
  assert.equal(st.recentCwd(), 'C:\Users\me\.dsh\profiles\desktop', 'without a skip list the newest human session wins')
})

// ---------------------------------------------------------------------------- workspaces (Code tab)

const guiSession = (id, cwd, time) => ({
  id,
  header: { cwd },
  events: [
    { type: 'turn/start', seq: 0, time, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time, data: { content: [{ type: 'text', text: 'hi' }], role: 'user', id: `u-${id}`, source: { kind: 'user' } } },
  ],
})
const withGuiSessions = {
  setup: (dsh) => {
    dsh.sessions.set('s-a', guiSession('s-a', '/proj/a', 2000))
    dsh.sessions.set('s-b', guiSession('s-b', 'C:\\Proj\\B\\', 1000))
  },
}

test('workspaces: ready lists the configured cwd and mirrored folders (most recent first) and the capability', async () => {
  const { server } = await boot({ ...withGuiSessions, opts: { config: { cwd: '/cfg' } } })
  const ready = server.framesOf('ready')[0]
  assert.equal(ready.capabilities.workspaces, true)
  assert.equal(ready.allowAnyCwd, false)
  assert.deepEqual(ready.workspaces[0], '/cfg')
  await until(() => server.framesOf('sessions').length >= 1, 3000, 'full snapshot')
  await until(() => server.framesOf('workspaces').length >= 1, 3000, 'workspaces frame')
  assert.deepEqual(server.framesOf('workspaces').at(-1).workspaces, ['/cfg', '/proj/a', 'C:\\Proj\\B\\'])
})

test('workspaces: a run may start in a known workspace; the session event carries the folder actually used', async () => {
  const { server, dsh } = await boot(withGuiSessions)
  await until(() => server.framesOf('workspaces').length >= 1, 3000, 'workspaces')
  run(server, { cwd: 'c:/proj/b' }) // same folder as 'C:\Proj\B\' (Windows: case and slashes do not matter)
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt')
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'create')[1], { cwd: 'c:/proj/b' })
  assert.equal(eventsOf(server)[0].type, 'session')
  assert.equal(eventsOf(server)[0].cwd, 'c:/proj/b')
})

test('workspaces: unknown, relative, traversal and control-character folders are refused; nothing is created', async () => {
  const { server, dsh } = await boot(withGuiSessions)
  await until(() => server.framesOf('workspaces').length >= 1, 3000, 'workspaces')
  const bad = [
    '/etc', '/proj/a2', '/proj', 'proj/a', './proj/a', '', '/proj/a/../../etc', '/proj/a/..', '/proj/a/../a',
    '/proj/a\u0000', '/proj/a\n', '/proj/a\u007f', '\\proj\\a', 'C:Proj\\B', '//proj/a', 'x'.repeat(1001),
  ]
  for (const [i, cwd] of bad.entries()) {
    run(server, { runId: `bad${i}`, cwd })
    await until(() => doneFrames(server).some((d) => d.runId === `bad${i}`), 3000, `done ${i}`)
    const d = doneFrames(server).find((x) => x.runId === `bad${i}`)
    assert.equal(d.ok, false, JSON.stringify(cwd))
    assert.equal(d.error, 'cwd not allowed')
  }
  run(server, { runId: 'num', cwd: 42 })
  await until(() => dsh.calls.some((c) => c[0] === 'create'), 3000, 'non-string cwd is treated as absent')
  assert.equal(dsh.calls.filter((c) => c[0] === 'create').length, 1)
})

test('workspaces: allowAnyCwd opens unknown absolute folders, but never unsafe ones', async () => {
  const { server, dsh } = await boot({ opts: { config: { allowAnyCwd: true } } })
  assert.equal(server.framesOf('ready')[0].allowAnyCwd, true)
  run(server, { runId: 'bad', cwd: '/x/../etc' })
  await until(() => doneFrames(server).some((d) => d.runId === 'bad'), 3000, 'refused')
  assert.equal(doneFrames(server).find((d) => d.runId === 'bad').error, 'cwd not allowed')
  run(server, { runId: 'ok', cwd: '/anywhere/new' })
  await until(() => dsh.calls.some((c) => c[0] === 'create'), 3000, 'create')
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'create')[1], { cwd: '/anywhere/new' })
})

test('workspaces: cwd is ignored when resuming a session; no cwd keeps the bridge default', async () => {
  const { server, dsh } = await boot({ ...withGuiSessions })
  run(server, { runId: 'r2', sessionId: 's-a', cwd: '/etc' })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt'), 3000, 'prompt on existing session')
  assert.ok(!dsh.calls.some((c) => c[0] === 'create'))
  dsh.calls.length = 0
  run(server, { runId: 'r3' })
  await until(() => dsh.calls.some((c) => c[0] === 'create'), 3000, 'create')
  // no config cwd: the folder last used in the GUI (s-a is newest)
  assert.deepEqual(dsh.calls.find((c) => c[0] === 'create')[1], { cwd: '/proj/a' })
})
