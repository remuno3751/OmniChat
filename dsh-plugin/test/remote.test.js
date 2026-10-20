import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { LocalLink } from '../dist/local.js'
import { validateConfig } from '../dist/config.js'
import { apply } from '../dist/index.js'
import { readPairing } from '../dist/pairing.js'
import {
  OmniChatBridgeController,
  hostContribution,
  makeBridgeOps,
  OMNICHAT_NAMESPACE,
  OMNICHAT_SERVICE_KEY,
} from '../dist/remote.js'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { CHECK_INTERVAL_MS, UpdateFailure } from '../dist/updater.js'
import { makeCtx, makeServer, until } from './helpers.js'

// Keep any default-path cwd out of the repository.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-remote-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-remote-'))
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A real LocalLink on an ephemeral loopback port, against a scratch pairing file. */
async function bootLink({ file, seed } = {}) {
  const pairingFile = file ?? path.join(scratchDir(), 'omnichat-bridge.json')
  if (seed) fs.writeFileSync(pairingFile, JSON.stringify(seed))
  const { config, errors } = validateConfig({ mode: 'local', pairingFile, name: 'pc-remote' })
  assert.deepEqual(errors, [])
  config.listenPort = 0
  const logs = []
  const link = new LocalLink({
    config,
    log: (m) => logs.push(m),
    rawLog: (m) => logs.push(m),
    pluginVersion: '9.9.9-test',
    authDelayMs: 50,
    helloTimeoutMs: 400,
    lockoutMs: 500,
    maxFailures: 5,
  })
  await link.start({})
  cleanup.push(async () => link.stop())
  return { link, config, file: pairingFile, logs }
}

function controllerFor(link, config, pluginVersion = '9.9.9-test') {
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const ops = makeBridgeOps({ config, link, pluginVersion })
  return new OmniChatBridgeController(dsh.ctx, ops)
}

const SEED_ORIGIN = 'https://chat.example.com'

test('getState: local mode reports the code from the pairing file and the listening address', async () => {
  const { link, config, file } = await bootLink()
  const ctrl = controllerFor(link, config)
  const state = await ctrl.getState()
  const onDisk = readPairing(file).pairing
  assert.equal(state.mode, 'local')
  assert.equal(state.active, true)
  assert.equal(state.code, onDisk)
  assert.equal(state.port, link.port)
  assert.equal(state.address, `ws://127.0.0.1:${link.port}/omnichat-bridge`)
  assert.equal(state.paired, false)
  assert.equal(state.pairedAt, null)
  assert.ok(state.allowedOrigins.includes('tauri://localhost'))
  assert.equal(state.clients, 0)
  assert.equal(state.locked, false)
  assert.equal(state.lockedUntilMs, 0)
  assert.equal(state.name, 'pc-remote')
  assert.equal(state.version, '9.9.9-test')
})

test('regenerate: changes the code, the old code is gone from disk, pairedAt and file allowedOrigins are cleared', async () => {
  const { link, config, file } = await bootLink({
    seed: {
      version: 1,
      pairing: 'x'.repeat(43),
      createdAt: '2026-01-01T00:00:00.000Z',
      pairedAt: '2026-01-02T00:00:00.000Z',
      allowedOrigins: [SEED_ORIGIN],
      listenPort: 0,
    },
  })
  const ctrl = controllerFor(link, config)
  const before = await ctrl.getState()
  assert.equal(before.code, 'x'.repeat(43))
  assert.equal(before.paired, true)
  assert.equal(before.pairedAt, '2026-01-02T00:00:00.000Z')
  assert.ok(before.allowedOrigins.includes(SEED_ORIGIN))

  const after = await ctrl.regenerate()
  const onDisk = readPairing(file)
  assert.notEqual(after.code, 'x'.repeat(43))
  assert.equal(after.code, onDisk.pairing)
  assert.equal(after.code, link.pairing)
  assert.equal(after.mode, 'local')
  assert.equal(after.paired, false)
  assert.equal(after.pairedAt, null)
  assert.equal(onDisk.pairedAt, undefined)
  assert.equal(after.allowedOrigins.includes(SEED_ORIGIN), false)
  assert.ok(after.allowedOrigins.includes('tauri://localhost'))
  assert.deepEqual(onDisk.allowedOrigins, [])
  assert.equal(JSON.stringify(readPairing(file)).includes('x'.repeat(43)), false)

  const again = await ctrl.getState()
  assert.equal(again.code, after.code)
})

test('regenerate: failures and an active lockout are reset', async () => {
  const { link, config } = await bootLink()
  const ctrl = controllerFor(link, config)
  link.failures = 3
  link.lockedUntil = Date.now() + 100000
  const locked = await ctrl.getState()
  assert.equal(locked.locked, true)
  assert.ok(locked.lockedUntilMs > Date.now())

  const after = await ctrl.regenerate()
  assert.equal(link.failures, 0)
  assert.equal(link.lockedUntil, 0)
  assert.equal(after.locked, false)
  assert.equal(after.lockedUntilMs, 0)
})

test('regenerate: an attached app is detached and closed with 4001', async () => {
  const { link, config } = await bootLink()
  const detached = []
  link.handlers = { onDetach: (vws) => detached.push(vws) }
  const ctrl = controllerFor(link, config)
  const code = (await ctrl.getState()).code

  const ws = new WebSocket(`ws://127.0.0.1:${link.port}/omnichat-bridge`)
  cleanup.push(async () => ws.terminate())
  ws.on('error', () => {})
  const closed = new Promise((resolve) => ws.once('close', (c) => resolve(c)))
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  ws.send(JSON.stringify({ type: 'hello', pairing: code }))
  await until(() => link.client !== null, 4000, 'authenticated client')
  assert.equal((await ctrl.getState()).clients, 1)

  const after = await ctrl.regenerate()
  assert.equal(after.clients, 0)
  assert.equal(detached.length, 1)
  assert.equal(await closed, 4001)
})

test('regenerate in remote mode throws RemoteError omnichatbridge/not-local; getState is the fixed remote shape', async () => {
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const ctrl = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: { name: 'remote-box' }, link: undefined, pluginVersion: '1.2.3' }))
  const state = await ctrl.getState()
  assert.deepEqual(state, {
    mode: 'remote',
    active: false,
    code: null,
    port: null,
    address: null,
    paired: false,
    pairedAt: null,
    allowedOrigins: [],
    clients: 0,
    locked: false,
    lockedUntilMs: 0,
    pending: [],
    name: 'remote-box',
    version: '1.2.3',
  })
  await assert.rejects(ctrl.approve('any'), (e) => e.code === 'omnichatbridge/not-local')
  await assert.rejects(ctrl.deny('any'), (e) => e.code === 'omnichatbridge/not-local')
  await assert.rejects(ctrl.regenerate(), (e) => {
    assert.equal(e.code, 'omnichatbridge/not-local')
    assert.equal(e.isDSHRemoteError, true)
    return true
  })
})

test('hostContribution lists exactly the pairing and model-import methods under omnichatbridge', () => {
  const c = hostContribution()
  assert.equal(c.package, 'omnichat-dsh-bridge')
  assert.equal(c.face, 'host')
  assert.deepEqual(c.invocations.map((i) => i.id), [
    'omnichat-dsh-bridge#omnichatbridge/getState',
    'omnichat-dsh-bridge#omnichatbridge/regenerate',
    'omnichat-dsh-bridge#omnichatbridge/approve',
    'omnichat-dsh-bridge#omnichatbridge/deny',
    'omnichat-dsh-bridge#omnichatbridge/omniModels',
    'omnichat-dsh-bridge#omnichatbridge/omniImport',
    'omnichat-dsh-bridge#omnichatbridge/omniSync',
    'omnichat-dsh-bridge#omnichatbridge/omniRemove',
    'omnichat-dsh-bridge#omnichatbridge/updateState',
    'omnichat-dsh-bridge#omnichatbridge/updateRun',
  ])
  const withArgs = ['approve', 'deny', 'omniModels', 'omniImport', 'omniSync', 'omniRemove', 'updateState', 'updateRun']
  for (const inv of c.invocations) {
    assert.equal(inv.namespace, OMNICHAT_NAMESPACE)
    assert.equal(inv.service, OMNICHAT_SERVICE_KEY)
    assert.deepEqual(inv.result, { mode: 'src-json' })
    if (withArgs.includes(inv.method)) assert.deepEqual(inv.parameters.map((p) => p.name), ['args'])
    else assert.deepEqual(inv.parameters, [])
  }
})

test('apply() registers the controller through ctx.typert; a throwing register never breaks startup', async () => {
  const probe = net.createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))

  const pairingFile = path.join(scratchDir(), 'omnichat-bridge.json')
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const registered = []
  dsh.ctx.typert = { register: (c) => registered.push(c) }
  const lines = []
  const orig = console.error
  console.error = (m) => lines.push(String(m))
  try {
    apply(dsh.ctx, { mode: 'local', listenPort: port, pairingFile, name: 'loc' })
  } finally {
    console.error = orig
  }
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].invocations.map((i) => i.method), ['getState', 'regenerate', 'approve', 'deny', 'omniModels', 'omniImport', 'omniSync', 'omniRemove', 'updateState', 'updateRun'])
  assert.ok(lines.some((l) => l.includes('plugin loaded (local mode')))
  dsh.dispose() // releases the port before the second instance binds it

  const broken = makeCtx()
  cleanup.push(async () => broken.dispose())
  broken.ctx.typert = { register: () => { throw new Error('boom') } }
  const lines2 = []
  console.error = (m) => lines2.push(String(m))
  try {
    apply(broken.ctx, { mode: 'local', listenPort: port, pairingFile: path.join(scratchDir(), 'omnichat-bridge.json'), name: 'loc' })
  } finally {
    console.error = orig
  }
  assert.ok(lines2.some((l) => l.includes('settings remote not registered: boom')))
  assert.ok(lines2.some((l) => l.includes('plugin loaded (local mode')))
})

// ---------------------------------------------------------------- plugin update methods (updater.js)

const UPDATER_PROTOCOL_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** A fake updater that records which operations were asked for. `fail` makes stage() throw that error. */
function fakeUpdater({ fail = null, state = { current: '0.5.0', latest: null, updateAvailable: false, error: null } } = {}) {
  const calls = []
  return {
    calls,
    state: () => ({ ...state }),
    check: async (opts) => { calls.push(['check', opts]); return { ...state } },
    stage: async () => {
      calls.push(['stage'])
      if (fail) throw fail
      return { ...state, staged: { version: '0.6.0', file: 'x.tgz', sha256: 'ab' }, command: 'dsh plugin --profile desktop add "x.tgz"' }
    },
  }
}

function updateController(updater) {
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const ops = makeBridgeOps({ config: { name: 'pc-update' }, link: undefined, pluginVersion: '0.5.0', updater })
  return new OmniChatBridgeController(dsh.ctx, ops)
}

test('updateState and updateRun are listed with one json parameter named args', () => {
  const c = hostContribution()
  for (const method of ['updateState', 'updateRun']) {
    const inv = c.invocations.find((i) => i.method === method)
    assert.ok(inv, `${method} is in hostContribution`)
    assert.deepEqual(inv.parameters.map((p) => p.name), ['args'])
    assert.equal(inv.parameters[0].source, 'json')
    assert.equal(inv.invocation.kind, 'direct')
  }
  const marked = Object.getOwnPropertyDescriptor(OmniChatBridgeController.prototype, UPDATER_PROTOCOL_KEY)?.value
  const methods = marked.methods.map((m) => m.method)
  assert.ok(methods.includes('updateState') && methods.includes('updateRun'), 'SRC prototype descriptor lists both')
})

test('updateState asks for a check at most every six hours (cached result otherwise)', async () => {
  const updater = fakeUpdater()
  const controller = updateController(updater)
  const s = await controller.updateState({})
  assert.equal(s.current, '0.5.0')
  assert.deepEqual(updater.calls, [['check', { maxAgeMs: CHECK_INTERVAL_MS }]])
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000)
})

test('updateRun runs check and stage when asked, and nothing when no flag is set', async () => {
  const updater = fakeUpdater()
  const controller = updateController(updater)
  const staged = await controller.updateRun({ check: true, stage: true })
  assert.deepEqual(updater.calls, [['check', undefined], ['stage']])
  assert.equal(staged.staged.version, '0.6.0')
  assert.match(staged.command, /dsh plugin --profile desktop add/)

  updater.calls.length = 0
  await controller.updateRun({})
  assert.deepEqual(updater.calls, [], 'no flags: no check, no stage')
})

test('checksum refusals keep their own codes; other update failures are update-failed', async () => {
  const mismatch = updateController(fakeUpdater({ fail: new UpdateFailure('checksum-mismatch', 'SHA-256 mismatch') }))
  await assert.rejects(mismatch.updateRun({ stage: true }), (e) => {
    assert.equal(e.code, 'omnichatbridge/checksum-mismatch')
    assert.equal(e.isDSHRemoteError, true)
    assert.equal(e.details.reason, 'checksum-mismatch')
    return true
  })
  const missing = updateController(fakeUpdater({ fail: new UpdateFailure('checksum-missing', 'no checksum') }))
  await assert.rejects(missing.updateRun({ stage: true }), (e) => e.code === 'omnichatbridge/checksum-missing')
  const network = updateController(fakeUpdater({ fail: new UpdateFailure('network', 'Could not reach api.github.com') }))
  await assert.rejects(network.updateRun({ stage: true }), (e) => {
    assert.equal(e.code, 'omnichatbridge/update-failed')
    assert.equal(e.details.reason, 'network')
    assert.equal(e.message, 'Could not reach api.github.com')
    return true
  })
})

test('without an updater the update methods fail with update-failed instead of throwing synchronously', async () => {
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const controller = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: { name: 'x' }, pluginVersion: '0.5.0' }))
  await assert.rejects(controller.updateState({}), (e) => e.code === 'omnichatbridge/update-failed')
  await assert.rejects(controller.updateRun({ check: true }), (e) => e.code === 'omnichatbridge/update-failed')
})

test('config accepts an optional updateToken and leaves it out when not given', () => {
  const withToken = validateConfig({ mode: 'local', pairingFile: '/x/p.json', updateToken: '  ghp_abc  ' }, {})
  assert.deepEqual(withToken.errors, [])
  assert.deepEqual(withToken.warnings, [], 'updateToken is a known key')
  assert.equal(withToken.config.updateToken, 'ghp_abc')
  const plain = validateConfig({ mode: 'local', pairingFile: '/x/p.json' }, {})
  assert.equal('updateToken' in plain.config, false)
  const remote = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', token: 't', updateToken: 'ghp_r' }, {})
  assert.equal(remote.config.updateToken, 'ghp_r')
})

test('the ready frame of the remote bridge carries pluginVersion', async () => {
  const server = await makeServer()
  const dsh = makeCtx()
  const { config, errors } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'pc-ready', token: 'SECRET-TOKEN-123' }, {})
  assert.deepEqual(errors, [])
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, () => {}),
    config,
    log: () => {},
    reconnectMinMs: 30,
    reconnectMaxMs: 120,
    modelsPollMs: 10000,
    dshVersion: '0.2.0-test',
    pluginVersion: '0.6.0',
  })
  bridge.start()
  try {
    await until(() => server.framesOf('ready').length === 1, 4000, 'ready')
    assert.equal(server.framesOf('ready')[0].pluginVersion, '0.6.0')
  } finally {
    bridge.stop()
    dsh.dispose()
    await server.close()
  }
})
