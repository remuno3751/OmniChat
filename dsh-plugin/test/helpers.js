import { EventEmitter } from 'node:events'
import http from 'node:http'
import { WebSocketServer } from 'ws'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(f, ms = 4000, what = 'condition') {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`)
    await sleep(10)
  }
}

/** Fake dsh ctx: EventEmitter-like `on` (with dispose), `effect`, `get` and a stubbed sessionController. */
export function makeCtx(opts = {}) {
  const handlers = new Map()
  const calls = []
  const sessions = new Map() // id -> { id, header, events }
  const state = { default: { provider: 'lmstudio', model: 'm-default' }, running: new Set() }
  let nextId = 1
  const effects = []

  const catalog = () => ({
    default: { ...state.default },
    routableProviders: ['lmstudio'],
    groups: [
      { id: 'lmstudio', name: 'LM Studio', models: [{ id: 'm-default', name: 'M Default' }, { id: 'm-other', name: 'M Other' }] },
    ],
    failures: [],
  })

  const sc = {
    async list() {
      return {
        items: [...sessions.values()].map((s) => ({
          sessionId: s.id,
          updatedAt: s.events.at(-1)?.time ?? 0,
          running: state.running.has(s.id),
          blank: s.events.every((e) => e.type !== 'user/message'),
          cwd: s.header.cwd,
          origin: s.header.origin,
        })),
      }
    },
    async inspect(id) {
      const s = sessions.get(id)
      if (!s) throw new Error('not found')
      return { meta: s.header, inheritedEventCount: 0, events: [...s.events] }
    },
    async create(req) {
      calls.push(['create', req])
      const id = `session-${nextId++}`
      sessions.set(id, { id, header: { cwd: req.cwd ?? '/default', ...(opts.header ?? {}) }, events: [] })
      return { sessionId: id }
    },
    async prompt(req) {
      calls.push(['prompt', req])
      if (opts.promptError) throw new Error(opts.promptError)
      return { accepted: true }
    },
    async cancel(req) {
      calls.push(['cancel', req])
      if (opts.cancelError) throw new Error(opts.cancelError)
      return { accepted: true }
    },
    async modelCatalog() {
      return catalog()
    },
    async selectModel(req) {
      calls.push(['selectModel', req])
      // like dsh: the default model is overwritten as a side effect (asynchronously)
      state.default = { provider: req.provider, model: req.model }
      return { selected: { provider: req.provider, model: req.model } }
    },
  }
  const adm = {
    currentSelection: () => ({ ...state.default }),
    async saveSelection(sel) {
      calls.push(['saveSelection', sel])
      state.default = { ...sel }
    },
  }
  const services = { sessionController: sc, agentDefaultModel: adm, agents: { get: (id) => ({ status: state.running.has(id) ? 'running' : 'idle' }) }, sessions: { get: (id) => sessions.get(id) } }
  if (opts.noInspect) delete sc.inspect
  if (opts.noSelect) delete sc.selectModel

  const ctx = {
    sessionController: sc,
    logger: { info() {}, warn() {} },
    get: (name) => services[name],
    on(name, fn, options) {
      const list = handlers.get(name) ?? []
      const h = { fn, options }
      list.push(h)
      handlers.set(name, list)
      return () => {
        const l = handlers.get(name) ?? []
        l.splice(l.indexOf(h), 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }

  const api = {
    ctx,
    calls,
    state,
    sessions,
    handlers,
    effects,
    dispose: () => effects.splice(0).forEach((d) => typeof d === 'function' && d()),
    /** Emit a session/event like dsh does. */
    event(sessionId, type, data = {}, extra = {}) {
      const s = sessions.get(sessionId) ?? (() => {
        const n = { id: sessionId, header: { cwd: opts.cwd ?? '/w' }, events: [] }
        sessions.set(sessionId, n)
        return n
      })()
      const ev = { type, seq: s.events.length, time: Date.now(), data, ...extra }
      s.events.push(ev)
      for (const h of handlers.get('session/event') ?? []) h.fn(s, ev)
      return ev
    },
    stream(sessionId, chunk, type = 'chunk') {
      for (const h of handlers.get('agent/assistant-stream') ?? []) h.fn({ agent: { id: sessionId, session: sessions.get(sessionId) }, frame: { type, chunk } })
    },
    /** A complete simulated turn started by `source` ('gui' or an rpc id). */
    startTurn(sessionId, turn, text, rpcId) {
      api.event(sessionId, 'turn/start', { turn })
      api.event(sessionId, 'user/message', { content: [{ type: 'text', text }], role: 'user', id: `u-${sessionId}-${turn}`, source: { kind: 'user', ...(rpcId ? { rpcId } : {}) } })
    },
  }
  return api
}

/** Fake OmniChat server side: a ws server that records frames of the bridge and can push frames. */
export async function makeServer(opts = {}) {
  const logins = []
  const httpServer = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/auth/login') {
        logins.push(JSON.parse(body || '{}'))
        const fail = opts.loginFailures && logins.length <= opts.loginFailures
        res.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(fail ? { error: 'bad credentials' } : { token: 'login-token-xyz' }))
      }
      res.writeHead(404).end()
    })
  })
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r))
  const wss = new WebSocketServer({ server: httpServer, path: '/bridge' })
  const port = httpServer.address().port
  const conns = []
  const rec = { frames: [], urls: [], conns, logins }
  wss.on('connection', (ws, req) => {
    rec.urls.push(req.url)
    const c = { ws, frames: [] }
    conns.push(c)
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      c.frames.push(f)
      rec.frames.push(f)
    })
  })
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    rec,
    last: () => conns.at(-1),
    send: (obj, c = conns.at(-1)) => c.ws.send(JSON.stringify(obj)),
    framesOf: (type, c = conns.at(-1)) => (c ? c.frames.filter((f) => f.type === type) : []),
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => httpServer.close(() => r())) }),
    dropAll: () => { for (const c of wss.clients) c.terminate() },
  }
}

export { EventEmitter }
