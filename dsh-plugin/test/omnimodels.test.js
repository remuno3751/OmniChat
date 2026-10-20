import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OmniModels, nameModels, KEY_REF, RECORD_FILE, PROVIDER_ID, NAME_PREFIX } from '../dist/omnimodels.js'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { RemoteError, OmniChatBridgeController, hostContribution, makeBridgeOps } from '../dist/remote.js'
import { makeCtx, makeServer, until } from './helpers.js'

// Keep any default-path cwd out of the repository (the bridge takes git checkpoints of its cwd).
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-omni-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

const SECRET = 'ocsk-TEST-SECRET-KEY'
const BASE = 'https://chat.example.com/v1'
const MODELS = [
  { id: 'lm-studio/qwen3-8b', name: 'qwen3-8b', providerName: 'LM Studio', contextWindow: 32768 },
  { id: 'ollama/llama', name: 'llama', providerName: 'Ollama' },
]
const REPLY_TYPE = { omni_models_request: 'omni_models', omni_key_request: 'omni_key', omni_key_revoke: 'omni_key_revoked' }

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-test-'))
  cleanup.push(async () => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Fake OmniChat side. `send` records every frame and answers asynchronously through omni.onFrame.
 * `mode`: 'ok' | 'silent' (never answers) | 'disconnected' (send returns false) | 'error' (ok:false) | 'malformed'.
 */
function fakeLink(opts = {}) {
  const sent = []
  let omni = null
  let keyNo = 0
  const link = {
    sent,
    mode: opts.mode ?? 'ok',
    models: opts.models ?? MODELS,
    bind(o) {
      omni = o
    },
    send(frame) {
      sent.push(frame)
      if (link.mode === 'disconnected') return false
      if (link.mode === 'silent') return true
      setImmediate(() => omni.onFrame(reply(frame)))
      return true
    },
    framesOf: (type) => sent.filter((f) => f.type === type),
  }
  function reply(f) {
    const base = { requestId: f.requestId }
    const type = REPLY_TYPE[f.type]
    if (link.mode === 'error') return { ...base, type, ok: false, error: 'rate limited' }
    if (link.mode === 'malformed') return { ...base, type: 'nonsense', ok: true }
    if (f.type === 'omni_models_request') return { ...base, type, ok: true, baseUrl: opts.baseUrl ?? BASE, models: link.models }
    if (f.type === 'omni_key_request') {
      keyNo++
      return { ...base, type, ok: true, keyId: `key-${keyNo}`, apiKey: `${SECRET}-${keyNo}` }
    }
    return { ...base, type, ok: true }
  }
  return link
}

function fakeSettings(opts = {}) {
  const calls = []
  return {
    calls,
    async update(ns, patch) {
      if (opts.fail) throw new Error('settings down')
      calls.push({ op: 'update', ns, patch: structuredClone(patch) })
    },
    async mutate(ns, ops) {
      if (opts.fail) throw new Error('settings down')
      calls.push({ op: 'mutate', ns, ops: structuredClone(ops) })
    },
  }
}

function fakeCredentials(opts = {}) {
  const store = new Map()
  return {
    store,
    async describe(ref) {
      return { configured: store.has(ref) }
    },
    async set(ref, value) {
      if (opts.fail) throw new Error('read-only source')
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

/** An OmniModels wired to a fake link and fake services. `services` replaces the default {settings, credentials}. */
function harness({ link = fakeLink(), settings = fakeSettings(), credentials = fakeCredentials(), services, timeoutMs = 300, linked, dshHome } = {}) {
  const home = dshHome ?? scratch()
  const logs = []
  const omni = new OmniModels({
    send: (f) => link.send(f),
    getServices: () => services ?? { settings, credentials },
    dshHome: home,
    log: (m) => logs.push(m),
    timeoutMs,
    ...(linked ? { linked } : {}),
  })
  link.bind(omni)
  return { omni, link, settings, credentials, home, logs, recordFile: path.join(home, RECORD_FILE) }
}

/** The rejection of a promise, or throws when it resolves. */
async function failure(p) {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

// ---------------------------------------------------------------------------- import

test('first import: mints a key into credentials, writes the provider and the record (no secret in the record)', async () => {
  const h = harness()
  const st = await h.omni.import({ ids: ['lm-studio/qwen3-8b'] })

  assert.equal(st.ok, true)
  assert.equal(st.providerId, PROVIDER_ID)
  assert.equal(st.baseUrl, BASE)
  assert.equal(st.linked, true)
  assert.deepEqual(st.imported, [{ id: 'lm-studio/qwen3-8b', name: '[OmniChat] qwen3-8b', providerName: 'LM Studio', stale: false }])
  assert.deepEqual(st.available.find((m) => m.id === 'lm-studio/qwen3-8b'), {
    id: 'lm-studio/qwen3-8b',
    name: 'qwen3-8b',
    providerName: 'LM Studio',
    contextWindow: 32768,
    imported: true,
  })
  assert.equal(st.available.find((m) => m.id === 'ollama/llama').imported, false)

  assert.equal(h.credentials.store.get(KEY_REF), `${SECRET}-1`)
  const update = h.settings.calls.at(-1)
  assert.equal(update.op, 'update')
  assert.equal(update.ns, 'llm-pi-ai')
  const provider = update.patch.providers.omnichat
  assert.equal(provider.displayName, 'OmniChat')
  assert.equal(provider.api, 'openai-completions')
  assert.equal(provider.baseURL, BASE)
  assert.equal(provider.apiKeyEnv, KEY_REF)
  assert.deepEqual(provider.models, [{ id: 'lm-studio/qwen3-8b', name: '[OmniChat] qwen3-8b', input: ['text'], contextWindow: 32768 }])
  assert.equal(JSON.stringify(update.patch).includes(SECRET), false)

  const text = fs.readFileSync(h.recordFile, 'utf8')
  assert.equal(text.includes(SECRET), false)
  const rec = JSON.parse(text)
  assert.equal(rec.version, 1)
  assert.equal(rec.keyId, 'key-1')
  assert.equal(rec.keyRef, KEY_REF)
  assert.equal(rec.baseUrl, BASE)
  assert.equal(rec.models[0].name, '[OmniChat] qwen3-8b')
  assert.deepEqual(fs.readdirSync(h.home), [RECORD_FILE]) // atomic write leaves no temp file behind

  assert.deepEqual(h.omni.secrets(), [`${SECRET}-1`])
  assert.equal(h.logs.join('\n').includes(SECRET), false)
})

test('additive second import: earlier imports stay, the whole list is sent, the key is reused', async () => {
  const h = harness()
  await h.omni.import({ ids: ['lm-studio/qwen3-8b'] })
  const st = await h.omni.import({ ids: ['ollama/llama'] })

  assert.deepEqual(st.imported.map((m) => m.id), ['lm-studio/qwen3-8b', 'ollama/llama'])
  const models = h.settings.calls.at(-1).patch.providers.omnichat.models
  assert.deepEqual(models.map((m) => [m.id, m.name]), [
    ['lm-studio/qwen3-8b', '[OmniChat] qwen3-8b'],
    ['ollama/llama', '[OmniChat] llama'],
  ])
  assert.equal(h.link.framesOf('omni_key_request').length, 1)
})

test('name collision: shared plain names get the provider name appended', async () => {
  const link = fakeLink({
    models: [
      { id: 'alpha/qwen', name: 'qwen', providerName: 'Alpha' },
      { id: 'beta/qwen', name: 'qwen', providerName: 'Beta' },
    ],
  })
  const h = harness({ link })
  const st = await h.omni.import({ ids: ['alpha/qwen', 'beta/qwen'] })
  assert.deepEqual(st.imported.map((m) => m.name), ['[OmniChat] qwen (Alpha)', '[OmniChat] qwen (Beta)'])
  const models = h.settings.calls.at(-1).patch.providers.omnichat.models
  assert.deepEqual(models.map((m) => m.name), ['[OmniChat] qwen (Alpha)', '[OmniChat] qwen (Beta)'])
})

test('nameModels: plain names unless two entries share one; prefix always present', () => {
  assert.deepEqual(nameModels([{ id: 'x', plain: 'q', providerName: 'P' }]).map((m) => m.name), [`${NAME_PREFIX}q`])
  assert.deepEqual(
    nameModels([
      { id: 'a', plain: 'q', providerName: 'P1' },
      { id: 'b', plain: 'q', providerName: 'P2' },
      { id: 'c', plain: 'r', providerName: 'P3' },
    ]).map((m) => m.name),
    [`${NAME_PREFIX}q (P1)`, `${NAME_PREFIX}q (P2)`, `${NAME_PREFIX}r`],
  )
})

test('a missing credential is minted again and the replaced key is revoked', async () => {
  const h = harness()
  await h.omni.import({ ids: ['lm-studio/qwen3-8b'] })
  h.credentials.store.delete(KEY_REF) // e.g. the user removed it in dsh
  await h.omni.import({ ids: ['ollama/llama'] })
  assert.equal(h.link.framesOf('omni_key_request').length, 2)
  assert.equal(h.credentials.store.get(KEY_REF), `${SECRET}-2`)
  await until(() => h.link.framesOf('omni_key_revoke').length === 1, 2000, 'revoke of the replaced key')
  assert.equal(h.link.framesOf('omni_key_revoke')[0].keyId, 'key-1')
  assert.equal(JSON.parse(fs.readFileSync(h.recordFile, 'utf8')).keyId, 'key-2')
})

test('import validates ids and baseUrl: omni-bad-args for unknown or malformed input', async () => {
  const h = harness()
  for (const args of [{}, { ids: [] }, { ids: 'lm-studio/qwen3-8b' }, { ids: ['nope/x'] }, { ids: ['lm-studio/qwen3-8b'], baseUrl: 'ftp://x' }, { ids: ['lm-studio/qwen3-8b'], baseUrl: 5 }]) {
    const e = await failure(h.omni.import(args))
    assert.ok(e instanceof RemoteError)
    assert.equal(e.code, 'omnichatbridge/omni-bad-args')
    assert.equal(e.isDSHRemoteError, true)
  }
  assert.equal(fs.existsSync(h.recordFile), false)
})

test('import: an explicit baseUrl wins and is normalised', async () => {
  const h = harness()
  const st = await h.omni.import({ ids: ['ollama/llama'], baseUrl: 'https://other.example.com/v1/' })
  assert.equal(st.baseUrl, 'https://other.example.com/v1')
  assert.equal(h.settings.calls.at(-1).patch.providers.omnichat.baseURL, 'https://other.example.com/v1')
})

// ---------------------------------------------------------------------------- state / sync / remove

test('state: available from the server, imported from the record, stale when the server no longer offers a model', async () => {
  const link = fakeLink()
  const h = harness({ link, linked: () => false })
  await h.omni.import({ ids: ['lm-studio/qwen3-8b'] })

  let st = await h.omni.state()
  assert.equal(st.ok, true)
  assert.equal(st.linked, false)
  assert.equal(st.imported[0].stale, false)

  link.models = [MODELS[1]]
  st = await h.omni.state()
  assert.deepEqual(st.available.map((m) => [m.id, m.imported]), [['ollama/llama', false]])
  assert.deepEqual(st.imported.map((m) => [m.id, m.stale]), [['lm-studio/qwen3-8b', true]])
})

test('state({refresh:false}) does not contact the server', async () => {
  const h = harness()
  await h.omni.import({ ids: ['ollama/llama'] })
  const before = h.link.sent.length
  const st = await h.omni.state({ refresh: false })
  assert.equal(h.link.sent.length, before)
  assert.equal(st.ok, true)
  assert.deepEqual(st.available, [])
  assert.deepEqual(st.imported.map((m) => m.id), ['ollama/llama'])
})

test('sync: diff counts for updated, removed and added models; addNew:false adds nothing', async () => {
  const link = fakeLink()
  const h = harness({ link })
  await h.omni.import({ ids: ['lm-studio/qwen3-8b', 'ollama/llama'] })

  link.models = [
    { ...MODELS[0], contextWindow: 8192 }, // updated context
    { id: 'new/model', name: 'fresh', providerName: 'New' }, // added
  ] // ollama/llama vanished
  const first = await h.omni.sync({ addNew: false })
  assert.deepEqual(first.diff, { added: 0, updated: 1, removed: 1 })
  assert.deepEqual(first.imported.map((m) => m.id), ['lm-studio/qwen3-8b'])

  const second = await h.omni.sync()
  assert.deepEqual(second.diff, { added: 1, updated: 0, removed: 0 })
  assert.deepEqual(second.imported.map((m) => m.id), ['lm-studio/qwen3-8b', 'new/model'])
  const models = h.settings.calls.at(-1).patch.providers.omnichat.models
  assert.deepEqual(models.map((m) => [m.id, m.contextWindow ?? null]), [
    ['lm-studio/qwen3-8b', 8192],
    ['new/model', null],
  ])
})

test('sync that leaves nothing behaves like remove all', async () => {
  const link = fakeLink()
  const h = harness({ link })
  await h.omni.import({ ids: ['ollama/llama'] })
  link.models = []
  const st = await h.omni.sync()
  assert.deepEqual(st.diff, { added: 0, updated: 0, removed: 1 })
  assert.deepEqual(st.imported, [])
  assert.deepEqual(h.settings.calls.at(-1), { op: 'mutate', ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'omnichat'] }] })
  assert.equal(fs.existsSync(h.recordFile), false)
})

test('remove ids: the provider is rewritten with the rest; the credential and the record stay', async () => {
  const h = harness()
  await h.omni.import({ ids: ['lm-studio/qwen3-8b', 'ollama/llama'] })
  const st = await h.omni.remove({ ids: ['ollama/llama'] })
  assert.deepEqual(st.imported.map((m) => m.id), ['lm-studio/qwen3-8b'])
  const call = h.settings.calls.at(-1)
  assert.equal(call.op, 'update')
  assert.deepEqual(call.patch.providers.omnichat.models.map((m) => m.id), ['lm-studio/qwen3-8b'])
  assert.equal(h.credentials.store.has(KEY_REF), true)
  assert.equal(h.link.framesOf('omni_key_revoke').length, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(h.recordFile, 'utf8')).models.map((m) => m.id), ['lm-studio/qwen3-8b'])
})

test('remove all: provider unset, credential removed, key revoked, record deleted; idempotent', async () => {
  const h = harness()
  await h.omni.import({ ids: ['lm-studio/qwen3-8b'] })
  const st = await h.omni.remove({ all: true })
  assert.equal(st.ok, true)
  assert.deepEqual(st.imported, [])
  assert.deepEqual(h.settings.calls.at(-1), { op: 'mutate', ns: 'llm-pi-ai', ops: [{ op: 'unset', path: ['providers', 'omnichat'] }] })
  assert.equal(h.credentials.store.has(KEY_REF), false)
  const revokes = h.link.framesOf('omni_key_revoke')
  assert.equal(revokes.length, 1)
  assert.equal(revokes[0].keyId, 'key-1')
  assert.equal(fs.existsSync(h.recordFile), false)

  const again = await h.omni.remove({ all: true })
  assert.equal(again.ok, true)
})

test('remove ids that are not imported: omni-bad-args; removing every imported id behaves like remove all', async () => {
  const h = harness()
  await h.omni.import({ ids: ['ollama/llama'] })
  const e = await failure(h.omni.remove({ ids: ['lm-studio/qwen3-8b'] }))
  assert.equal(e.code, 'omnichatbridge/omni-bad-args')
  assert.equal((await failure(h.omni.remove({}))).code, 'omnichatbridge/omni-bad-args')

  await h.omni.remove({ ids: ['ollama/llama'] })
  assert.equal(h.settings.calls.at(-1).op, 'mutate')
  assert.equal(fs.existsSync(h.recordFile), false)
})

// ---------------------------------------------------------------------------- failures

test('timeout: a silent server gives omni-timeout from state (ok:false) and from import (RemoteError)', async () => {
  const link = fakeLink({ mode: 'silent' })
  const h = harness({ link, timeoutMs: 40 })
  const st = await h.omni.state()
  assert.equal(st.ok, false)
  assert.equal(st.errorCode, 'omni-timeout')
  assert.deepEqual(st.available, [])
  assert.deepEqual(st.imported, [])
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-timeout')
  assert.equal(h.omni.pending.size, 0)
})

test('not connected: send() false gives omni-not-connected', async () => {
  const h = harness({ link: fakeLink({ mode: 'disconnected' }) })
  const st = await h.omni.state()
  assert.equal(st.ok, false)
  assert.equal(st.errorCode, 'omni-not-connected')
  assert.equal(st.linked, true) // the link flag is independent of the send result
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-not-connected')
  assert.equal(h.omni.pending.size, 0)
})

test('server refusal: ok:false gives omni-server-error with the server text', async () => {
  const h = harness({ link: fakeLink({ mode: 'error' }) })
  const st = await h.omni.state()
  assert.equal(st.errorCode, 'omni-server-error')
  assert.equal(st.error, 'rate limited')
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-server-error')
  assert.equal(e.message, 'rate limited')
})

test('malformed reply gives omni-bad-reply', async () => {
  const h = harness({ link: fakeLink({ mode: 'malformed' }) })
  const st = await h.omni.state()
  assert.equal(st.errorCode, 'omni-bad-reply')
  assert.equal((await failure(h.omni.import({ ids: ['ollama/llama'] }))).code, 'omnichatbridge/omni-bad-reply')
})

test('onFrame: replies for unknown request ids and junk are ignored', () => {
  const h = harness()
  assert.doesNotThrow(() => h.omni.onFrame({ type: 'omni_models', requestId: 'nobody', ok: true, models: [] }))
  assert.doesNotThrow(() => h.omni.onFrame(null))
  assert.doesNotThrow(() => h.omni.onFrame('text'))
  assert.equal(h.omni.pending.size, 0)
})

test('settings missing: omni-settings-unavailable carries a snippet without the key, and nothing is recorded', async () => {
  const h = harness({ services: { credentials: fakeCredentials() } })
  const e = await failure(h.omni.import({ ids: ['lm-studio/qwen3-8b'] }))
  assert.equal(e.code, 'omnichatbridge/omni-settings-unavailable')
  assert.equal(typeof e.details.snippet, 'string')
  assert.ok(e.details.snippet.includes('providers:'))
  assert.ok(e.details.snippet.includes('lm-studio/qwen3-8b'))
  assert.ok(e.details.snippet.includes('[OmniChat] qwen3-8b'))
  assert.ok(e.details.snippet.includes(KEY_REF))
  assert.equal(e.details.snippet.includes('ocsk-'), false)
  assert.equal(fs.existsSync(h.recordFile), false)
})

test('settings rejecting the write: omni-settings-unavailable as well', async () => {
  const h = harness({ settings: fakeSettings({ fail: true }) })
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-settings-unavailable')
  assert.ok(e.details.snippet.includes('ollama/llama'))
})

test('credentials missing: omni-credentials-unavailable and no key is requested', async () => {
  const h = harness({ services: { settings: fakeSettings() } })
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-credentials-unavailable')
  assert.equal(h.link.framesOf('omni_key_request').length, 0)
  assert.equal(h.settings.calls.length, 0)
})

test('credentials refusing the key: omni-credentials-unavailable, the minted key is revoked, the key is never echoed', async () => {
  const h = harness({ credentials: fakeCredentials({ fail: true }) })
  const e = await failure(h.omni.import({ ids: ['ollama/llama'] }))
  assert.equal(e.code, 'omnichatbridge/omni-credentials-unavailable')
  assert.equal(e.message.includes(SECRET), false)
  await until(() => h.link.framesOf('omni_key_revoke').length === 1, 2000, 'revoke of the refused key')
  assert.equal(h.settings.calls.length, 0)
  assert.equal(fs.existsSync(h.recordFile), false)
})

test('corrupt or odd record file is tolerated: empty imported list, and the next import rewrites it', async () => {
  const h = harness()
  fs.writeFileSync(h.recordFile, '{ this is not json', 'utf8')
  let st = await h.omni.state({ refresh: false })
  assert.equal(st.ok, true)
  assert.deepEqual(st.imported, [])
  assert.ok(h.logs.some((l) => /corrupt/.test(l)))

  fs.writeFileSync(h.recordFile, JSON.stringify({ models: 5, keyId: 42 }), 'utf8')
  st = await h.omni.state({ refresh: false })
  assert.deepEqual(st.imported, [])

  await h.omni.import({ ids: ['ollama/llama'] })
  assert.equal(JSON.parse(fs.readFileSync(h.recordFile, 'utf8')).models.length, 1)
})

// ---------------------------------------------------------------------------- remote contract

test('remote: the four methods are in the SRC descriptor and in hostContribution; parameters are one json "args"', () => {
  const desc = Object.getOwnPropertyDescriptor(OmniChatBridgeController.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods').value
  const names = desc.methods.map((m) => m.method)
  for (const m of ['omniModels', 'omniImport', 'omniSync', 'omniRemove']) assert.ok(names.includes(m), `${m} in descriptor`)

  const inv = hostContribution().invocations
  for (const m of ['omniModels', 'omniImport', 'omniSync', 'omniRemove']) {
    const i = inv.find((x) => x.method === m)
    assert.ok(i, `${m} in hostContribution`)
    assert.deepEqual(i.parameters, [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }])
    assert.deepEqual(i.result, { mode: 'src-json' })
    assert.match(OmniChatBridgeController.prototype[m].toString(), new RegExp(`^async ${m}\\(args\\)`))
  }
})

test('remote: omni methods without an OmniModels instance throw omni-not-connected; non-object args become {}', async () => {
  const dsh = makeCtx()
  cleanup.push(async () => dsh.dispose())
  const ctrl = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: { name: 'r' }, link: undefined, pluginVersion: '1.0.0' }))
  for (const fn of [() => ctrl.omniModels({}), () => ctrl.omniImport({ ids: ['a'] }), () => ctrl.omniSync(), () => ctrl.omniRemove({ all: true })]) {
    const e = await failure(fn())
    assert.equal(e.code, 'omnichatbridge/omni-not-connected')
    assert.equal(e.isDSHRemoteError, true)
  }

  const h = harness()
  const ctrl2 = new OmniChatBridgeController(dsh.ctx, makeBridgeOps({ config: { name: 'r' }, link: undefined, pluginVersion: '1.0.0', omni: h.omni }))
  const bad = await failure(ctrl2.omniImport('a string'))
  assert.equal(bad.code, 'omnichatbridge/omni-bad-args')
  const st = await ctrl2.omniModels(undefined)
  assert.equal(st.ok, true)
})

// ---------------------------------------------------------------------------- end to end through the bridge

async function answerNext(server, reqType, makeReply) {
  const before = server.framesOf(reqType).length
  await until(() => server.framesOf(reqType).length > before, 3000, reqType)
  server.send(makeReply(server.framesOf(reqType).at(-1)))
}

test('end to end: omni frames go out on the bridge socket, replies resolve, models carry providerName/imported, the key is scrubbed', async () => {
  const server = await makeServer()
  const dsh = makeCtx()
  const { config, errors } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'pc-omni', token: 'T-OMNI-TOKEN', mirror: false })
  assert.deepEqual(errors, [])
  const logs = []
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, (m) => logs.push(m)),
    config,
    log: (m) => logs.push(m),
    reconnectMinMs: 30,
    reconnectMaxMs: 120,
    textBatchMs: 5,
    modelsPollMs: 10000,
    dshVersion: 'test',
  })
  const settings = fakeSettings()
  const credentials = fakeCredentials()
  const home = scratch()
  const omni = new OmniModels({
    send: (f) => bridge.sendToServer(f),
    getServices: () => ({ settings, credentials }),
    dshHome: home,
    log: (m) => logs.push(m),
    timeoutMs: 2000,
    linked: () => bridge.ws?.readyState === 1,
  })
  bridge.omni = omni
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    dsh.dispose()
    await server.close()
  })
  await until(() => server.framesOf('ready').length === 1, 4000, 'ready')

  // a dsh catalog with an imported OmniChat group next to the local one
  dsh.ctx.sessionController.modelCatalog = async () => ({
    default: { provider: 'lmstudio', model: 'm-default' },
    routableProviders: ['lmstudio'],
    groups: [
      { id: 'lmstudio', name: 'LM Studio', models: [{ id: 'm-default', name: 'M Default' }] },
      { id: 'omnichat', name: 'OmniChat', models: [{ id: 'lm-studio/qwen3-8b', name: 'qwen3-8b' }] },
    ],
    failures: [],
  })
  for (const h of dsh.handlers.get('settings/document-updated') ?? []) h.fn()
  await until(() => server.framesOf('models').some((f) => f.models.some((m) => m.imported === true)), 4000, 'models frame with imported')
  const latest = server.framesOf('models').at(-1).models
  assert.deepEqual(latest.find((m) => m.imported), { provider: 'omnichat', id: 'lm-studio/qwen3-8b', name: 'qwen3-8b', providerName: 'OmniChat', imported: true })
  assert.deepEqual(latest.find((m) => m.provider === 'lmstudio'), { provider: 'lmstudio', id: 'm-default', name: 'M Default', providerName: 'LM Studio' })

  // a state request goes out on the socket; the pushed reply resolves it
  const pending = omni.state()
  await until(() => server.framesOf('omni_models_request').length === 1, 3000, 'omni_models_request')
  const req = server.framesOf('omni_models_request')[0]
  server.send({ type: 'omni_models', requestId: req.requestId, ok: true, baseUrl: BASE, models: MODELS })
  const listed = await pending
  assert.equal(listed.ok, true)
  assert.equal(listed.linked, true)
  assert.deepEqual(listed.available.map((m) => m.id), ['lm-studio/qwen3-8b', 'ollama/llama'])

  // a full import: the key arrives on the socket and must never reach the record or the logs
  const imported = omni.import({ ids: ['lm-studio/qwen3-8b'] })
  await answerNext(server, 'omni_models_request', (r) => ({ type: 'omni_models', requestId: r.requestId, ok: true, baseUrl: BASE, models: MODELS }))
  await answerNext(server, 'omni_key_request', (r) => ({ type: 'omni_key', requestId: r.requestId, ok: true, keyId: 'k-e2e', apiKey: 'ocsk-E2E-KEY-SECRET' }))
  const st = await imported
  assert.equal(st.ok, true)
  assert.equal(credentials.store.get(KEY_REF), 'ocsk-E2E-KEY-SECRET')
  assert.equal(fs.readFileSync(path.join(home, RECORD_FILE), 'utf8').includes('ocsk-E2E'), false)
  assert.equal(bridge.scrub('leak ocsk-E2E-KEY-SECRET end').includes('ocsk-E2E'), false)
  assert.equal(logs.join('\n').includes('ocsk-E2E'), false)
  assert.ok(server.framesOf('omni_key_request').length === 1)
})
