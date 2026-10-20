import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { makeCtx, makeServer, until } from './helpers.js'

// Runs without a configured cwd fall back to process.cwd(); keep that out of the real repository.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-plugin-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-fs-bridge-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>hi</p>')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'a.css'), 'p{}')
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1')
  return dir
}

async function boot({ previewFs, cwd }) {
  const server = await makeServer()
  const dsh = makeCtx({})
  const logs = []
  const raw = { mode: 'remote', serverUrl: server.url, name: 'pc-fs', token: 'TOKEN-FS-SECRET', cwd }
  if (previewFs !== undefined) raw.previewFs = previewFs
  const { config, errors } = validateConfig(raw)
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
  })
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    await server.close()
  })
  await until(() => server.framesOf('ready').length > 0, 8000, 'ready')
  return { server, bridge, logs }
}

const fsReq = (server, requestId, cwd, op, p, extra = {}) =>
  server.send({ type: 'fs', requestId, cwd, op, ...(p === undefined ? {} : { path: p }), ...extra })

const result = (server, requestId) => {
  const f = server.framesOf('fs_result').find((x) => x.requestId === requestId)
  return f
}
const waitResult = async (server, requestId) => {
  await until(() => !!result(server, requestId), 4000, `fs_result ${requestId}`)
  return result(server, requestId)
}

test('fs preview off (default): ready has no fs capability, and fs is refused', async () => {
  const cwd = workspace()
  const { server } = await boot({ cwd })
  const ready = server.framesOf('ready')[0]
  assert.equal('fs' in ready.capabilities, false, 'only the workspaces capability')
  fsReq(server, 'f1', cwd, 'list', '')
  const r = await waitResult(server, 'f1')
  assert.deepEqual(r, { type: 'fs_result', requestId: 'f1', ok: false, error: 'preview is disabled on this bridge' })
})

test('fs preview on: ready advertises fs; list and read work; the rules hold', async () => {
  const cwd = workspace()
  const { server } = await boot({ previewFs: true, cwd })
  assert.deepEqual(server.framesOf('ready')[0].capabilities, { fs: true, workspaces: true })

  fsReq(server, 'l1', cwd, 'list', '')
  const l = await waitResult(server, 'l1')
  assert.equal(l.ok, true)
  assert.deepEqual(l.entries.map((e) => e.name), ['sub', 'index.html'], 'hidden .env is not listed; dirs first')

  fsReq(server, 'r1', cwd, 'read', 'index.html')
  const r = await waitResult(server, 'r1')
  assert.equal(r.ok, true)
  assert.equal(Buffer.from(r.content, 'base64').toString('utf8'), '<p>hi</p>')
  assert.equal(r.mime, 'text/html')
  assert.equal(r.size, 9)
  assert.equal(r.truncated, false)

  fsReq(server, 'r2', cwd, 'read', '.env')
  assert.equal((await waitResult(server, 'r2')).ok, false)

  fsReq(server, 'r3', cwd, 'read', '../../etc/passwd')
  const up = await waitResult(server, 'r3')
  assert.equal(up.ok, false)
  assert.equal(String(up.error).includes(cwd), false, 'error text never contains the full path')

  fsReq(server, 'r4', cwd, 'read', 'sub')
  assert.deepEqual([(await waitResult(server, 'r4')).ok, (await waitResult(server, 'r4')).error], [false, 'not a file'])

  fsReq(server, 'r5', cwd, 'delete', 'index.html')
  assert.deepEqual([(await waitResult(server, 'r5')).ok, (await waitResult(server, 'r5')).error], [false, 'invalid op'])
})

test('fs preview on: a cwd that is not a known working directory is refused', async () => {
  const cwd = workspace()
  const { server } = await boot({ previewFs: true, cwd })
  fsReq(server, 'w1', path.join(os.tmpdir(), 'omni-fs-elsewhere-' + Date.now()), 'list', '')
  const r = await waitResult(server, 'w1')
  assert.deepEqual([r.ok, r.error], [false, 'cwd is not a known working directory'])
})

test('fs preview on: more than 20 requests in a second are refused as too many requests', async () => {
  const cwd = workspace()
  const { server } = await boot({ previewFs: true, cwd })
  for (let i = 0; i < 25; i++) fsReq(server, `burst-${i}`, cwd, 'list', '')
  await until(() => server.framesOf('fs_result').filter((f) => String(f.requestId).startsWith('burst-')).length === 25, 4000, 'burst')
  const results = server.framesOf('fs_result').filter((f) => String(f.requestId).startsWith('burst-'))
  const refused = results.filter((f) => f.error === 'too many requests')
  assert.ok(refused.length >= 5, `refused ${refused.length}`)
  assert.ok(results.filter((f) => f.ok).length <= 20)
})

test('fs preview on: fs answers while a run is in progress (read only)', async () => {
  const cwd = workspace()
  const { server, bridge } = await boot({ previewFs: true, cwd })
  // A run in progress is simulated by an entry in the run map (the run helpers of v4.test.js are not shared).
  bridge.runs.set('fs-busy', {})
  try {
    fsReq(server, 'busy-1', cwd, 'read', 'index.html')
    const r = await waitResult(server, 'busy-1')
    assert.equal(r.ok, true, JSON.stringify(r))
  } finally {
    bridge.runs.delete('fs-busy')
  }
})

test('config: previewFs is off by default, on with the key or the env var, and bad values are errors', () => {
  const base = { mode: 'remote', serverUrl: 'http://127.0.0.1:1', token: 'T', name: 'n', cwd: '/tmp/x' }
  const off = validateConfig(base, {})
  assert.deepEqual(off.errors, [])
  assert.equal('previewFs' in off.config, false, 'default config keeps its documented key set')
  assert.equal(validateConfig({ ...base, previewFs: true }, {}).config.previewFs, true)
  assert.equal(validateConfig({ ...base, previewFs: 'yes' }, {}).config.previewFs, true)
  assert.equal(validateConfig(base, { OMNICHAT_BRIDGE_PREVIEW_FS: '1' }).config.previewFs, true)
  assert.equal(validateConfig({ ...base, previewFs: false }, { OMNICHAT_BRIDGE_PREVIEW_FS: '1' }).config.previewFs, undefined, 'key wins over env')
  const bad = validateConfig({ ...base, previewFs: 'maybe' }, {})
  assert.deepEqual(bad.errors, ['previewFs must be true or false'])
  const local = validateConfig({ mode: 'local', previewFs: true }, {})
  assert.ok(local.warnings.some((w) => w.includes('previewFs')), 'ignored with a warning in local mode')
})
