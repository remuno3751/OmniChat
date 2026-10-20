import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { LocalLink } from '../dist/local.js'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { apply } from '../dist/index.js'
import { readPairing } from '../dist/pairing.js'
import { makeCtx, makeServer, until, sleep } from './helpers.js'

// Runs without a configured cwd fall back to process.cwd(); keep that out of the real repository.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-local-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

function tmpPairingFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-local-'))
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'omnichat-bridge.json')
}

/** A bridge in local mode on a scratch pairing file, listening on an ephemeral loopback port. */
async function bootLocal({ config: cfgOver = {}, link: linkOpts = {}, ctx: ctxOpts = {}, bridge: bridgeOpts = {}, file } = {}) {
  const dsh = makeCtx(ctxOpts)
  const pairingFile = file ?? tmpPairingFile()
  const logs = []
  const raw = []
  const { config, errors } = validateConfig({ mode: 'local', pairingFile, name: 'pc-local', ...cfgOver })
  assert.deepEqual(errors, [])
  config.listenPort = 0
  const link = new LocalLink({
    config,
    log: (m) => logs.push(m),
    rawLog: (m) => raw.push(m),
    pluginVersion: '9.9.9-test',
    authDelayMs: 50,
    helloTimeoutMs: 400,
    lockoutMs: 500,
    maxFailures: 5,
    ...linkOpts,
  })
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, (m) => logs.push(m)),
    config,
    log: (m) => logs.push(m),
    link,
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
  })
  await until(() => link.port !== undefined, 4000, 'listen')
  return { link, dsh, bridge, logs, raw, config, file: pairingFile, port: link.port, code: link.pairing }
}

/** A raw test client (the `ws` package). Frames, raw texts and the close code are recorded. */
function client(port, { origin } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/omnichat-bridge`, origin === undefined ? {} : { origin })
  const c = { ws, frames: [], raw: [], closeCode: undefined, closeReason: undefined }
  ws.on('error', () => {})
  ws.on('message', (d) => {
    const s = d.toString()
    c.raw.push(s)
    try {
      c.frames.push(JSON.parse(s))
    } catch {
      /* not JSON */
    }
  })
  c.open = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  c.open.catch(() => {})
  c.closed = new Promise((resolve) => {
    ws.once('close', (code, reason) => {
      c.closeCode = code
      c.closeReason = reason.toString()
      resolve(code)
    })
  })
  cleanup.push(async () => {
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  })
  return c
}

/** Connects, then sends a hello (valid code unless overridden). Does not wait for ready. */
async function attachRaw(env, { origin, code = env.code, hello = {} } = {}) {
  const c = client(env.port, { origin })
  await c.open
  c.ws.send(JSON.stringify({ type: 'hello', pairing: code, ...hello }))
  return c
}

const readyOf = (c) => c.frames.find((f) => f.type === 'ready')
async function waitReady(c, ms = 4000) {
  await until(() => readyOf(c), ms, 'ready')
  return readyOf(c)
}

/** Sends a run and waits until dsh got the prompt. Returns the session id. */
async function startRun(env, c, runId = 'r1', sessionId = null) {
  const count = () => env.dsh.calls.filter((x) => x[0] === 'prompt').length
  const before = count()
  c.ws.send(JSON.stringify({ type: 'run', runId, sessionId, prompt: 'hello' }))
  await until(() => count() > before, 3000, 'prompt')
  return env.dsh.calls.filter((x) => x[0] === 'prompt').at(-1)[1].sessionId
}

const isDetached = (env) => () => env.logs.some((l) => /app disconnected/.test(l))

/** Simulates dsh executing the turn of an accepted prompt (same pattern as bridge.test.js). */
function simulateTurn(dsh, sid, turn, rpcId, { text = 'Hi there', tool = false, hold = false } = {}) {
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
  if (!hold) dsh.event(sid, 'turn/end', { turn, reason: { kind: 'completed' } })
}

/** Raw HTTP upgrade request with a chosen Host header; resolves with the status code. */
function rawUpgrade(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/omnichat-bridge',
      headers: {
        Host: host,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

// ---------------------------------------------------------------------------- handshake

test('happy path: ready arrives first with mode/version/instance/seq; a run streams and finishes', async () => {
  const env = await bootLocal()
  const c = await attachRaw(env)
  const ready = await waitReady(c)
  assert.equal(c.frames[0].type, 'ready')
  assert.equal(ready.mode, 'local')
  assert.equal(ready.version, '9.9.9-test')
  assert.equal(typeof ready.instance, 'string')
  assert.ok(ready.instance.length > 0)
  assert.equal(ready.seq, 0)
  assert.equal(ready.name, 'pc-local')
  assert.deepEqual(ready.models.map((m) => m.id), ['m-default', 'm-other'])
  assert.equal(c.frames.filter((f) => f.type === 'ready').length, 1)
  assert.equal(c.closeCode, undefined)

  const sid = await startRun(env, c, 'r1')
  simulateTurn(env.dsh, sid, 1, 'r1', { tool: true })
  await until(() => c.frames.some((f) => f.type === 'done'), 3000, 'done')
  const evs = c.frames.filter((f) => f.type === 'event' && f.runId === 'r1').map((f) => f.event)
  assert.equal(evs[0].type, 'session')
  assert.equal(evs.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hi there')
  assert.ok(evs.some((e) => e.type === 'tool_call' && e.tool === 'glob'))
  assert.deepEqual(evs.find((e) => e.type === 'final'), { type: 'final', text: 'Hi there' })
  const done = c.frames.find((f) => f.type === 'done')
  assert.equal(done.runId, 'r1')
  assert.equal(done.ok, true)

  assert.ok(!env.logs.join('\n').includes(env.code), 'pairing code must not reach the normal log')
  assert.equal(typeof readPairing(env.file).pairedAt, 'string')
})

test('wrong pairing code: nothing is sent and the socket is closed 4401 after the auth delay', async () => {
  const env = await bootLocal()
  const c = await attachRaw(env, { code: 'x'.repeat(env.code.length) })
  const t0 = Date.now()
  assert.equal(await c.closed, 4401)
  assert.ok(Date.now() - t0 >= 40, 'close waited for the auth delay')
  assert.equal(c.closeReason, 'pairing rejected')
  assert.equal(c.frames.length, 0)
})

test('five failures lock out: a correct code is refused with 4429 until the lockout passes', async () => {
  const env = await bootLocal({ link: { lockoutMs: 500 } })
  for (let i = 0; i < 5; i++) {
    const bad = await attachRaw(env, { code: 'nope' })
    assert.equal(await bad.closed, 4401)
  }
  const locked = await attachRaw(env)
  assert.equal(await locked.closed, 4429)
  assert.equal(locked.frames.length, 0)
  await sleep(550)
  const ok = await attachRaw(env)
  await waitReady(ok)
})

test('a non-hello first frame counts as a failure and is closed 4401', async () => {
  const env = await bootLocal()
  const c = client(env.port)
  await c.open
  c.ws.send(JSON.stringify({ type: 'run', runId: 'x', sessionId: null, prompt: 'p' }))
  assert.equal(await c.closed, 4401)
  assert.equal(c.frames.length, 0)

  const g = client(env.port)
  await g.open
  g.ws.send('not json at all')
  assert.equal(await g.closed, 4401)
})

test('no hello within helloTimeoutMs: counted as a failure and closed 4401', async () => {
  const env = await bootLocal({ link: { helloTimeoutMs: 150 } })
  const c = client(env.port)
  await c.open
  assert.equal(await c.closed, 4401)
  assert.equal(c.frames.length, 0)
})

// ---------------------------------------------------------------------------- origin / host

test('origin rules: unknown Origin without pair:true is 4403 and not counted; tauri origins work; pair:true persists the origin', async () => {
  const env = await bootLocal()
  // six refusals would lock out if they counted as failures
  for (let i = 0; i < 6; i++) {
    const c = await attachRaw(env, { origin: 'https://evil.example' })
    assert.equal(await c.closed, 4403)
    assert.equal(c.closeReason, 'origin not allowed')
  }
  const tauri = await attachRaw(env, { origin: 'tauri://localhost' })
  await waitReady(tauri)
  const https = await attachRaw(env, { origin: 'https://tauri.localhost' })
  await waitReady(https)

  const paired = await attachRaw(env, { origin: 'https://chat.example.com', hello: { pair: true } })
  await waitReady(paired)
  assert.ok(readPairing(env.file).allowedOrigins.includes('https://chat.example.com'))

  // now allowed without pair:true
  const again = await attachRaw(env, { origin: 'https://chat.example.com' })
  await waitReady(again)

  // no Origin header (non-browser client) with a valid code
  const none = await attachRaw(env, { origin: undefined })
  await waitReady(none)

  // pair:true with a wrong code from an unknown origin is a counted failure
  const bad = await attachRaw(env, { origin: 'https://other.example', code: 'wrong', hello: { pair: true } })
  assert.equal(await bad.closed, 4401)
})

test('DNS-rebinding defence: a foreign Host header gets 403; loopback names with the bound port are accepted', async () => {
  const env = await bootLocal()
  assert.equal(await rawUpgrade(env.port, `evil.example:${env.port}`), 403)
  assert.equal(await rawUpgrade(env.port, '127.0.0.1:1'), 403)
  assert.equal(await rawUpgrade(env.port, `localhost:${env.port}`), 101)
  assert.equal(await rawUpgrade(env.port, `127.0.0.1:${env.port}`), 101)
})

test('listens on loopback only', async () => {
  const env = await bootLocal()
  const addrs = env.link.addresses
  assert.ok(addrs.length >= 1)
  for (const a of addrs) {
    assert.ok(a.address === '127.0.0.1' || a.address === '::1', `unexpected address ${a.address}`)
    assert.equal(a.port, env.port)
  }
})

// ---------------------------------------------------------------------------- attach / replace / detach

test('a second client replaces the first (4000, detached first); the second one works', async () => {
  const env = await bootLocal()
  const a = await attachRaw(env)
  await waitReady(a)
  const b = await attachRaw(env)
  await waitReady(b)
  assert.equal(await a.closed, 4000)
  assert.equal(a.closeReason, 'replaced')
  const aCount = a.frames.length

  const sid = await startRun(env, b, 'r9')
  simulateTurn(env.dsh, sid, 1, 'r9')
  await until(() => b.frames.some((f) => f.type === 'done' && f.runId === 'r9'), 3000, 'done on b')
  await sleep(30)
  assert.equal(a.frames.length, aCount, 'the replaced client gets no further frames')
})

test('detach mid-run: the turn keeps going and its frames replay after ready on reattach; delivered frames are not repeated', async () => {
  const env = await bootLocal()
  const a = await attachRaw(env)
  await waitReady(a)
  const sid = await startRun(env, a, 'r1')
  env.dsh.startTurn(sid, 1, 'hello', 'r1')
  env.dsh.stream(sid, undefined, 'start')
  env.dsh.stream(sid, { type: 'text-delta', index: 0, text: 'partial' })
  await until(() => a.frames.some((f) => f.type === 'event' && f.event?.type === 'text' && f.event.text === 'partial'), 3000, 'partial text')

  a.ws.close()
  await until(isDetached(env), 3000, 'detach')
  // the turn finishes while no app is attached
  env.dsh.event(sid, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'after detach' }] } })
  env.dsh.event(sid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  const b = await attachRaw(env)
  const readyB = await waitReady(b)
  await until(() => b.frames.some((f) => f.type === 'done' && f.runId === 'r1'), 3000, 'replayed done')
  assert.equal(b.frames[0].type, 'ready')
  assert.ok(readyB.seq > 0)
  const evs = b.frames.filter((f) => f.type === 'event' && f.runId === 'r1').map((f) => f.event)
  assert.deepEqual(evs.find((e) => e.type === 'final'), { type: 'final', text: 'after detach' })
  assert.ok(!b.raw.some((s) => s.includes('"partial"')), 'a frame already delivered is not replayed')
  assert.equal(b.frames.filter((f) => f.type === 'done').length, 1)
  const doneIdx = b.frames.findIndex((f) => f.type === 'done')
  assert.ok(doneIdx > 0, 'done arrives after ready')
})

test('resume {instance, sinceSeq}: same instance replays from sinceSeq; another instance replays from the last delivered frame', async () => {
  const env = await bootLocal()
  const a = await attachRaw(env)
  const readyA = await waitReady(a)
  const sid = await startRun(env, a, 'r1')
  simulateTurn(env.dsh, sid, 1, 'r1')
  await until(() => a.frames.some((f) => f.type === 'done' && f.runId === 'r1'), 3000, 'r1 done')

  await startRun(env, a, 'r2', sid)
  env.dsh.startTurn(sid, 2, 'hello', 'r2')
  env.dsh.stream(sid, { type: 'text-delta', index: 0, text: 'second' })
  await until(() => a.frames.some((f) => f.type === 'event' && f.event?.type === 'text' && f.event.text === 'second'), 3000, 'second text')
  a.ws.close()
  await until(isDetached(env), 3000, 'detach')
  env.dsh.event(sid, 'turn/end', { turn: 2, reason: { kind: 'completed' } })

  const b = await attachRaw(env, { hello: { resume: { instance: readyA.instance, sinceSeq: 0 } } })
  const readyB = await waitReady(b)
  assert.equal(readyB.seq, 0)
  await until(() => b.frames.some((f) => f.type === 'done' && f.runId === 'r2'), 3000, 'r2 done')
  assert.ok(b.frames.some((f) => f.type === 'event' && f.runId === 'r1'), 'r1 frames replayed from sinceSeq 0')
  b.ws.close()
  await b.closed

  const c = await attachRaw(env, { hello: { resume: { instance: 'some-other-instance', sinceSeq: 0 } } })
  const readyC = await waitReady(c)
  assert.ok(readyC.seq > 0)
  assert.equal(c.frames.filter((f) => f.type === 'event').length, 0, 'unknown instance: nothing older than delivered is replayed')
})

test('the replay buffer is bounded by bufferBytes: the oldest frames go first', async () => {
  const env = await bootLocal({ link: { bufferBytes: 1500 } })
  const a = await attachRaw(env)
  await waitReady(a)
  const sid = await startRun(env, a, 'r1')
  env.dsh.startTurn(sid, 1, 'hello', 'r1')
  env.dsh.stream(sid, undefined, 'start')
  a.ws.close()
  await until(isDetached(env), 3000, 'detach')
  for (let i = 0; i < 10; i++) {
    env.dsh.stream(sid, { type: 'text-delta', index: 0, text: `chunk${i}-${'x'.repeat(300)}` })
    await sleep(15)
  }
  env.dsh.event(sid, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  const b = await attachRaw(env)
  await waitReady(b)
  await until(() => b.frames.some((f) => f.type === 'done' && f.runId === 'r1'), 3000, 'done replayed')
  const chunks = b.raw.filter((s) => s.includes('chunk')).length
  assert.ok(chunks > 0 && chunks < 10, `replayed ${chunks} of 10 chunks`)
  assert.ok(!b.raw.some((s) => s.includes('chunk0-')), 'oldest chunk dropped')
  assert.ok(b.raw.some((s) => s.includes('chunk9-')), 'newest chunk kept')
})

test('models and sessions frames are not buffered: nothing replays after a reattach; ready carries the current models', async () => {
  const env = await bootLocal()
  const a = await attachRaw(env)
  await waitReady(a)
  a.ws.close()
  await until(isDetached(env), 3000, 'detach')

  env.dsh.state.default = { provider: 'lmstudio', model: 'm-other' }
  for (const h of env.dsh.handlers.get('settings/document-updated') ?? []) h.fn()
  await sleep(1200) // the models refresh is debounced to 1s

  const b = await attachRaw(env)
  const readyB = await waitReady(b)
  assert.equal(readyB.defaultModel, 'lmstudio::m-other')
  await sleep(100)
  assert.equal(b.frames.filter((f) => f.type === 'models').length, 0)
})

// ---------------------------------------------------------------------------- pairing log

test('the pairing code goes to rawLog only until the app has paired', async () => {
  const file = tmpPairingFile()
  const env1 = await bootLocal({ file })
  assert.ok(env1.raw.includes(`OmniChat pairing code: ${env1.code}`))
  assert.ok(!env1.logs.some((l) => l.includes(env1.code)))

  const c = await attachRaw(env1)
  await waitReady(c)
  assert.equal(typeof readPairing(file).pairedAt, 'string')

  const { config } = validateConfig({ mode: 'local', pairingFile: file, name: 'again' })
  config.listenPort = 0
  const raw = []
  const logs = []
  const link2 = new LocalLink({ config, log: (m) => logs.push(m), rawLog: (m) => raw.push(m), pluginVersion: 'x' })
  await link2.start({ onAttach() {}, onDetach() {}, onMessage() {} })
  cleanup.push(async () => link2.stop())
  assert.equal(link2.pairing, env1.code)
  assert.ok(!raw.some((l) => l.includes(env1.code)), 'code not printed after pairing')
  assert.ok(logs.some((l) => l.startsWith('already paired; run `node dist/pair.js`')))
})

// ---------------------------------------------------------------------------- plugin entry / remote unchanged

test('apply() in local mode: creates the pairing file, listens on loopback and accepts the paired app', async () => {
  const probe = net.createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))

  const file = tmpPairingFile()
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const lines = []
  const orig = console.error
  console.error = (m) => lines.push(String(m))
  try {
    apply(dsh.ctx, { mode: 'local', listenPort: port, pairingFile: file, name: 'loc' })
  } finally {
    console.error = orig
  }
  assert.ok(lines.some((l) => l.includes(`plugin loaded (local mode, 127.0.0.1:${port}`)))
  const code = readPairing(file)?.pairing
  assert.equal(typeof code, 'string')

  let c
  const deadline = Date.now() + 4000
  for (;;) {
    c = client(port)
    try {
      await c.open
      break
    } catch {
      if (Date.now() > deadline) throw new Error('local server never listened')
      await sleep(30)
    }
  }
  c.ws.send(JSON.stringify({ type: 'hello', pairing: code }))
  await waitReady(c)
})

test('remote mode: OmniBridge without a link still dials out and sends ready', async () => {
  const server = await makeServer()
  const dsh = makeCtx()
  const { config, errors } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'r', token: 'tok-remote-1' })
  assert.deepEqual(errors, [])
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, () => {}),
    config,
    log: () => {},
    reconnectMinMs: 30,
    reconnectMaxMs: 120,
    mirrorFlushMs: 10,
    modelsPollMs: 10000,
  })
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    dsh.dispose()
    await server.close()
  })
  await until(() => server.framesOf('ready').length === 1, 4000, 'remote ready')
  assert.ok(server.rec.urls[0].includes('token=tok-remote-1'))
})
