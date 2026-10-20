import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { LocalLink } from '../dist/local.js'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { readPairing } from '../dist/pairing.js'
import { OmniChatBridgeController, makeBridgeOps } from '../dist/remote.js'
import { makeCtx, until, sleep } from './helpers.js'

// Runs without a configured cwd fall back to process.cwd(); keep that out of the real repository.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-pair-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

function tmpPairingFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-pair-'))
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'omnichat-bridge.json')
}

/** A bridge in local mode on a scratch pairing file, listening on an ephemeral loopback port. */
async function bootLocal({ link: linkOpts = {}, file } = {}) {
  const dsh = makeCtx()
  const pairingFile = file ?? tmpPairingFile()
  const logs = []
  const raw = []
  const { config, errors } = validateConfig({ mode: 'local', pairingFile, name: 'pc-pair' })
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
  })
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    dsh.dispose()
    link.stop()
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

/** Connects and sends a pairing request hello. Does not wait for pair-pending. */
async function pairRequest(env, opts = {}) {
  const { clientName } = opts
  // `origin: undefined` means "no Origin header", so the default only applies when the key is absent
  const origin = 'origin' in opts ? opts.origin : 'http://localhost:3000'
  const c = client(env.port, { origin })
  await c.open
  const hello = { type: 'hello', client: 'omnichat', version: '1.0.0', pairRequest: true }
  if (clientName !== undefined) hello.clientName = clientName
  c.ws.send(JSON.stringify(hello))
  return c
}

/** Waits for the pair-pending frame of a pairing request and returns it. */
async function pendingFrame(c) {
  await until(() => c.frames.some((f) => f.type === 'pair-pending'), 3000, 'pair-pending')
  return c.frames.find((f) => f.type === 'pair-pending')
}

/** Connects and sends a normal hello (valid code unless overridden). Does not wait for ready. */
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

function expectUnknownRequest(fn) {
  assert.throws(fn, (e) => e.code === 'unknown-request' && e.message === 'No such pending request')
}

// ---------------------------------------------------------------------------- secrecy

test('an unapproved pairing request only gets pair-pending; the pairing code never reaches it', async () => {
  const env = await bootLocal()
  const c = await pairRequest(env, { origin: 'http://localhost:3000' })
  await pendingFrame(c)
  await sleep(100)
  assert.equal(c.frames.length, 1)
  assert.equal(c.frames[0].type, 'pair-pending')
  assert.equal(typeof c.frames[0].requestId, 'string')
  assert.equal(c.frames[0].expiresInSec, 120)
  assert.ok(!c.raw.some((s) => s.includes(env.code)), 'no frame may carry the pairing code')
  assert.equal(c.closeCode, undefined)
  assert.ok(!env.logs.some((l) => l.includes(env.code)), 'the pairing code is never logged')
})

// ---------------------------------------------------------------------------- origin gate

test('origin gate: missing and non-loopback origins are refused 4403 with no pending request and no failure; loopback and Tauri origins are accepted', async () => {
  const env = await bootLocal({ link: { maxPending: 10 } })
  for (const origin of [undefined, 'https://evil.example', 'http://evil.example', 'http://192.168.1.5:8787', 'http://localhost.evil.com']) {
    const c = await pairRequest(env, { origin })
    assert.equal(await c.closed, 4403, `origin ${origin}`)
    assert.equal(c.closeReason, 'origin not allowed')
    assert.equal(c.frames.length, 0)
  }
  assert.equal(env.link.status().pending.length, 0)
  assert.equal(env.link.failures, 0)

  const accepted = ['http://localhost:3000', 'http://127.0.0.1:8787', 'http://[::1]:4000', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']
  for (const origin of accepted) {
    const c = await pairRequest(env, { origin })
    await pendingFrame(c)
  }
  assert.deepEqual(env.link.status().pending.map((p) => p.origin).sort(), [...accepted].sort())
})

// ---------------------------------------------------------------------------- expiry / deny

test('expiry: the request is denied with reason expired, closed 4002, and counted as a failure', async () => {
  const env = await bootLocal({ link: { pairRequestTtlMs: 150 } })
  const c = await pairRequest(env)
  const pending = await pendingFrame(c)
  assert.equal(pending.expiresInSec, 1)
  assert.equal(await c.closed, 4002)
  assert.equal(c.closeReason, 'expired')
  assert.deepEqual(c.frames.find((f) => f.type === 'pair-denied'), { type: 'pair-denied', reason: 'expired' })
  assert.equal(env.link.failures, 1)
  assert.equal(env.link.status().pending.length, 0)
  assert.ok(!c.raw.some((s) => s.includes(env.code)))
})

test('deny: the request gets pair-denied denied, is closed 4002, and is counted as a failure', async () => {
  const env = await bootLocal()
  const c = await pairRequest(env)
  const { requestId } = await pendingFrame(c)
  const state = env.link.deny(requestId)
  assert.equal(state.pending.length, 0)
  assert.equal(await c.closed, 4002)
  assert.equal(c.closeReason, 'denied')
  assert.deepEqual(c.frames.find((f) => f.type === 'pair-denied'), { type: 'pair-denied', reason: 'denied' })
  assert.equal(env.link.failures, 1)
  expectUnknownRequest(() => env.link.approve(requestId))
})

// ---------------------------------------------------------------------------- caps

test('pending cap: a second request from the same origin and a fourth request overall are closed 4003 with no frame', async () => {
  const env = await bootLocal() // maxPending defaults to 3
  const first = await pairRequest(env, { origin: 'http://localhost:3001' })
  await pendingFrame(first)

  const dup = await pairRequest(env, { origin: 'http://localhost:3001' })
  assert.equal(await dup.closed, 4003)
  assert.equal(dup.closeReason, 'too many pending requests')
  assert.equal(dup.frames.length, 0)

  for (const port of [3002, 3003]) await pendingFrame(await pairRequest(env, { origin: `http://localhost:${port}` }))

  const fourth = await pairRequest(env, { origin: 'http://localhost:3004' })
  assert.equal(await fourth.closed, 4003)
  assert.equal(fourth.frames.length, 0)
  assert.equal(env.link.status().pending.length, 3)
  assert.equal(env.link.failures, 0, 'refusals by the cap are not failures')
})

// ---------------------------------------------------------------------------- unknown ids

test('approve and deny with an unknown id throw code unknown-request; the controller maps it to a RemoteError', async () => {
  const env = await bootLocal()
  for (const bad of ['nope', undefined, 42, {}, { id: 'nope' }]) {
    expectUnknownRequest(() => env.link.approve(bad))
    expectUnknownRequest(() => env.link.deny(bad))
  }
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const ctrl = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: env.config, link: env.link, pluginVersion: '9.9.9-test' }))
  await assert.rejects(ctrl.approve('nope'), (e) => e.isDSHRemoteError === true && e.code === 'omnichatbridge/unknown-request')
  await assert.rejects(ctrl.approve({ id: 'nope' }), (e) => e.code === 'omnichatbridge/unknown-request')
  await assert.rejects(ctrl.deny('nope'), (e) => e.code === 'omnichatbridge/unknown-request')
  await assert.rejects(ctrl.deny({ id: 'nope' }), (e) => e.code === 'omnichatbridge/unknown-request')
})

// ---------------------------------------------------------------------------- regenerate / disconnect

test('regenerate invalidates pending requests: pair-denied invalidated, closed 4002, no failure; a later approve is unknown-request', async () => {
  const env = await bootLocal()
  const before = env.code
  const c = await pairRequest(env)
  const { requestId } = await pendingFrame(c)
  env.link.regenerate()
  assert.notEqual(env.link.pairing, before)
  assert.equal(await c.closed, 4002)
  assert.equal(c.closeReason, 'invalidated')
  assert.deepEqual(c.frames.find((f) => f.type === 'pair-denied'), { type: 'pair-denied', reason: 'invalidated' })
  assert.equal(env.link.failures, 0)
  assert.equal(env.link.status().pending.length, 0)
  expectUnknownRequest(() => env.link.approve(requestId))
})

test('a pending socket that disconnects is removed from the pending list, with no failure counted', async () => {
  const env = await bootLocal()
  const c = await pairRequest(env)
  const { requestId } = await pendingFrame(c)
  assert.equal(env.link.status().pending.length, 1)
  c.ws.close()
  await until(() => env.link.status().pending.length === 0, 3000, 'pending request removed')
  assert.equal(env.link.failures, 0)
  expectUnknownRequest(() => env.link.approve(requestId))
})

// ---------------------------------------------------------------------------- happy path

test('approve: only that socket gets pair-approved with the code; the origin is allowed; a normal hello then authenticates', async () => {
  const env = await bootLocal()
  const origin = 'http://localhost:3000'
  const other = await pairRequest(env, { origin: 'http://localhost:3001' })
  await pendingFrame(other)
  const a = await pairRequest(env, { origin })
  const { requestId } = await pendingFrame(a)

  const state = env.link.approve(requestId)
  assert.equal(await a.closed, 1000)
  assert.equal(a.closeReason, 'approved')
  const approved = a.frames.find((f) => f.type === 'pair-approved')
  assert.equal(a.frames.at(-1).type, 'pair-approved')
  assert.equal(approved.pairing, readPairing(env.file).pairing)
  assert.equal(approved.pairing, env.code)
  assert.ok(!other.raw.some((s) => s.includes(env.code)), 'the other pending socket never gets the code')

  assert.equal(state.pending.length, 1, 'the other request is still pending')
  assert.ok(state.allowedOrigins.includes(origin))
  assert.equal(state.paired, true)
  assert.equal(typeof state.pairedAt, 'string')
  assert.ok(readPairing(env.file).allowedOrigins.includes(origin))
  assert.equal(env.link.failures, 0)

  const again = await attachRaw(env, { origin, code: approved.pairing })
  const ready = await waitReady(again)
  assert.equal(ready.mode, 'local')
})

// ---------------------------------------------------------------------------- lockout

test('repeated denials lock out new pairing requests with 4429 until the lockout passes', async () => {
  const env = await bootLocal({ link: { maxFailures: 2, lockoutMs: 600 } })
  for (const origin of ['http://localhost:3001', 'http://localhost:3002']) {
    const c = await pairRequest(env, { origin })
    const { requestId } = await pendingFrame(c)
    env.link.deny(requestId)
    assert.equal(await c.closed, 4002)
  }
  assert.equal(env.link.status().locked, true)

  const refused = await pairRequest(env, { origin: 'http://localhost:3003' })
  assert.equal(await refused.closed, 4429)
  assert.equal(refused.frames.length, 0)

  await sleep(650)
  await pendingFrame(await pairRequest(env, { origin: 'http://localhost:3004' }))
})

// ---------------------------------------------------------------------------- state shape

test('status().pending has the documented shape, cleans clientName, and never holds a token; remote mode reports pending []', async () => {
  const env = await bootLocal({ link: { pairRequestTtlMs: 60000 } })
  const c = await pairRequest(env, { origin: 'http://localhost:3000', clientName: '  Hi\u0000there\u0007  ' })
  const first = await pendingFrame(c)
  await pendingFrame(await pairRequest(env, { origin: 'http://127.0.0.1:3000', clientName: 'x'.repeat(100) }))
  await pendingFrame(await pairRequest(env, { origin: 'http://[::1]:3000' }))

  const list = env.link.status().pending
  const byOrigin = Object.fromEntries(list.map((p) => [p.origin, p]))
  const p = byOrigin['http://localhost:3000']
  assert.deepEqual(Object.keys(p).sort(), ['clientName', 'createdAt', 'expiresAt', 'expiresInSec', 'id', 'origin'])
  assert.equal(p.id, first.requestId)
  assert.equal(p.clientName, 'Hithere')
  assert.equal(byOrigin['http://127.0.0.1:3000'].clientName.length, 64)
  assert.equal(byOrigin['http://[::1]:3000'].clientName, 'OmniChat')
  assert.equal(p.createdAt, new Date(p.createdAt).toISOString())
  assert.equal(p.expiresAt, Date.parse(p.createdAt) + 60000)
  assert.equal(p.expiresInSec, 60)
  assert.ok(!JSON.stringify(list).includes(env.code), 'no token in the pending list')

  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const remote = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: { name: 'r' }, link: undefined, pluginVersion: '1' }))
  assert.deepEqual((await remote.getState()).pending, [])
})

// ---------------------------------------------------------------------------- forOrigin (Tauri shell asks for the server page's origin)

/** Like pairRequest, but the hello names the origin the approval is for. */
async function pairRequestFor(env, connOrigin, forOrigin) {
  const c = client(env.port, { origin: connOrigin })
  await c.open
  c.ws.send(JSON.stringify({ type: 'hello', client: 'omnichat-app', version: 'app', pairRequest: true, forOrigin, clientName: 'OmniChat Desktop' }))
  return c
}

test('forOrigin: a Tauri shell can ask for the server page origin; approval allows exactly that origin', async () => {
  const env = await bootLocal()
  const c = await pairRequestFor(env, 'http://tauri.localhost', 'http://192.168.0.10:8787/some/path?x=1')
  const { requestId } = await pendingFrame(c)
  assert.deepEqual(env.link.status().pending.map((p) => p.origin), ['http://192.168.0.10:8787'])
  env.link.approve(requestId)
  await until(() => c.frames.some((f) => f.type === 'pair-approved'), 3000, 'pair-approved')
  assert.ok(env.link.status().allowedOrigins.includes('http://192.168.0.10:8787'))
  // the server page itself may now attach with the code
  const page = await attachRaw(env, { origin: 'http://192.168.0.10:8787' })
  assert.ok(await waitReady(page))
})

test('forOrigin: refused from a non-Tauri connection, and for non-http(s), credentialed or malformed values', async () => {
  const env = await bootLocal({ link: { maxPending: 10 } })
  const cases = [
    ['http://localhost:3000', 'http://192.168.0.10:8787'], // a loopback page may not name another origin
    ['https://evil.example', 'https://evil.example'],
    ['http://tauri.localhost', 'file:///C:/x'],
    ['http://tauri.localhost', 'javascript:alert(1)'],
    ['http://tauri.localhost', 'http://user:pw@192.168.0.10:8787'],
    ['http://tauri.localhost', 'not a url'],
    ['http://tauri.localhost', 42],
  ]
  for (const [conn, forOrigin] of cases) {
    const c = await pairRequestFor(env, conn, forOrigin)
    assert.equal(await c.closed, 4403, `${conn} -> ${String(forOrigin)}`)
    assert.equal(c.frames.length, 0)
  }
  assert.equal(env.link.status().pending.length, 0)
  assert.equal(env.link.failures, 0)
})
