import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'dist', 'client', 'bundle.js'), 'utf8')

// Minimal stand-in for React: createElement returns a plain object, hooks return initial values.
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
}

// Stateful stand-in for the hooks used by BridgeSettings: enough to mount the component, run its
// effects, re-render on setState and let tests click through the element tree.
function makeHookReact() {
  let current = null // the instance whose component function is running right now
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const inst = current
      const i = inst.index++
      if (!inst.slots[i]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial }
        slot.set = (v) => {
          slot.value = typeof v === 'function' ? v(slot.value) : v
          inst.update()
        }
        inst.slots[i] = slot
      }
      const slot = inst.slots[i]
      return [slot.value, slot.set]
    },
    useRef(initial) {
      const inst = current
      const i = inst.index++
      if (!inst.slots[i]) inst.slots[i] = { current: initial }
      return inst.slots[i]
    },
    useEffect(fn, deps) {
      const inst = current
      const i = inst.index++
      if (!inst.slots[i]) inst.slots[i] = { ran: false, deps: undefined, cleanup: null }
      inst.effects.push({ slot: inst.slots[i], fn, deps })
    },
    useCallback: (f) => f,
    useMemo: (f) => f(),
  }

  // Mounts a hook component and returns a handle; `tree` always holds the latest render output.
  react.mount = function mount(component, props) {
    const inst = {
      slots: [],
      index: 0,
      effects: [],
      tree: null,
      unmounted: false,
      flushing: false,
      dirty: false,
      update() {
        if (inst.unmounted) return
        if (inst.flushing) { inst.dirty = true; return }
        render()
      },
    }

    function render() {
      const prev = current
      current = inst
      inst.index = 0
      inst.effects = []
      try {
        inst.tree = component(props)
      } finally {
        current = prev
      }
      commit()
    }

    function commit() {
      inst.flushing = true
      try {
        for (const e of inst.effects) {
          const slot = e.slot
          const changed = !slot.ran || e.deps === undefined ||
            e.deps.some((d, k) => d !== slot.deps[k])
          if (!changed) continue
          if (slot.cleanup) slot.cleanup()
          slot.ran = true
          slot.deps = e.deps
          const cleanup = e.fn()
          slot.cleanup = typeof cleanup === 'function' ? cleanup : null
        }
      } finally {
        inst.flushing = false
      }
      if (inst.dirty) { inst.dirty = false; render() }
    }

    render()
    return {
      get tree() { return inst.tree },
      unmount() {
        inst.unmounted = true
        for (const slot of inst.slots) if (slot && slot.cleanup) slot.cleanup()
      },
    }
  }
  return react
}

// Runs the bundle exactly as the loader would, capturing the single load() call. `winExtra` adds
// members to the `window` the bundle sees (e.g. a stubbed confirm).
function loadBundle(react = fakeReact, winExtra = {}) {
  const calls = []
  const win = { __ModuleLoader__: { load(def) { calls.push(def) } }, ...winExtra }
  new Function('window', source)(win)
  assert.equal(calls.length, 1, 'bundle must call load() exactly once')
  const def = calls[0]
  const requireFn = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }
  return { def, exportsObj: def.factory(requireFn) }
}

const EN_TEXT = loadBundle().exportsObj.__internals.EN

const STATE = {
  mode: 'local',
  active: true,
  code: 'ABCD-1234',
  port: 45678,
  address: '127.0.0.1:45678',
  paired: false,
  pairedAt: null,
  allowedOrigins: ['http://localhost:8787'],
  clients: 0,
  locked: false,
  lockedUntilMs: 0,
  name: 'test-host',
  version: '0.2.0',
}

const PENDING_STATE = {
  ...STATE,
  pending: [
    { id: 'req-1', origin: 'http://localhost:9000', clientName: 'Laptop <b>', createdAt: 0, expiresAt: 0, expiresInSec: 30 },
    { id: 'req-2', origin: 'http://localhost:9001', clientName: 'Tablet', createdAt: 0, expiresAt: 0, expiresInSec: 60 },
  ],
}

function fakeCtx({ withBridge = true, bridge: overrides = {} } = {}) {
  const state = { mounted: null, registered: null }
  const bridge = {
    getState: async () => STATE,
    regenerate: async () => ({ ...STATE, code: 'WXYZ-9999' }),
    approve: async () => STATE,
    deny: async () => STATE,
    ...overrides,
  }
  const ctx = {
    locale: {
      register() { return () => {} },
      // Returns the real English text so tests can find buttons by their label.
      bind() { return (k) => (Object.prototype.hasOwnProperty.call(EN_TEXT, k) ? EN_TEXT[k] : k) },
    },
    effect(fn) { fn() },
    remote: {
      $mount: async (contribution) => { state.mounted = contribution; return () => {} },
    },
    get(key) {
      if (key === 'remote.omnichatbridge') return withBridge ? bridge : undefined
      if (key === 'slots') {
        return {
          inject(slot, fn) { fn() },
          register(meta, page) { state.registered = { meta, page }; return () => {} },
        }
      }
      return undefined
    },
  }
  return { ctx, state }
}

// Loads the bundle with the hook renderer, applies it and mounts the settings page.
async function mountSettings(bridge) {
  const react = makeHookReact()
  const { exportsObj } = loadBundle(react)
  const { ctx, state } = fakeCtx({ bridge })
  await exportsObj.apply(ctx)
  const element = state.registered.page({})
  const handle = react.mount(element.type, element.props)
  await flush()
  return handle
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

// Depth-first list of every element in a render tree.
function allNodes(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => allNodes(n, out))
  } else if (node && typeof node === 'object') {
    out.push(node)
    allNodes(node.children, out)
  }
  return out
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

function findByClass(tree, cls) {
  return allNodes(tree).filter((n) => n.props && typeof n.props.className === 'string' &&
    n.props.className.split(' ').includes(cls))
}

function findButton(tree, label) {
  const hits = allNodes(tree).filter((n) => n.type === 'button' && textOf(n) === label)
  assert.equal(hits.length, 1, `expected exactly one "${label}" button`)
  return hits[0]
}

const realDocument = globalThis.document
before(() => {
  // injectStyles() only needs createElement / head.appendChild / getElementById.
  globalThis.document = {
    head: { appendChild() {} },
    getElementById() { return null },
    createElement(tag) { return { tagName: tag, setAttribute() {}, textContent: '' } },
  }
})
after(() => {
  if (realDocument === undefined) delete globalThis.document
  else globalThis.document = realDocument
})

test('bundle registers exactly one loader module with the expected id', () => {
  const { def } = loadBundle()
  assert.equal(def.id, '@omnichat/dsh-bridge')
  assert.equal(typeof def.factory, 'function')
})

test('factory exports name, inject and apply', () => {
  const { exportsObj } = loadBundle()
  assert.equal(exportsObj.name, '@omnichat/dsh-bridge')
  assert.deepEqual(exportsObj.inject, ['slots', 'remote', 'locale'])
  assert.equal(typeof exportsObj.apply, 'function')
})

const ARGS_METHODS = ['approve', 'deny', 'omniModels', 'omniImport', 'omniSync', 'omniRemove', 'updateState', 'updateRun']

test('apply mounts the ten omnichatbridge descriptors', async () => {
  const { exportsObj } = loadBundle()
  const { ctx, state } = fakeCtx()
  await exportsObj.apply(ctx)

  assert.ok(state.mounted, '$mount must be called')
  assert.equal(state.mounted.package, 'omnichat-dsh-bridge')
  const ids = state.mounted.descriptors.map((d) => d.id).sort()
  assert.deepEqual(ids, [
    'omnichat-dsh-bridge#omnichatbridge/approve',
    'omnichat-dsh-bridge#omnichatbridge/deny',
    'omnichat-dsh-bridge#omnichatbridge/getState',
    'omnichat-dsh-bridge#omnichatbridge/omniImport',
    'omnichat-dsh-bridge#omnichatbridge/omniModels',
    'omnichat-dsh-bridge#omnichatbridge/omniRemove',
    'omnichat-dsh-bridge#omnichatbridge/omniSync',
    'omnichat-dsh-bridge#omnichatbridge/regenerate',
    'omnichat-dsh-bridge#omnichatbridge/updateRun',
    'omnichat-dsh-bridge#omnichatbridge/updateState',
  ])
  for (const d of state.mounted.descriptors) {
    assert.equal(d.namespace, 'omnichatbridge')
    assert.equal(d.service, 'omniChatBridgeController')
    assert.equal(d.result.mode, 'strict')
    assert.equal(d.result.typeSymbol, 'omnichat-dsh-bridge#json')
    assert.equal(typeof d.result.create().parse, 'function')
    if (ARGS_METHODS.includes(d.method)) continue
    assert.deepEqual(d.parameters, [])
  }
})

test('approve and the omni methods take one json parameter named args', () => {
  const { exportsObj } = loadBundle()
  const { contribution } = exportsObj.__internals
  for (const method of ARGS_METHODS) {
    const d = contribution.descriptors.find((x) => x.method === method)
    assert.ok(d, `${method} descriptor must exist`)
    assert.equal(d.parameters.length, 1, `${method} takes one parameter`)
    assert.equal(d.parameters[0].name, 'args')
    assert.equal(d.parameters[0].wire, 'args')
    assert.equal(d.parameters[0].source, 'json')
    assert.equal(d.parameters[0].codec.mode, 'strict')
    assert.equal(typeof d.parameters[0].codec.create().parse, 'function')
  }
})

test('apply registers the plugins.item slot entry', async () => {
  const { exportsObj } = loadBundle()
  const { ctx, state } = fakeCtx()
  await exportsObj.apply(ctx)

  assert.ok(state.registered, 'slot entry must be registered')
  assert.equal(state.registered.meta.name, 'plugins.item')
  assert.equal(state.registered.meta.id, 'omnichat-bridge')
  assert.equal(state.registered.meta.order, 13)
  // The fake locale.bind echoes keys back, so the label is the bound key rather than the text.
  assert.equal(typeof state.registered.meta.label(), 'string')
  assert.equal(typeof state.registered.page, 'function')
})

test('summary view returns a string and the detail view returns an element', async () => {
  const { exportsObj } = loadBundle()
  const { ctx, state } = fakeCtx()
  await exportsObj.apply(ctx)
  const { page } = state.registered

  const summary = page({ view: 'summary' })
  assert.equal(typeof summary, 'string')
  assert.ok(summary.length > 0)

  const detail = page({})
  assert.equal(typeof detail, 'object')
  assert.equal(typeof detail.type, 'function')
})

test('apply still registers the page when the remote namespace is missing', async () => {
  const { exportsObj } = loadBundle()
  const { ctx, state } = fakeCtx({ withBridge: false })
  await exportsObj.apply(ctx)
  assert.ok(state.registered)
  assert.equal(typeof state.registered.page({}), 'object')
})

test('EN, JA and ZH dictionaries share an identical key set', () => {
  const { exportsObj } = loadBundle()
  const { EN, JA, ZH } = exportsObj.__internals
  const enKeys = Object.keys(EN).sort()
  assert.deepEqual(Object.keys(JA).sort(), enKeys)
  assert.deepEqual(Object.keys(ZH).sort(), enKeys)
  for (const key of enKeys) {
    assert.equal(typeof EN[key], 'string')
    assert.ok(EN[key].length > 0, `EN.${key} must not be empty`)
  }
})

test('approval banner strings exist in every language with their placeholders', () => {
  const { EN, JA, ZH } = loadBundle().exportsObj.__internals
  for (const [lang, dict] of [['EN', EN], ['JA', JA], ['ZH', ZH]]) {
    for (const key of ['pendingBanner', 'pendingMore', 'pendingExpires', 'allow', 'deny', 'errorApprove']) {
      assert.equal(typeof dict[key], 'string', `${lang}.${key} must exist`)
      assert.ok(dict[key].length > 0, `${lang}.${key} must not be empty`)
    }
    assert.ok(dict.pendingBanner.includes('{origin}'), `${lang}.pendingBanner needs {origin}`)
    assert.ok(dict.pendingBanner.includes('{name}'), `${lang}.pendingBanner needs {name}`)
    assert.ok(dict.pendingMore.includes('{count}'), `${lang}.pendingMore needs {count}`)
    assert.ok(dict.pendingExpires.includes('{seconds}'), `${lang}.pendingExpires needs {seconds}`)
  }
})

test('exported contribution matches the module-level descriptors', () => {
  const { exportsObj } = loadBundle()
  const { contribution } = exportsObj.__internals
  assert.equal(contribution.descriptors.length, 10)
  assert.deepEqual(
    contribution.descriptors.map((d) => d.method).sort(),
    ['approve', 'deny', 'getState', 'omniImport', 'omniModels', 'omniRemove', 'omniSync', 'regenerate', 'updateRun', 'updateState'],
  )
})

test('poll interval is 1.5 seconds', () => {
  const { POLL_MS } = loadBundle().exportsObj.__internals
  assert.equal(POLL_MS, 1500)
})

test('pendingView picks the first request, counts the rest and clamps the countdown', () => {
  const { pendingView } = loadBundle().exportsObj.__internals
  assert.equal(pendingView(STATE, 1000, 1000), null)
  assert.equal(pendingView({ ...STATE, pending: [] }, 1000, 1000), null)

  const view = pendingView(PENDING_STATE, 1000, 4000)
  assert.equal(view.request.id, 'req-1')
  assert.equal(view.more, 1)
  assert.equal(view.seconds, 27) // 30 s at receipt, 3 s elapsed

  assert.equal(pendingView(PENDING_STATE, 1000, 1000 + 40000).seconds, 0)
  assert.equal(pendingView(PENDING_STATE, 1000, 500).seconds, 30) // a clock behind receipt never adds time

  const noExpiry = { ...STATE, pending: [{ id: 'x', origin: 'o', clientName: 'c' }] }
  assert.equal(pendingView(noExpiry, 1000, 2000).seconds, null)
})

test('bundle source never logs the pairing code or uses JSX / imports', () => {
  assert.doesNotMatch(source, /console\.log\(/)
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /return\s*\(\s*</)
})

test('bundle source never uses dangerouslySetInnerHTML', () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/)
})

test('approval banner is absent without pending requests and present with them', async () => {
  const none = await mountSettings({ getState: async () => STATE })
  try {
    assert.equal(findByClass(none.tree, 'ocb-banner').length, 0)
  } finally {
    none.unmount()
  }

  const some = await mountSettings({ getState: async () => PENDING_STATE })
  try {
    const banners = findByClass(some.tree, 'ocb-banner')
    assert.equal(banners.length, 1)
    assert.equal(banners[0].props.role, 'alert')
    const text = textOf(banners[0])
    assert.ok(text.includes('OmniChat (http://localhost:9000) wants to connect'), text)
    assert.ok(text.includes('Laptop <b>'), 'clientName is shown as literal text')
    assert.ok(text.includes('+1 more request(s) waiting'), text)
    assert.ok(text.includes('Expires in 30 s'), text)
    assert.ok(!text.includes('Tablet'), 'only the first request is shown')
  } finally {
    some.unmount()
  }
})

test('banner sits right after the title, before the intro', async () => {
  const m = await mountSettings({ getState: async () => PENDING_STATE })
  try {
    const section = findByClass(m.tree, 'ocb-section')[0]
    const kids = section.children.flat(Infinity)
    const titleIndex = kids.findIndex((n) => n.type === 'h2')
    const bannerIndex = kids.findIndex((n) => n.props && n.props.className === 'ocb-banner')
    const introIndex = kids.findIndex((n) => n.props && n.props.className === 'ocb-muted' && n.props.key === 'intro')
    assert.equal(bannerIndex, titleIndex + 1)
    assert.ok(introIndex > bannerIndex)
  } finally {
    m.unmount()
  }
})

test('origin and client name are plain text, never HTML', async () => {
  const m = await mountSettings({ getState: async () => PENDING_STATE })
  try {
    assert.ok(allNodes(m.tree).every((n) => !n.props || !('dangerouslySetInnerHTML' in n.props)))
  } finally {
    m.unmount()
  }
})

test('Allow calls approve with the displayed request id and Deny calls deny', async () => {
  const calls = []
  const m = await mountSettings({
    getState: async () => PENDING_STATE,
    approve: async (a) => { calls.push(['approve', a.id]); return STATE },
    deny: async (a) => { calls.push(['deny', a.id]); return STATE },
  })
  try {
    findButton(m.tree, 'Allow').props.onClick()
    await flush()
    assert.deepEqual(calls, [['approve', 'req-1']])
    assert.equal(findByClass(m.tree, 'ocb-banner').length, 0, 'banner clears once the answer leaves no pending request')
  } finally {
    m.unmount()
  }

  const calls2 = []
  const m2 = await mountSettings({
    getState: async () => PENDING_STATE,
    approve: async (a) => { calls2.push(['approve', a.id]); return STATE },
    deny: async (a) => { calls2.push(['deny', a.id]); return STATE },
  })
  try {
    findButton(m2.tree, 'Deny').props.onClick()
    await flush()
    assert.deepEqual(calls2, [['deny', 'req-1']])
  } finally {
    m2.unmount()
  }
})

test('Allow and Deny are disabled while an answer is in flight', async () => {
  let release = null
  const m = await mountSettings({
    getState: async () => PENDING_STATE,
    approve: () => new Promise((resolve) => { release = () => resolve(STATE) }),
  })
  try {
    findButton(m.tree, 'Allow').props.onClick()
    await flush()
    assert.equal(findButton(m.tree, 'Allow').props.disabled, true)
    assert.equal(findButton(m.tree, 'Deny').props.disabled, true)
    release()
    await flush()
    assert.equal(findByClass(m.tree, 'ocb-banner').length, 0)
  } finally {
    m.unmount()
  }
})

test('Allow is disabled at zero seconds, Deny stays enabled', async () => {
  const expired = {
    ...STATE,
    pending: [{ id: 'req-9', origin: 'http://localhost:9000', clientName: 'Late', expiresInSec: 0 }],
  }
  const m = await mountSettings({ getState: async () => expired })
  try {
    assert.equal(findButton(m.tree, 'Allow').props.disabled, true)
    assert.equal(findButton(m.tree, 'Deny').props.disabled, false)
    assert.ok(textOf(findByClass(m.tree, 'ocb-banner')[0]).includes('Expires in 0 s'))
  } finally {
    m.unmount()
  }
})

test('a failed answer shows the error inside the banner and re-polls', async () => {
  let getStateCalls = 0
  const m = await mountSettings({
    getState: async () => { getStateCalls += 1; return PENDING_STATE },
    approve: async () => { throw new Error('boom') },
  })
  try {
    const before = getStateCalls
    findButton(m.tree, 'Allow').props.onClick()
    await flush()
    const banner = findByClass(m.tree, 'ocb-banner')[0]
    assert.ok(textOf(banner).includes('Failed to answer the request: boom'), textOf(banner))
    assert.equal(findButton(m.tree, 'Allow').props.disabled, false)
    assert.ok(getStateCalls > before, 'a failed answer triggers an immediate poll')
  } finally {
    m.unmount()
  }
})

// ---------- Models from OmniChat (settings section, PROTOCOL-v7-dshmodels.md section 2.4) ----------

const OMNI_STATE = {
  ok: true,
  linked: true,
  providerId: 'omnichat',
  baseUrl: 'https://omni.example/v1',
  syncedAt: 1,
  available: [
    { id: 'lm-studio/qwen3-8b', name: 'qwen3-8b', providerName: 'LM Studio', imported: true },
    { id: 'ollama/llama3', name: 'llama3', providerName: 'Ollama', imported: false },
  ],
  imported: [
    { id: 'lm-studio/qwen3-8b', name: '[OmniChat] qwen3-8b', providerName: 'LM Studio', stale: false },
    { id: 'old/gone', name: '[OmniChat] gone', providerName: 'Old', stale: true },
  ],
}

// Mounts only the OmniModels section (built from the same factory) with a fake bridge.
function mountOmni(bridge, winExtra = {}) {
  const react = makeHookReact()
  const { exportsObj } = loadBundle(react, winExtra)
  const t = (k) => (Object.prototype.hasOwnProperty.call(EN_TEXT, k) ? EN_TEXT[k] : k)
  const { OmniModels } = exportsObj.__internals.createComponents(null, t)
  return react.mount(OmniModels, { bridge })
}

function checkboxes(tree) {
  return allNodes(tree).filter((n) => n.type === 'input' && n.props && n.props.type === 'checkbox')
}

function badgeCount(tree, text) {
  return allNodes(tree).filter((n) => n.props && n.props.className === 'ocb-badge' && textOf(n) === text).length
}

test('the settings page renders the Models from OmniChat section', async () => {
  const m = await mountSettings({ getState: async () => STATE, omniModels: async () => OMNI_STATE })
  try {
    const hits = allNodes(m.tree).filter((n) => n.props && n.props.key === 'omni-models')
    assert.equal(hits.length, 1)
    assert.equal(typeof hits[0].type, 'function')
    assert.equal(typeof hits[0].props.bridge.omniModels, 'function')
  } finally {
    m.unmount()
  }
})

test('the section calls omniModels on mount and lists rows with badges and the endpoint', async () => {
  const calls = []
  const m = mountOmni({
    omniModels: async (args) => { calls.push(args); return OMNI_STATE },
  })
  await flush()
  try {
    assert.deepEqual(calls, [{}])
    const tree = m.tree
    assert.equal(findByClass(tree, 'ocb-model').length, 3, 'two available rows and one removed row')
    assert.equal(checkboxes(tree).length, 2, 'only available rows get a checkbox')
    assert.equal(badgeCount(tree, 'Imported'), 1)
    assert.equal(badgeCount(tree, 'Removed on server'), 1)
    const text = textOf(tree)
    assert.ok(text.includes('https://omni.example/v1'), 'endpoint is shown')
    assert.ok(text.includes('LM Studio') && text.includes('Ollama'), 'provider names are shown')
    assert.ok(!text.includes(EN_TEXT.omniLoading), 'loading line is gone after the load')
  } finally {
    m.unmount()
  }
})

test('Select all new then Import selected calls omniImport with the new ids only', async () => {
  const calls = []
  const m = mountOmni({
    omniModels: async () => OMNI_STATE,
    omniImport: async (args) => { calls.push(args); return { ...OMNI_STATE, imported: [] } },
  })
  await flush()
  try {
    assert.equal(findButton(m.tree, 'Import selected').props.disabled, true, 'nothing checked yet')
    findButton(m.tree, 'Select all new').props.onClick()
    assert.equal(checkboxes(m.tree)[0].props.checked, false)
    assert.equal(checkboxes(m.tree)[1].props.checked, true)
    findButton(m.tree, 'Import selected').props.onClick()
    await flush()
    assert.deepEqual(calls, [{ ids: ['ollama/llama3'] }], 'no baseUrl key when the override is empty')
    assert.ok(textOf(m.tree).includes('Imported 1 model(s). They appear under the provider "OmniChat"'))
    assert.equal(findButton(m.tree, 'Import selected').props.disabled, true, 'selection is cleared')
  } finally {
    m.unmount()
  }
})

test('a single checkbox toggles one id and a non-empty server URL override is sent as baseUrl', async () => {
  const calls = []
  const m = mountOmni({
    omniModels: async () => OMNI_STATE,
    omniImport: async (args) => { calls.push(args); return OMNI_STATE },
  })
  await flush()
  try {
    checkboxes(m.tree)[0].props.onChange()
    const input = findByClass(m.tree, 'ocb-input')[0]
    assert.equal(input.props.placeholder, 'https://omni.example/v1')
    input.props.onChange({ target: { value: '  https://other.example/v1  ' } })
    findButton(m.tree, 'Import selected').props.onClick()
    await flush()
    assert.deepEqual(calls, [{ ids: ['lm-studio/qwen3-8b'], baseUrl: 'https://other.example/v1' }])
  } finally {
    m.unmount()
  }
})

test('Sync reports the diff counts and Remove all calls omniRemove only after confirm', async () => {
  const syncCalls = []
  const removeCalls = []
  const asked = []
  let answer = false
  const m = mountOmni({
    omniModels: async () => OMNI_STATE,
    omniSync: async (args) => {
      syncCalls.push(args)
      return { ...OMNI_STATE, diff: { added: ['x'], updated: [], removed: ['a', 'b'] } }
    },
    omniRemove: async (args) => { removeCalls.push(args); return { ...OMNI_STATE, imported: [] } },
  }, { confirm: (msg) => { asked.push(msg); return answer } })
  await flush()
  try {
    findButton(m.tree, 'Sync').props.onClick()
    await flush()
    assert.deepEqual(syncCalls, [{ addNew: true }])
    assert.ok(textOf(m.tree).includes('Added 1, updated 0, removed 2'))

    findButton(m.tree, 'Remove all imported models').props.onClick()
    await flush()
    assert.equal(removeCalls.length, 0, 'a declined confirm removes nothing')

    answer = true
    findButton(m.tree, 'Remove all imported models').props.onClick()
    await flush()
    assert.deepEqual(removeCalls, [{ all: true }])
    assert.equal(asked.length, 2)
    assert.ok(textOf(m.tree).includes('Removed all models imported from OmniChat.'))
  } finally {
    m.unmount()
  }
})

test('Remove all imported models is hidden when nothing is imported', async () => {
  const m = mountOmni({ omniModels: async () => ({ ...OMNI_STATE, imported: [] }) })
  await flush()
  try {
    const hits = allNodes(m.tree).filter((n) => n.type === 'button' && textOf(n) === 'Remove all imported models')
    assert.equal(hits.length, 0)
    assert.equal(findButton(m.tree, 'Import selected').props.disabled, true)
  } finally {
    m.unmount()
  }
})

test('a settings-unavailable failure shows the message and the snippet with a Copy button', async () => {
  const snippet = 'providers:\n  omnichat:\n    baseURL: https://omni.example/v1'
  const m = mountOmni({
    omniModels: async () => OMNI_STATE,
    omniImport: async () => ({
      ok: false,
      error: {
        message: 'dsh settings are not available',
        code: 'omnichatbridge/omni-settings-unavailable',
        details: { snippet },
      },
    }),
  })
  await flush()
  try {
    checkboxes(m.tree)[1].props.onChange()
    findButton(m.tree, 'Import selected').props.onClick()
    await flush()
    const text = textOf(m.tree)
    assert.ok(text.includes('dsh settings are not available'))
    assert.ok(text.includes(EN_TEXT.omniSnippetHelp))
    const pres = allNodes(m.tree).filter((n) => n.type === 'pre')
    assert.equal(pres.length, 1)
    assert.equal(textOf(pres[0]), snippet)
    findButton(m.tree, 'Copy')
  } finally {
    m.unmount()
  }
})

test('the snippet is shown only for settings-unavailable failures', async () => {
  const m = mountOmni({
    omniModels: async () => OMNI_STATE,
    omniSync: async () => {
      const e = new Error('boom')
      e.code = 'omnichatbridge/omni-server-error'
      e.details = { snippet: 'must not show' }
      throw e
    },
  })
  await flush()
  try {
    findButton(m.tree, 'Sync').props.onClick()
    await flush()
    assert.ok(textOf(m.tree).includes('boom'))
    assert.equal(allNodes(m.tree).filter((n) => n.type === 'pre').length, 0)
  } finally {
    m.unmount()
  }
})

test('an offline bridge shows the hint, keeps recorded imports and Refresh retries', async () => {
  let calls = 0
  const offline = {
    ok: false,
    errorCode: 'omni-not-connected',
    error: 'bridge is not linked',
    linked: false,
    providerId: 'omnichat',
    baseUrl: null,
    available: [],
    imported: [{ id: 'lm-studio/qwen3-8b', name: '[OmniChat] qwen3-8b', providerName: 'LM Studio', stale: false }],
    syncedAt: null,
  }
  const m = mountOmni({ omniModels: async () => { calls += 1; return offline } })
  await flush()
  try {
    assert.ok(textOf(m.tree).includes('Open OmniChat and connect it to this bridge, then press Refresh.'))
    assert.equal(checkboxes(m.tree).length, 0)
    assert.equal(badgeCount(m.tree, 'Imported'), 1, 'recorded import still listed')
    assert.equal(badgeCount(m.tree, 'Removed on server'), 0, 'no removal claim while the server is unreachable')
    findButton(m.tree, 'Refresh').props.onClick()
    await flush()
    assert.equal(calls, 2)
  } finally {
    m.unmount()
  }
})

test('omni strings keep their placeholders in every language', () => {
  const { EN, JA, ZH } = loadBundle().exportsObj.__internals
  const marks = {
    omniImportedOk: ['{count}'],
    omniSyncOk: ['{added}', '{updated}', '{removed}'],
  }
  for (const dict of [EN, JA, ZH]) {
    for (const [key, list] of Object.entries(marks)) {
      for (const mark of list) assert.ok(dict[key].includes(mark), `${key} needs ${mark}`)
    }
  }
})

// ---------------------------------------------------------------- plugin update block

const UP_LATEST = {
  current: '0.5.0',
  latest: { version: '0.6.0', name: 'omnichat-dsh-bridge-0.6.0.tgz', size: 10, tag: 'v0.6.0', publishedAt: null },
  updateAvailable: true,
  checkedAt: 1,
  error: null,
  staged: null,
  command: null,
  profile: 'desktop',
}

// Mounts only the plugin update block (built from the same factory) with a fake bridge.
function mountUpdate(bridge) {
  const react = makeHookReact()
  const { exportsObj } = loadBundle(react)
  const t = (k) => (Object.prototype.hasOwnProperty.call(EN_TEXT, k) ? EN_TEXT[k] : k)
  const { UpdateSettings } = exportsObj.__internals.createComponents(bridge, t)
  return react.mount(UpdateSettings, { bridge })
}

function preBlocks(tree) {
  return allNodes(tree).filter((n) => n.type === 'pre' && n.props && n.props.className === 'ocb-pre')
}

test('the update block shows both versions, the status and the two buttons', async () => {
  const m = mountUpdate({ updateState: async () => UP_LATEST, updateRun: async () => UP_LATEST })
  await flush()
  try {
    const text = textOf(m.tree)
    assert.ok(text.includes('0.5.0') && text.includes('0.6.0'), 'current and latest versions are shown')
    assert.ok(text.includes(EN_TEXT.updateAvailable), 'status says an update is available')
    assert.equal(findButton(m.tree, EN_TEXT.updateCheck).props.disabled, false)
    assert.equal(findButton(m.tree, EN_TEXT.updateInstall).props.disabled, false)
    assert.equal(preBlocks(m.tree).length, 0, 'no command before staging')
  } finally {
    m.unmount()
  }
})

test('Update is disabled when the installed version is current', async () => {
  const current = { ...UP_LATEST, updateAvailable: false, latest: { ...UP_LATEST.latest, version: '0.5.0' } }
  const m = mountUpdate({ updateState: async () => current })
  await flush()
  try {
    assert.equal(findButton(m.tree, EN_TEXT.updateInstall).props.disabled, true)
    assert.ok(textOf(m.tree).includes(EN_TEXT.updateUpToDate))
  } finally {
    m.unmount()
  }
})

test('Check for updates calls updateRun with {check:true}', async () => {
  const calls = []
  const m = mountUpdate({
    updateState: async () => UP_LATEST,
    updateRun: async (args) => { calls.push(args); return UP_LATEST },
  })
  await flush()
  try {
    findButton(m.tree, EN_TEXT.updateCheck).props.onClick()
    await flush()
    assert.deepEqual(calls, [{ check: true }])
  } finally {
    m.unmount()
  }
})

test('Update calls updateRun with {stage:true}; the command then shows read-only with the close-first sentence', async () => {
  const command = 'dsh plugin --profile desktop remove @omnichat/dsh-bridge; dsh plugin --profile desktop add "C:\\x\\omnichat-dsh-bridge-0.6.0.tgz"'
  const calls = []
  const staged = { ...UP_LATEST, command, staged: { version: '0.6.0', file: 'C:\\x\\omnichat-dsh-bridge-0.6.0.tgz', sha256: 'ab' } }
  const m = mountUpdate({
    updateState: async () => UP_LATEST,
    updateRun: async (args) => { calls.push(args); return staged },
  })
  await flush()
  try {
    findButton(m.tree, EN_TEXT.updateInstall).props.onClick()
    await flush()
    assert.deepEqual(calls, [{ stage: true }])
    const blocks = preBlocks(m.tree)
    assert.equal(blocks.length, 1)
    assert.equal(textOf(blocks[0]), command)
    assert.ok(textOf(m.tree).includes(EN_TEXT.updateCloseFirst), 'the close-DSH sentence is shown')
    assert.equal(findButton(m.tree, EN_TEXT.updateCopyCommand).props.disabled, undefined)
  } finally {
    m.unmount()
  }
})

test('a failed check shows the reason in the status line', async () => {
  const failed = { ...UP_LATEST, latest: null, updateAvailable: false, error: { code: 'rate-limited', message: 'GitHub API rate limit reached.' } }
  const m = mountUpdate({ updateState: async () => failed })
  await flush()
  try {
    const text = textOf(m.tree)
    assert.ok(text.includes(EN_TEXT.updateFailed + ': GitHub API rate limit reached.'), text)
  } finally {
    m.unmount()
  }
})

test('a rejected action shows its message in an alert line', async () => {
  const m = mountUpdate({
    updateState: async () => UP_LATEST,
    updateRun: async () => { throw new Error('Downloaded package does not match its checksum') },
  })
  await flush()
  try {
    findButton(m.tree, EN_TEXT.updateInstall).props.onClick()
    await flush()
    const alerts = findByClass(m.tree, 'ocb-error').filter((n) => n.props.role === 'alert')
    assert.equal(alerts.length, 1)
    assert.equal(textOf(alerts[0]), 'Downloaded package does not match its checksum')
  } finally {
    m.unmount()
  }
})

test('the update block sits in the settings page above the Models from OmniChat section', async () => {
  const m = await mountSettings({
    getState: async () => STATE,
    updateState: async () => UP_LATEST,
    omniModels: async () => OMNI_STATE,
  })
  try {
    const keys = allNodes(m.tree).map((n) => n.props && n.props.key).filter((k) => typeof k === 'string')
    assert.ok(keys.includes('plugin-update'), 'plugin-update block is rendered')
    assert.ok(keys.indexOf('plugin-update') < keys.indexOf('omni-models'))
  } finally {
    m.unmount()
  }
})

test('the update descriptors take one json parameter named args', () => {
  const { contribution } = loadBundle().exportsObj.__internals
  for (const method of ['updateState', 'updateRun']) {
    const d = contribution.descriptors.find((x) => x.method === method)
    assert.ok(d, `${method} descriptor exists`)
    assert.equal(d.id, `omnichat-dsh-bridge#omnichatbridge/${method}`)
    assert.equal(d.parameters.length, 1)
    assert.equal(d.parameters[0].name, 'args')
    assert.equal(d.parameters[0].wire, 'args')
  }
})

test('the update strings exist in every language and keep their placeholders', () => {
  const { EN, JA, ZH } = loadBundle().exportsObj.__internals
  const keys = Object.keys(EN).filter((k) => k.startsWith('update'))
  assert.ok(keys.length >= 15)
  for (const dict of [EN, JA, ZH]) {
    for (const key of keys) {
      assert.equal(typeof dict[key], 'string', `${key} exists`)
      assert.ok(dict[key].length > 0, `${key} is not empty`)
    }
    assert.ok(dict.updateStagedVersion.includes('{version}'))
  }
  assert.deepEqual(Object.keys(JA).filter((k) => k.startsWith('update')).sort(), keys.slice().sort())
  assert.deepEqual(Object.keys(ZH).filter((k) => k.startsWith('update')).sort(), keys.slice().sort())
})
