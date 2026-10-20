// Local mode: the OmniChat app connects to a loopback WebSocket server run by the plugin.
// Pairing is a shared secret in the pairing file. Frames the bridge sends while no app is attached are
// buffered (bounded by time and bytes) and replayed after the next authenticated attach.

import crypto from 'node:crypto'
import { MiniWsServer } from './wsserver.js'
import {
  addAllowedOrigin,
  defaultPairingFile,
  loadOrCreatePairing,
  markPaired,
  readPairing,
  regeneratePairing,
  safeEqual,
  setListenPort,
} from './pairing.js'

const PATH = '/omnichat-bridge'
const DEFAULT_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']
// Frames regenerated on every attach: never buffered, sent only to a live client.
const REGENERABLE = new Set(['ready', 'models', 'sessions'])
const TYPE_RE = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/
const noop = () => {}

const errMsg = (e) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e?.message ?? e))

/** The "type" of a bridge frame: regex fast path, JSON.parse fallback. */
function frameType(str) {
  const m = TYPE_RE.exec(str)
  if (m) return m[1]
  try {
    const o = JSON.parse(str)
    return o && typeof o.type === 'string' ? o.type : ''
  } catch {
    return ''
  }
}

const PAIR_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for an Origin that may open a pairing request: a loopback http(s) page or a Tauri app shell. */
function isPairOrigin(origin) {
  if (typeof origin !== 'string') return false
  if (DEFAULT_ORIGINS.includes(origin)) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return PAIR_HOSTS.has(url.hostname)
}

/**
 * The origin a Tauri shell asks pairing for (hello.forOrigin): the page the desktop app shows is served by the OmniChat server, not by the
 * shell, so its Origin is the server's. Only a connection that itself comes from a Tauri shell may name another origin, and only a plain
 * http(s) origin is accepted. Returns the normalized origin, or null.
 */
function forOriginOf(connOrigin, value) {
  if (typeof value !== 'string' || !DEFAULT_ORIGINS.includes(connOrigin)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  return url.origin
}

/** The display name of a pairing requester: control characters stripped, trimmed, at most 64 characters. */
function cleanClientName(value) {
  if (typeof value !== 'string') return 'OmniChat'
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 64)
  return name || 'OmniChat'
}

function unknownRequest() {
  const e = new Error('No such pending request')
  e.code = 'unknown-request'
  return e
}

export class LocalLink {
  constructor(o) {
    this.config = o.config
    this.logFn = o.log ?? noop
    this.rawLogFn = o.rawLog ?? noop
    this.pluginVersion = o.pluginVersion ?? '0.0.0'
    this.authDelayMs = o.authDelayMs ?? 2000
    this.helloTimeoutMs = o.helloTimeoutMs ?? 10000
    this.lockoutMs = o.lockoutMs ?? 60000
    this.maxFailures = o.maxFailures ?? 5
    this.bufferMs = o.bufferMs ?? 60000
    this.bufferBytes = o.bufferBytes ?? 2 * 1024 * 1024
    this.now = o.now ?? Date.now
    this.WsServerImpl = o.WsServerImpl ?? MiniWsServer
    this.pairRequestTtlMs = o.pairRequestTtlMs ?? 120000
    this.maxPending = o.maxPending ?? 3

    this.instance = crypto.randomUUID()
    this.file = undefined
    this.code = undefined
    this.server = null
    this.bound = []
    this.boundPort = undefined
    this.stopped = false
    this.handlers = null
    this.client = null // the authenticated socket, if any
    this.clientVws = null // the virtual socket of the current attach
    this.live = false // true once `ready` has gone out for the current attach
    this.currentResume = undefined
    this.ord = 0 // ordinal of the last buffered frame
    this.delivered = 0 // ordinal of the last frame written to any client
    this.ring = [] // { ord, str, ts, bytes }
    this.ringBytes = 0
    this.failures = 0
    this.lockedUntil = 0
    this.timers = new Set()
    this.pending = new Map() // pairing requests awaiting approve/deny: id -> { id, origin, clientName, createdAt, expiresAt, sock, st, timer }
  }

  // ------------------------------------------------------------------ logging

  log(msg) {
    try {
      this.logFn(String(msg))
    } catch {
      /* ignore */
    }
  }

  /** Runs a listener body and never lets it throw into the socket or timer machinery. */
  safe(fn) {
    try {
      return fn()
    } catch (e) {
      this.log(`local link error: ${errMsg(e)}`)
      return undefined
    }
  }

  setTimer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.safe(fn)
    }, ms)
    t.unref?.()
    this.timers.add(t)
    return t
  }

  clearTimer(t) {
    if (t) {
      clearTimeout(t)
      this.timers.delete(t)
    }
  }

  // ------------------------------------------------------------------ lifecycle

  get port() {
    return this.boundPort
  }

  get pairing() {
    return this.code
  }

  /** The bound listen addresses (loopback only). */
  get addresses() {
    return this.bound.map((b) => ({ ...b }))
  }

  async start(handlers = {}) {
    if (this.server || this.stopped) throw new Error('local link already started')
    this.handlers = handlers
    const file = this.config.pairingFile || defaultPairingFile()
    this.file = file
    const loaded = loadOrCreatePairing({ file, now: this.now })
    this.code = loaded.data.pairing
    const paired = typeof loaded.data.pairedAt === 'string'

    const server = new this.WsServerImpl({
      hosts: ['127.0.0.1', '::1'],
      port: this.config.listenPort,
      path: PATH,
      allowedHosts: (host) => this.hostAllowed(host),
      onConnection: (sock, req) => this.handleConnection(sock, req),
      log: (m) => this.log(`ws: ${m}`),
    })
    this.server = server
    let bound
    try {
      bound = await server.listen()
    } catch (e) {
      this.server = null
      throw e
    }
    if (this.stopped) {
      this.server = null
      void server.close().catch(() => {})
      return
    }
    this.bound = bound
    this.boundPort = bound[0].port
    setListenPort(file, this.boundPort)

    if (paired) this.log('already paired; run `node dist/pair.js` to show the pairing code')
    else this.rawLogFn(`OmniChat pairing code: ${this.code}`)
    this.rawLogFn(`OmniChat local address: ws://127.0.0.1:${this.boundPort}${PATH}`)
    this.log(`listening for OmniChat on 127.0.0.1:${this.boundPort}`)
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.pending.clear() // pending requests are dropped without a frame
    const server = this.server
    this.server = null
    this.client = null
    this.clientVws = null
    this.live = false
    if (server) void server.close().catch(() => {})
  }

  /** DNS-rebinding defence: the Host header must name the loopback address and the bound port. */
  hostAllowed(host) {
    const p = this.boundPort
    if (typeof host !== 'string' || p === undefined) return false
    return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`].includes(host.toLowerCase())
  }

  /** Settings-page state of the local link. Pairing fields are read fresh from disk. Never includes a log line. */
  status() {
    const file = readPairing(this.file)
    const active = !!this.server && !this.stopped && this.boundPort !== undefined
    const port = active ? this.boundPort : null
    const locked = this.now() < this.lockedUntil
    return {
      active,
      code: !this.stopped && typeof this.code === 'string' ? this.code : null,
      port,
      address: port === null ? null : `ws://127.0.0.1:${port}${PATH}`,
      paired: typeof file?.pairedAt === 'string',
      pairedAt: file?.pairedAt ?? null,
      allowedOrigins: [...this.allowedOriginSet(file)],
      clients: this.client ? 1 : 0,
      locked,
      lockedUntilMs: locked ? this.lockedUntil : 0,
      pending: this.pendingList(),
    }
  }

  /**
   * Replaces the pairing code. The attached app (if any) is detached and closed with 4001, failure and lockout
   * counters are reset, and pairedAt/allowedOrigins are cleared on disk. Throws when the file cannot be written.
   * The code is never logged.
   */
  regenerate() {
    if (this.stopped || !this.file) throw new Error('local link is not running')
    // Pending pairing requests were made against the old code: they are invalidated first.
    for (const id of [...this.pending.keys()]) this.resolvePending(id, 'invalidated')
    const data = regeneratePairing({ file: this.file, now: this.now })
    this.code = data.pairing
    this.failures = 0
    this.lockedUntil = 0
    const old = this.client
    const oldVws = this.clientVws
    if (old) {
      this.client = null
      this.clientVws = null
      this.live = false
      this.currentResume = undefined
      this.safe(() => this.handlers?.onDetach?.(oldVws))
      this.closeQuiet(old, 4001, 'pairing regenerated')
    }
    this.log('pairing regenerated; previous pairing is no longer valid')
    return this.status()
  }

  // ------------------------------------------------------------------ connections

  closeQuiet(sock, code, reason) {
    try {
      sock.close(code, reason)
    } catch {
      try {
        sock.terminate()
      } catch {
        /* ignore */
      }
    }
  }

  handleConnection(sock, req) {
    if (this.now() < this.lockedUntil) {
      this.closeQuiet(sock, 4429, 'locked')
      return
    }
    const st = { state: 'hello', helloTimer: null, timer: null, vws: null, origin: req?.headers?.origin }
    st.helloTimer = this.setTimer(() => {
      if (st.state === 'hello') this.reject(st, sock, 'no hello')
    }, this.helloTimeoutMs)
    sock.addEventListener('message', (ev) => this.safe(() => this.onFrame(st, sock, ev?.data)))
    sock.addEventListener('close', () => this.safe(() => this.onSockClose(st, sock)))
  }

  onFrame(st, sock, data) {
    const text = typeof data === 'string' ? data : String(data)
    if (st.state === 'authed') {
      if (this.client === sock) this.safe(() => this.handlers?.onMessage?.(st.vws, text))
      return
    }
    if (st.state !== 'hello') return
    this.clearTimer(st.helloTimer)
    st.helloTimer = null
    let hello
    try {
      hello = JSON.parse(text)
    } catch {
      hello = null
    }
    if (!hello || typeof hello !== 'object' || Array.isArray(hello) || hello.type !== 'hello') {
      this.reject(st, sock, 'first frame is not hello')
      return
    }
    this.evaluateHello(st, sock, hello)
  }

  onSockClose(st, sock) {
    this.clearTimer(st.helloTimer)
    st.helloTimer = null
    this.clearTimer(st.timer)
    st.timer = null
    // A pending pairing request whose socket goes away is removed; no failure is counted and nothing is sent.
    const req = st.reqId === undefined ? undefined : this.pending.get(st.reqId)
    if (req && req.sock === sock) {
      this.pending.delete(req.id)
      this.clearTimer(req.timer)
      req.timer = null
      this.log(`pairing request from origin ${req.origin} withdrawn: app disconnected`)
    }
    if (st.state === 'authed' && this.client === sock) {
      this.client = null
      this.clientVws = null
      this.live = false
      if (!this.stopped) this.safe(() => this.handlers?.onDetach?.(st.vws))
    }
    st.state = 'closed'
  }

  allowedOriginSet(file) {
    return new Set([...DEFAULT_ORIGINS, ...(this.config.allowedOrigins ?? []), ...(file?.allowedOrigins ?? [])])
  }

  /**
   * A hello with pairRequest:true asks the user, in DSH, to approve this app. No secret is sent until approve().
   * The origin must be a loopback page or a Tauri shell. Refusals here are not counted as pairing failures.
   */
  evaluatePairRequest(st, sock, hello) {
    let origin = st.origin
    if (hello.forOrigin !== undefined) {
      const forOrigin = forOriginOf(origin, hello.forOrigin)
      if (forOrigin === null) {
        st.state = 'rejected'
        this.log(`pairing request refused, bad forOrigin from origin ${origin ?? '(none)'}`)
        this.closeQuiet(sock, 4403, 'origin not allowed')
        return
      }
      origin = forOrigin
    }
    if (!isPairOrigin(origin) && !(hello.forOrigin !== undefined)) {
      st.state = 'rejected'
      this.log(`pairing request refused, origin not allowed: ${origin ?? '(none)'}`)
      this.closeQuiet(sock, 4403, 'origin not allowed')
      return
    }
    this.prunePending()
    const sameOrigin = [...this.pending.values()].some((r) => r.origin === origin)
    if (sameOrigin || this.pending.size >= this.maxPending) {
      st.state = 'rejected'
      this.log(`pairing request refused, too many pending requests (origin ${origin})`)
      this.closeQuiet(sock, 4003, 'too many pending requests')
      return
    }
    const id = crypto.randomUUID()
    const now = this.now()
    const req = {
      id,
      origin,
      clientName: cleanClientName(hello.clientName),
      createdAt: now,
      expiresAt: now + this.pairRequestTtlMs,
      sock,
      st,
      timer: null,
    }
    this.pending.set(id, req)
    st.state = 'pending'
    st.reqId = id
    this.sendTo(sock, { type: 'pair-pending', requestId: id, expiresInSec: Math.ceil(this.pairRequestTtlMs / 1000) })
    req.timer = this.setTimer(() => this.resolvePending(id, 'expired'), this.pairRequestTtlMs)
    this.log(`pairing request from origin ${origin} (${req.clientName}), awaiting approval`)
  }

  evaluateHello(st, sock, hello) {
    if (hello.pairRequest === true) return this.evaluatePairRequest(st, sock, hello)
    const file = readPairing(this.file) // always fresh from disk
    const codeOk = !!file && safeEqual(hello.pairing, file.pairing)
    const origin = st.origin
    if (origin !== undefined && !this.allowedOriginSet(file).has(origin)) {
      if (hello.pair !== true) {
        st.state = 'rejected'
        this.log(`origin not allowed: ${origin}`)
        this.closeQuiet(sock, 4403, 'origin not allowed')
        return
      }
      if (!codeOk) {
        this.reject(st, sock, 'wrong pairing code')
        return
      }
      addAllowedOrigin(this.file, origin)
      this.log(`added allowed origin ${origin}`)
    }
    if (!codeOk) {
      this.reject(st, sock, 'wrong pairing code')
      return
    }
    this.accept(st, sock, hello)
  }

  reject(st, sock, reason) {
    st.state = 'rejected'
    this.clearTimer(st.helloTimer)
    st.helloTimer = null
    this.countFailure()
    this.log(`pairing rejected: ${reason}`)
    st.timer = this.setTimer(() => this.closeQuiet(sock, 4401, 'pairing rejected'), this.authDelayMs)
  }

  /** One failed pairing attempt; reaching maxFailures starts a lockout and resets the counter. */
  countFailure() {
    this.failures += 1
    if (this.failures >= this.maxFailures) {
      this.lockedUntil = this.now() + this.lockoutMs
      this.failures = 0
      this.log(`too many failed pairing attempts; refusing connections for ${(this.lockoutMs / 1000).toFixed(1)}s`)
    }
  }

  sendTo(sock, obj) {
    try {
      sock.send(JSON.stringify(obj))
    } catch {
      /* the socket is going away */
    }
  }

  /** Expires every pending request whose deadline has passed. Each expiry is a denied attempt. */
  prunePending() {
    const now = this.now()
    for (const req of [...this.pending.values()]) {
      if (req.expiresAt <= now) this.resolvePending(req.id, 'expired')
    }
  }

  /** The pending request for `id`, or an unknown-request error (also for expired or closed requests). */
  requireRequest(id) {
    this.prunePending()
    const req = typeof id === 'string' ? this.pending.get(id) : undefined
    if (!req) throw unknownRequest()
    if (req.sock.readyState >= 2) {
      // closing or closed: its close handler normally removes it; do so here if it has not yet
      this.pending.delete(id)
      this.clearTimer(req.timer)
      req.timer = null
      throw unknownRequest()
    }
    return req
  }

  /** Ends a pending request with pair-denied to its socket only. 'denied' and 'expired' count as failures. */
  resolvePending(id, reason) {
    const req = this.pending.get(id)
    if (!req) return false
    this.pending.delete(id)
    this.clearTimer(req.timer)
    req.timer = null
    req.st.state = 'resolved'
    this.sendTo(req.sock, { type: 'pair-denied', reason })
    this.closeQuiet(req.sock, 4002, reason)
    if (reason === 'denied' || reason === 'expired') this.countFailure()
    this.log(`pairing request from origin ${req.origin} ${reason}`)
    return true
  }

  /** The operator approved a pending request: the app gets the pairing code and the origin becomes allowed. */
  approve(id) {
    const req = this.requireRequest(id)
    const file = readPairing(this.file)
    if (!file) {
      const e = new Error('No OmniChat pairing file')
      e.code = 'no-pairing'
      throw e
    }
    if (!addAllowedOrigin(this.file, req.origin)) throw new Error(`cannot write OmniChat pairing file at ${this.file}`)
    markPaired(this.file, this.now)
    this.pending.delete(req.id)
    this.clearTimer(req.timer)
    req.timer = null
    req.st.state = 'resolved'
    this.failures = 0
    this.sendTo(req.sock, { type: 'pair-approved', pairing: file.pairing })
    this.closeQuiet(req.sock, 1000, 'approved')
    this.log(`approved pairing request for origin ${req.origin}`)
    return this.status()
  }

  /** The operator refused a pending request. */
  deny(id) {
    const req = this.requireRequest(id)
    this.resolvePending(req.id, 'denied')
    return this.status()
  }

  /** Pending requests for the settings page: never includes a token. */
  pendingList() {
    this.prunePending()
    const now = this.now()
    return [...this.pending.values()].map((r) => ({
      id: r.id,
      origin: r.origin,
      clientName: r.clientName,
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: r.expiresAt,
      expiresInSec: Math.max(0, Math.ceil((r.expiresAt - now) / 1000)),
    }))
  }

  accept(st, sock, hello) {
    this.failures = 0
    markPaired(this.file, this.now)
    if (this.client) this.replaceClient()
    const vws = this.makeVws()
    st.state = 'authed'
    st.vws = vws
    this.client = sock
    this.clientVws = vws
    this.live = false
    this.currentResume = hello.resume
    this.log(`OmniChat app authenticated${st.origin !== undefined ? ` (origin ${st.origin})` : ''}`)
    this.safe(() => this.handlers?.onAttach?.(vws, { resume: hello.resume }))
  }

  /** A new client takes over: the old one is detached first, then closed with 4000. */
  replaceClient() {
    const old = this.client
    const oldVws = this.clientVws
    this.client = null
    this.clientVws = null
    this.live = false
    this.safe(() => this.handlers?.onDetach?.(oldVws))
    this.log('OmniChat app replaced by a new connection')
    this.closeQuiet(old, 4000, 'replaced')
  }

  /** A virtual socket for one attach. It is always "open" and keeps delivering to the link after its client is gone. */
  makeVws() {
    const link = this
    return {
      readyState: 1,
      send(data) {
        link.outbound(typeof data === 'string' ? data : String(data))
      },
      ping() {
        try {
          link.client?.ping()
        } catch {
          /* ignore */
        }
      },
      close() {},
    }
  }

  // ------------------------------------------------------------------ outbound

  sendRaw(str) {
    try {
      this.client?.send(str)
    } catch {
      /* the client is going away; the frame stays buffered if it is a buffered type */
    }
  }

  outbound(str) {
    this.safe(() => {
      const type = frameType(str)
      if (type === 'ready') return this.sendReady(str)
      if (REGENERABLE.has(type)) {
        if (this.client && this.live) this.sendRaw(str)
        return undefined
      }
      this.ord += 1
      const ord = this.ord
      const bytes = Buffer.byteLength(str)
      this.ring.push({ ord, str, ts: this.now(), bytes })
      this.ringBytes += bytes
      this.trim()
      if (this.client && this.live) {
        this.sendRaw(str)
        this.delivered = ord
      }
      return undefined
    })
  }

  trim() {
    const cutoff = this.now() - this.bufferMs
    while (this.ring.length > 0 && (this.ring[0].ts < cutoff || this.ringBytes > this.bufferBytes)) {
      this.ringBytes -= this.ring.shift().bytes
    }
  }

  /** Where the replay starts: the client's own sinceSeq when it is resumable, else the last frame delivered. */
  replayStart() {
    const r = this.currentResume
    if (
      r &&
      typeof r === 'object' &&
      r.instance === this.instance &&
      Number.isInteger(r.sinceSeq) &&
      r.sinceSeq >= 0 &&
      r.sinceSeq <= this.ord &&
      (this.ring.length === 0 || this.ring[0].ord <= r.sinceSeq + 1)
    ) {
      return r.sinceSeq
    }
    return this.delivered
  }

  /** `ready` goes out first, carrying mode/version/instance/seq; then the buffered frames after `seq`. */
  sendReady(str) {
    if (!this.client) return
    this.trim()
    const replayFrom = this.replayStart()
    let reply = str
    try {
      const obj = JSON.parse(str)
      if (obj && typeof obj === 'object') {
        reply = JSON.stringify({ ...obj, mode: 'local', version: this.pluginVersion, instance: this.instance, seq: replayFrom })
      }
    } catch {
      /* send the frame as produced */
    }
    this.sendRaw(reply)
    this.live = true
    for (const e of [...this.ring]) {
      if (e.ord <= replayFrom) continue
      this.sendRaw(e.str)
      this.delivered = e.ord
    }
  }
}
