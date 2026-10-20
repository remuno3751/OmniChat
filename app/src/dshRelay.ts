// Pure relay between a local DSH plugin WebSocket and the OmniChat server bridge WebSocket.
// No React, no react-native. Sockets and timers are injected; nothing runs at import time.

export interface WsLike {
  readyState: number
  bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void
}

export type WsFactory = (url: string) => WsLike

export type LocalState = 'off' | 'connecting' | 'connected' | 'auth-failed' | 'replaced'
export type ServerState = 'off' | 'connecting' | 'connected'

export interface RelayStatus {
  local: LocalState
  server: ServerState
  bridgeName: string
  lastError?: string
  framesToServer: number
  framesToLocal: number
  localAttempts: number
  serverAttempts: number
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
  random(): number
}

export interface RelayOptions {
  port: number
  pairing: string
  bridgeName: string
  serverUrl: string
  token: string
  firstPair?: boolean
  version?: string
  localFactory: WsFactory
  serverFactory: WsFactory
  onStatus?: (s: RelayStatus) => void
  timers?: Timers
  queueLimitBytes?: number
  highWaterBytes?: number
  backoffMinMs?: number
  backoffMaxMs?: number
  helloTimeoutMs?: number
  stableMs?: number
}

const WS_OPEN = 1
const DRAIN_MS = 50
const LOCKED_MIN_MS = 60000
const JITTER_FRACTION = 0.3
const SEQ_NEUTRAL_TYPES = new Set(['ready', 'models', 'sessions'])
const TYPE_PREFIX_RE = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/

type Dir = 'server' | 'local'

interface Pipe {
  q: string[]
  bytes: number
  timer: unknown
}

export function buildBridgeUrl(serverUrl: string, name: string, token: string): string {
  const u = new URL(serverUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol
  u.pathname = u.pathname.replace(/\/+$/, '') + '/bridge'
  u.search = ''
  u.searchParams.set('token', token)
  u.searchParams.set('name', name)
  return u.toString()
}

export function localUrl(port: number): string {
  return `ws://127.0.0.1:${port}/omnichat-bridge`
}

// Frames of these types do not advance the resume sequence counter.
function countsTowardSeq(data: string): boolean {
  const m = TYPE_PREFIX_RE.exec(data)
  let type: unknown
  if (m) {
    type = m[1]
  } else {
    try {
      const parsed: any = JSON.parse(data)
      type = parsed && typeof parsed === 'object' ? parsed.type : undefined
    } catch {
      return true
    }
  }
  return !(typeof type === 'string' && SEQ_NEUTRAL_TYPES.has(type))
}

function defaultTimers(): Timers {
  const g: any = globalThis
  return {
    setTimeout: (fn, ms) => g.setTimeout(fn, ms),
    clearTimeout: (h) => g.clearTimeout(h),
    random: () => Math.random(),
  }
}

function has(h: unknown): boolean {
  return h !== null && h !== undefined
}

export class DshRelay {
  private readonly opts: RelayOptions
  private readonly timers: Timers
  private readonly queueLimit: number
  private readonly highWater: number
  private readonly backoffMin: number
  private readonly backoffMax: number
  private readonly helloTimeout: number
  private readonly stableMs: number

  private running = false
  private localWs: WsLike | null = null
  private serverWs: WsLike | null = null
  private local: LocalState = 'off'
  private server: ServerState = 'off'
  private lastError: string | undefined = undefined
  private framesToServer = 0
  private framesToLocal = 0
  private localAttempts = 0
  private serverAttempts = 0
  private pairedOnce = false
  private instance: string | undefined = undefined
  private rcvCount = 0
  private readyRaw = ''
  private helloDone = false
  private localReady = false
  private helloTimer: unknown = null
  private stableTimer: unknown = null
  private reconnectTimer: unknown = null
  private localNextMs: number
  private serverNextMs: number
  private readonly toServer: Pipe = { q: [], bytes: 0, timer: null }
  private readonly toLocal: Pipe = { q: [], bytes: 0, timer: null }

  constructor(o: RelayOptions) {
    this.opts = o
    this.timers = o.timers ?? defaultTimers()
    this.queueLimit = o.queueLimitBytes ?? 2 * 1024 * 1024
    this.highWater = o.highWaterBytes ?? 1024 * 1024
    this.backoffMin = o.backoffMinMs ?? 1000
    this.backoffMax = o.backoffMaxMs ?? 30000
    this.helloTimeout = o.helloTimeoutMs ?? 10000
    this.stableMs = o.stableMs ?? 5000
    this.localNextMs = this.backoffMin
    this.serverNextMs = this.backoffMin
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastError = undefined
    this.resetBackoff()
    this.openLocal()
  }

  stop(): void {
    this.running = false
    this.cancelReconnect()
    this.closeServer()
    this.closeLocal()
    this.local = 'off'
    this.server = 'off'
    this.emit()
  }

  retry(): void {
    this.running = true
    this.cancelReconnect()
    this.closeServer(1000, 'retry')
    this.closeLocal(1000, 'retry')
    this.lastError = undefined
    this.resetBackoff()
    this.openLocal()
  }

  getStatus(): RelayStatus {
    const s: RelayStatus = {
      local: this.local,
      server: this.server,
      bridgeName: this.opts.bridgeName,
      framesToServer: this.framesToServer,
      framesToLocal: this.framesToLocal,
      localAttempts: this.localAttempts,
      serverAttempts: this.serverAttempts,
    }
    if (this.lastError !== undefined) s.lastError = this.lastError
    return s
  }

  // ---- local socket -------------------------------------------------------

  private openLocal(): void {
    this.cancelReconnect()
    this.localAttempts++
    this.local = 'connecting'
    this.localReady = false
    this.helloDone = false
    this.emit()
    let ws: WsLike
    try {
      ws = this.opts.localFactory(localUrl(this.opts.port))
    } catch {
      this.failLocal('local socket failed')
      return
    }
    this.localWs = ws
    ws.addEventListener('open', () => this.guard(() => this.onLocalOpen(ws)))
    ws.addEventListener('message', (ev: any) => this.guard(() => this.onLocalMessage(ws, ev?.data)))
    ws.addEventListener('close', (ev: any) => this.guard(() => this.onLocalClose(ws, ev?.code)))
    ws.addEventListener('error', () => this.guard(() => this.onLocalError(ws)))
  }

  private helloFrame(): Record<string, unknown> {
    const f: Record<string, unknown> = {
      type: 'hello',
      pairing: this.opts.pairing,
      client: 'omnichat-app',
      version: this.opts.version ?? '',
    }
    if (this.opts.firstPair && !this.pairedOnce) f.pair = true
    if (this.instance !== undefined) f.resume = { instance: this.instance, sinceSeq: this.rcvCount }
    return f
  }

  private onLocalOpen(ws: WsLike): void {
    if (ws !== this.localWs) return
    this.safeSend(ws, JSON.stringify(this.helloFrame()))
    this.helloTimer = this.later(() => {
      this.helloTimer = null
      if (ws === this.localWs && !this.helloDone) this.failLocal('hello timeout')
    }, this.helloTimeout)
  }

  private onLocalMessage(ws: WsLike, data: unknown): void {
    if (ws !== this.localWs || typeof data !== 'string') return
    if (!this.helloDone) {
      this.onFirstFrame(data)
      return
    }
    if (countsTowardSeq(data)) this.rcvCount++
    this.push('server', data)
  }

  private onFirstFrame(data: string): void {
    this.helloDone = true
    this.clear(this.helloTimer)
    this.helloTimer = null
    let frame: any = null
    try {
      frame = JSON.parse(data)
    } catch {
      frame = null
    }
    if (!frame || typeof frame !== 'object' || frame.type !== 'ready') {
      this.failLocal('expected ready frame')
      return
    }
    this.readyRaw = data
    this.localReady = true
    this.pairedOnce = true
    if (typeof frame.instance === 'string') this.instance = frame.instance
    this.rcvCount = typeof frame.seq === 'number' ? frame.seq : 0
    this.lastError = undefined
    this.local = 'connected'
    this.emit()
    this.startStable()
    this.openServer()
  }

  private onLocalClose(ws: WsLike, code: unknown): void {
    if (ws !== this.localWs) return
    const c = typeof code === 'number' ? code : undefined
    if (c === 4401 || c === 4403) {
      this.lastError = c === 4401 ? 'pairing rejected' : 'origin not allowed'
      this.halt('auth-failed')
    } else if (c === 4000) {
      this.lastError = 'another client took over'
      this.halt('replaced')
    } else if (c === 4429) {
      this.lastError = 'locked, retrying later'
      this.closeServer(1000, 'server lost')
      this.closeLocal()
      this.local = 'connecting'
      this.scheduleReconnect(Math.max(LOCKED_MIN_MS, this.takeDelay('local')))
      this.emit()
    } else {
      this.failLocal(c === undefined ? 'local closed' : `local closed ${c}`)
    }
  }

  private onLocalError(ws: WsLike): void {
    if (ws === this.localWs) this.failLocal('local error')
  }

  // Terminal local state (auth-failed / replaced): no reconnect until retry().
  private halt(state: LocalState): void {
    this.local = state
    this.cancelReconnect()
    this.closeServer(1000, 'server lost')
    this.server = 'off'
    this.closeLocal()
    this.emit()
  }

  // Failed local attempt or dropped local connection: back off and reconnect.
  private failLocal(reason: string): void {
    if (!this.running) return
    this.lastError = reason
    this.closeServer(1000, 'local lost')
    this.server = 'off'
    this.closeLocal()
    this.local = 'connecting'
    this.scheduleReconnect(this.takeDelay('local'))
    this.emit()
  }

  // ---- server socket ------------------------------------------------------

  private openServer(): void {
    this.serverAttempts++
    this.server = 'connecting'
    this.emit()
    let ws: WsLike
    try {
      ws = this.opts.serverFactory(buildBridgeUrl(this.opts.serverUrl, this.opts.bridgeName, this.opts.token))
    } catch {
      this.handleServerDown('server socket failed')
      return
    }
    this.serverWs = ws
    ws.addEventListener('open', () => this.guard(() => this.onServerOpen(ws)))
    ws.addEventListener('message', (ev: any) => this.guard(() => this.onServerMessage(ws, ev?.data)))
    ws.addEventListener('close', (ev: any) => this.guard(() => this.onServerDown(ws, ev?.code)))
    ws.addEventListener('error', () => this.guard(() => this.onServerDown(ws, undefined)))
  }

  private onServerOpen(ws: WsLike): void {
    if (ws !== this.serverWs) return
    this.server = 'connected'
    this.emit()
    this.sendCounted('server', ws, this.readyRaw)
    this.drain('server')
  }

  private onServerMessage(ws: WsLike, data: unknown): void {
    if (ws !== this.serverWs || typeof data !== 'string') return
    this.push('local', data)
  }

  private onServerDown(ws: WsLike, code: unknown): void {
    if (ws !== this.serverWs) return
    const c = typeof code === 'number' ? code : undefined
    const text =
      c === 4001
        ? 'device revoked'
        : c === 4000
          ? 'replaced by another connection'
          : c === undefined
            ? 'server error'
            : `server closed ${c}`
    this.handleServerDown(text)
  }

  // Server lost: drop the local socket too so the plugin re-sends ready and snapshots.
  private handleServerDown(text: string): void {
    this.lastError = text
    this.closeServer(1000, 'server lost')
    this.server = 'connecting'
    this.closeLocal(1000, 'server lost')
    this.local = 'connecting'
    this.scheduleReconnect(this.takeDelay('server'))
    this.emit()
  }

  // ---- forwarding ---------------------------------------------------------

  private pipe(dir: Dir): Pipe {
    return dir === 'server' ? this.toServer : this.toLocal
  }

  private target(dir: Dir): WsLike | null {
    if (dir === 'server') {
      const ws = this.serverWs
      return ws !== null && this.server === 'connected' && ws.readyState === WS_OPEN ? ws : null
    }
    const ws = this.localWs
    return ws !== null && this.localReady && ws.readyState === WS_OPEN ? ws : null
  }

  private push(dir: Dir, data: string): void {
    const p = this.pipe(dir)
    const t = this.target(dir)
    if (p.q.length === 0 && t !== null && t.bufferedAmount <= this.highWater) {
      this.sendCounted(dir, t, data)
      return
    }
    if (p.bytes + data.length > this.queueLimit) {
      this.overflow()
      return
    }
    p.q.push(data)
    p.bytes += data.length
    this.scheduleDrain(dir)
  }

  private scheduleDrain(dir: Dir): void {
    const p = this.pipe(dir)
    if (has(p.timer)) return
    p.timer = this.later(() => {
      p.timer = null
      this.drain(dir)
    }, DRAIN_MS)
  }

  private drain(dir: Dir): void {
    const p = this.pipe(dir)
    while (p.q.length > 0) {
      const t = this.target(dir)
      if (t === null || t.bufferedAmount > this.highWater) break
      const d = p.q.shift() as string
      p.bytes -= d.length
      this.sendCounted(dir, t, d)
    }
    if (p.q.length > 0) this.scheduleDrain(dir)
  }

  private sendCounted(dir: Dir, ws: WsLike, data: string): void {
    this.safeSend(ws, data)
    if (dir === 'server') this.framesToServer++
    else this.framesToLocal++
    this.emit()
  }

  private overflow(): void {
    this.lastError = 'queue overflow'
    this.closeServer(1013, 'overflow')
    this.closeLocal(1013, 'overflow')
    this.local = 'connecting'
    this.server = 'connecting'
    this.scheduleReconnect(this.takeDelay('local'))
    this.emit()
  }

  private resetPipes(): void {
    for (const p of [this.toServer, this.toLocal]) {
      this.clear(p.timer)
      p.timer = null
      p.q.length = 0
      p.bytes = 0
    }
  }

  // ---- socket teardown ----------------------------------------------------

  private closeLocal(code?: number, reason?: string): void {
    const ws = this.localWs
    this.localWs = null
    this.localReady = false
    this.helloDone = false
    this.clear(this.helloTimer)
    this.helloTimer = null
    this.clear(this.stableTimer)
    this.stableTimer = null
    this.resetPipes()
    if (ws) this.safeClose(ws, code, reason)
  }

  private closeServer(code?: number, reason?: string): void {
    const ws = this.serverWs
    this.serverWs = null
    this.resetPipes()
    if (ws) {
      if (this.running) this.server = 'connecting'
      this.safeClose(ws, code, reason)
    }
  }

  // ---- timing -------------------------------------------------------------

  private startStable(): void {
    this.clear(this.stableTimer)
    this.stableTimer = this.later(() => {
      this.stableTimer = null
      this.resetBackoff()
    }, this.stableMs)
  }

  private resetBackoff(): void {
    this.localNextMs = this.backoffMin
    this.serverNextMs = this.backoffMin
  }

  // Returns the current base delay for kind and doubles it for next time.
  private takeDelay(kind: Dir): number {
    const cur = kind === 'local' ? this.localNextMs : this.serverNextMs
    const next = Math.min(cur * 2, this.backoffMax)
    if (kind === 'local') this.localNextMs = next
    else this.serverNextMs = next
    return cur
  }

  private scheduleReconnect(base: number): void {
    this.cancelReconnect()
    const delay = Math.round(base + base * JITTER_FRACTION * this.unitRandom())
    this.reconnectTimer = this.later(() => {
      this.reconnectTimer = null
      if (this.running) this.openLocal()
    }, delay)
  }

  private cancelReconnect(): void {
    this.clear(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private unitRandom(): number {
    try {
      const r = this.timers.random()
      return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0
    } catch {
      return 0
    }
  }

  // ---- helpers ------------------------------------------------------------

  private later(fn: () => void, ms: number): unknown {
    return this.timers.setTimeout(() => this.guard(fn), ms)
  }

  private clear(h: unknown): void {
    if (!has(h)) return
    try {
      this.timers.clearTimeout(h)
    } catch {
      /* ignore */
    }
  }

  private guard(fn: () => void): void {
    try {
      fn()
    } catch {
      /* handlers never throw out */
    }
  }

  private safeSend(ws: WsLike, data: string): void {
    try {
      ws.send(data)
    } catch {
      /* socket went away; its close event handles recovery */
    }
  }

  // Browsers only accept 1000 and 3000-4999 in close(); fall back to a plain close.
  private safeClose(ws: WsLike, code?: number, reason?: string): void {
    try {
      if (code !== undefined) ws.close(code, reason)
      else ws.close()
    } catch {
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
  }

  private emit(): void {
    const cb = this.opts.onStatus
    if (!cb) return
    try {
      cb(this.getStatus())
    } catch {
      /* onStatus errors are swallowed */
    }
  }
}
