import path from 'node:path'
import { toWsUrl, httpUrl, parseJson, parseModelRef, textOf, normCwd, isSafeCwd } from './wire.js'
import { SessionModel, MirrorState } from './mirror.js'
import { createCheckpoint, computeChanges, rewindTo } from './gitops.js'
import { FsLimiter, listDir, readFile } from './fsread.js'
import { ApprovalBroker } from './approvals.js'
import { SubagentTracker } from './agents.js'

const OPEN = 1
const CHANGES_TIMEOUT_MS = 60000
const AGENTS_DEBOUNCE_MS = 100
const LINGER_MS = 15 * 60 * 1000
const CALLS_MAX = 500
const MAX_WORKSPACES = 50

const errMsg = (e) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e?.message ?? e))

/**
 * The OmniChat bridge: speaks the BRIDGE.md / BRIDGE-v2.md wire protocol to an OmniChat server
 * and drives dsh in-process through `host` (see host.js). No dsh process is spawned and no log is parsed.
 */
export class OmniBridge {
  constructor(o) {
    this.host = o.host
    this.cfg = o.config
    this.logFn = o.log ?? (() => {})
    this.WS = o.WebSocketImpl ?? globalThis.WebSocket
    this.fetch = o.fetchImpl ?? globalThis.fetch
    this.minMs = o.reconnectMinMs ?? 1000
    this.maxMs = o.reconnectMaxMs ?? 30000
    this.pingMs = o.pingIntervalMs ?? 20000
    this.modelsPollMs = o.modelsPollMs ?? 30000
    this.textBatchMs = o.textBatchMs ?? 40
    this.mirrorFlushMs = o.mirrorFlushMs ?? 250
    this.cancelGraceMs = o.cancelGraceMs ?? 4000
    this.dshVersion = o.dshVersion
    this.pluginVersion = typeof o.pluginVersion === 'string' ? o.pluginVersion : null // sent in `ready` (the server lists it)
    this.link = o.link ?? null // local mode: LocalLink (the OmniChat app connects to us); absent in remote mode
    this.omni = o.omni ?? null // OmniModels (omnimodels.js): handles omni_* reply frames; assigned by index.js when present
    this.delay = this.minMs
    this.stopped = false
    this.ws = null
    this.token = this.cfg.token
    this.timers = new Set()
    this.reconnectTimer = null
    this.connTimers = []
    this.disposers = []
    this.runs = new Map() // runId -> run
    this.bySession = new Map() // sessionId -> run
    this.ownIds = new Set()
    this.models = []
    this.defaultModel = undefined
    this.lastModelsJson = ''
    this.mirrorEnabled = !!this.cfg.mirror
    this.mstate = new MirrorState({ scope: this.cfg.mirrorScope, cwd: this.cfg.cwd })
    this.hydrating = new Map()
    this.mirrorReady = false
    this.flushTimer = null
    this.modelsDebounce = null
    this.knownCwds = new Set() // working directories of runs (rewind is limited to these)
    this.lastWorkspacesJson = '' // last `workspaces` list sent on this connection
    this.rewinding = false
    this.previewFs = this.cfg.previewFs === true // read-only file access for Code preview (BRIDGE-v2.md, section C); default off
    this.fsLimiter = new FsLimiter()
    this.calls = new Map() // `${sessionId}:${callId}` -> { name, arguments }, for approval display
    this.broker = new ApprovalBroker({ send: (f) => this.send(this.ws, f), timeoutMs: this.cfg.approvalTimeoutMs })
    this.agentTimers = new Map() // runId -> debounce timer
    this.pendingAgents = new Map() // runId -> latest agents list waiting to be sent
    this.lingering = new Map() // runId -> { ws, timer }: children still running after the parent turn ended
    this.lingerBySession = new Map() // parent sessionId -> runId, while lingering
    this.tracker = new SubagentTracker({
      resolveRun: (sid) => this.bySession.get(sid)?.runId ?? this.lingerBySession.get(sid),
      onChange: (runId, agents) => this.sendAgents(runId, agents),
    })
  }

  // ------------------------------------------------------------------ logging

  scrub(s) {
    let out = String(s)
    let omniSecrets = []
    try {
      omniSecrets = this.omni?.secrets?.() ?? []
    } catch {
      omniSecrets = []
    }
    for (const secret of [this.token, this.cfg.token, this.cfg.password, this.link?.pairing, ...omniSecrets]) {
      if (secret && secret.length >= 4) out = out.split(secret).join('***')
    }
    return out
  }

  log(msg) {
    try {
      this.logFn(this.scrub(msg))
    } catch {
      /* ignore */
    }
  }

  setTimer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
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

  start() {
    this.subscribe()
    if (this.link) this.startLocal()
    else void this.connect()
  }

  /**
   * Local mode: the OmniChat app attaches to the LocalLink. A detach keeps the runs going (their frames are
   * buffered by the link); nothing is dropped or cancelled here.
   */
  startLocal() {
    this.link
      .start({
        onAttach: (vws) => {
          this.ws = vws
          this.delay = this.minMs
          this.log('OmniChat app connected')
          void this.afterOpen(vws)
        },
        onDetach: (vws) => {
          if (this.ws === vws) this.ws = null
          for (const t of this.connTimers) clearInterval(t)
          this.connTimers = []
          this.mirrorReady = false
          this.log('OmniChat app disconnected; runs keep going, events are buffered')
        },
        onMessage: (vws, text) => this.onMessage(vws, text),
      })
      .catch((e) => this.log(`local server failed: ${errMsg(e)}`))
  }

  stop() {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const t of this.connTimers) clearInterval(t)
    this.connTimers = []
    for (const d of this.disposers.splice(0)) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    this.broker.cancelAll('rejected')
    this.resetAgents()
    for (const run of [...this.runs.values()]) {
      void this.host.cancel(run.sessionId).catch(() => {})
      this.unregister(run)
    }
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close(1000, 'plugin disposed')
      } catch {
        /* ignore */
      }
    }
    if (this.link) {
      try {
        this.link.stop()
      } catch {
        /* ignore */
      }
    }
  }

  subscribe() {
    const h = this.host
    this.disposers.push(h.on('session/event', (session, ev) => this.onSessionEvent(session, ev), { global: true }))
    this.disposers.push(h.on('agent/assistant-stream', (arg) => this.onStream(arg), { global: true }))
    for (const name of ['llm/adapters-updated', 'settings/document-updated']) {
      this.disposers.push(h.on(name, () => this.scheduleModelsRefresh(), { global: true }))
    }
    this.disposers.push(h.on('subagent/start', (info) => this.tracker.onStart(info), { global: true }))
    this.disposers.push(h.on('subagent/end', (info) => this.tracker.onEnd(info), { global: true }))
    if (this.cfg.approvals === 'deny') {
      this.disposers.push(
        h.on(
          'approval/request',
          (req, next) => {
            const sid = req?.agent?.id ?? req?.agent?.session?.id
            if (sid && this.bySession.has(sid)) return 'rejected'
            return typeof next === 'function' ? next() : undefined
          },
          { prepend: true, global: true },
        ),
      )
    } else if (this.cfg.approvals === 'remote') {
      this.disposers.push(
        h.on(
          'approval/request',
          (req, next) => {
            const sid = req?.agent?.id ?? req?.agent?.session?.id
            const runId = this.runIdForSession(sid, req?.agent?.session?.header)
            const run = runId ? this.runs.get(runId) : undefined
            if (!run || run.finished) return typeof next === 'function' ? next() : undefined
            return this.broker.request({ requestId: runId, req, call: this.calls.get(`${sid}:${req?.callId}`) })
          },
          { prepend: true, global: true },
        ),
      )
    }
  }

  /** The OmniChat run an approval/agent session belongs to: a run's own session, or the owner of a sub-agent. */
  runIdForSession(sid, header) {
    if (!sid) return undefined
    const direct = this.bySession.get(sid)?.runId
    if (direct) return direct
    if (header?.origin === 'subagent' && typeof header.parentSession === 'string') return this.tracker.ownerOf(header.parentSession)
    return undefined
  }

  // ------------------------------------------------------------------ connection

  async getToken() {
    if (this.token) return this.token
    const res = await this.fetch(httpUrl(this.cfg.serverUrl, '/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.cfg.username, password: this.cfg.password }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.token) throw new Error(`login failed (HTTP ${res.status}${body.error ? `: ${body.error}` : ''})`)
    this.token = body.token
    return this.token
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const d = this.delay
    this.delay = Math.min(this.delay * 2, this.maxMs)
    this.log(`reconnecting in ${Math.round(d / 100) / 10}s`)
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      void this.connect()
    }, d)
  }

  async connect() {
    if (this.stopped) return
    let token
    try {
      token = await this.getToken()
    } catch (e) {
      this.log(`auth failed: ${errMsg(e)}`)
      this.scheduleReconnect()
      return
    }
    if (this.stopped) return
    let ws
    try {
      ws = new this.WS(toWsUrl(this.cfg.serverUrl, this.cfg.name, token))
    } catch (e) {
      this.log(`connect error: ${errMsg(e)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    let opened = false
    let closed = false
    const onClosed = () => {
      if (closed) return
      closed = true
      for (const t of this.connTimers) clearInterval(t)
      this.connTimers = []
      this.mirrorReady = false
      this.lastWorkspacesJson = ''
      if (this.ws === ws) this.ws = null
      this.dropRuns()
      this.broker.cancelAll('rejected')
      this.resetAgents()
      // A rejected handshake with a login-derived token means the token may be stale: log in again.
      if (!opened && !this.cfg.token) this.token = undefined
      this.scheduleReconnect()
    }
    ws.addEventListener('open', () => {
      opened = true
      this.delay = this.minMs
      this.log(`connected as '${this.cfg.name}'`)
      void this.afterOpen(ws)
    })
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') this.onMessage(ws, ev.data)
    })
    ws.addEventListener('error', () => {
      if (!opened) this.log('socket error (server unreachable or connection rejected)')
    })
    ws.addEventListener('close', () => {
      if (!this.stopped) this.log('disconnected')
      onClosed()
    })
  }

  async afterOpen(ws) {
    await Promise.race([this.refreshModels(), new Promise((r) => setTimeout(r, 4000).unref?.())])
    if (this.ws !== ws || this.stopped) return
    this.send(ws, {
      type: 'ready',
      name: this.cfg.name,
      cwd: this.cfg.cwd ?? process.cwd(),
      ...(this.dshVersion ? { dshVersion: this.dshVersion } : {}),
      ...(this.pluginVersion ? { pluginVersion: this.pluginVersion } : {}),
      ...this.modelsPayload(),
      capabilities: { ...(this.previewFs ? { fs: true } : {}), workspaces: true },
      ...this.workspacesPayload(),
    })
    this.lastWorkspacesJson = JSON.stringify(this.workspacesPayload())
    // keepalive + liveness (the server pings; Node's WebSocket pongs automatically)
    const ka = setInterval(() => {
      if (this.ws !== ws) return
      try {
        if (typeof ws.ping === 'function') ws.ping()
        else this.send(ws, { type: 'ping' })
      } catch {
        /* ignore */
      }
    }, this.pingMs)
    ka.unref?.()
    const mp = setInterval(() => {
      if (this.ws !== ws) return
      void this.refreshModels().then((changed) => {
        if (changed && this.ws === ws) this.send(ws, { type: 'models', ...this.modelsPayload() })
      })
    }, this.modelsPollMs)
    mp.unref?.()
    this.connTimers.push(ka, mp)
    if (this.mirrorEnabled) {
      try {
        await this.sendFull(ws)
      } catch (e) {
        this.log(`mirror snapshot failed: ${errMsg(e)}`)
      }
    }
  }

  send(ws, msg) {
    if (!ws || ws.readyState !== OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  /** Sends a frame on the current server link. False when there is no live link. */
  sendToServer(frame) {
    return this.send(this.ws, frame)
  }

  // ------------------------------------------------------------------ models

  modelsPayload() {
    return { models: this.models, ...(this.defaultModel ? { defaultModel: this.defaultModel } : {}) }
  }

  async refreshModels() {
    try {
      const cat = await this.host.modelCatalog()
      const models = []
      for (const g of cat?.groups ?? []) {
        for (const m of g?.models ?? []) {
          if (!g?.id || !m?.id) continue
          const entry = { provider: String(g.id), id: String(m.id), name: String(m.name ?? m.id) }
          if (typeof g.name === 'string' && g.name.trim()) entry.providerName = g.name.slice(0, 100)
          if (g.id === 'omnichat') entry.imported = true
          models.push(entry)
        }
      }
      const d = cat?.default
      const defaultModel = d?.provider && d?.model ? `${d.provider}::${d.model}` : undefined
      const json = JSON.stringify([models, defaultModel])
      const changed = json !== this.lastModelsJson
      this.lastModelsJson = json
      this.models = models
      this.defaultModel = defaultModel
      return changed
    } catch (e) {
      this.host.warnOnce('modelCatalog', `model list unavailable: ${errMsg(e)}`)
      return false
    }
  }

  scheduleModelsRefresh() {
    if (this.modelsDebounce) return
    this.modelsDebounce = this.setTimer(() => {
      this.modelsDebounce = null
      const ws = this.ws
      void this.refreshModels().then((changed) => {
        if (changed && ws && this.ws === ws) this.send(ws, { type: 'models', ...this.modelsPayload() })
      })
    }, 1000)
  }

  // ------------------------------------------------------------------ server -> bridge

  onMessage(ws, text) {
    let m
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (!m || typeof m !== 'object') return
    if (m.type === 'run' && typeof m.runId === 'string' && typeof m.prompt === 'string') {
      const sid = typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : null
      const model = typeof m.model === 'string' && m.model && m.model !== 'dsh' ? m.model : null
      const cwd = typeof m.cwd === 'string' ? m.cwd : undefined // only meaningful for a new session
      void this.handleRun(ws, m.runId, sid, m.prompt, model, cwd).catch((e) => this.log(`run ${m.runId} failed: ${errMsg(e)}`))
    } else if (m.type === 'cancel' && typeof m.runId === 'string') {
      const run = this.runs.get(m.runId)
      if (run) void this.cancelRun(run)
    } else if (m.type === 'approval_reply') {
      this.broker.reply(m)
    } else if (m.type === 'rewind') {
      void this.handleRewind(ws, m)
    } else if (m.type === 'fs' && typeof m.requestId === 'string') {
      this.handleFs(ws, m)
    } else if (m.type === 'omni_models' || m.type === 'omni_key' || m.type === 'omni_key_revoked') {
      try {
        this.omni?.onFrame(m)
      } catch (e) {
        this.log(`omni reply error: ${errMsg(e)}`)
      }
    }
  }

  // ------------------------------------------------------------------ runs

  rememberOwn(runId) {
    this.ownIds.add(runId)
    if (this.ownIds.size > 1000) this.ownIds.delete(this.ownIds.values().next().value)
  }

  unregister(run) {
    this.runs.delete(run.runId)
    if (this.bySession.get(run.sessionId) === run) this.bySession.delete(run.sessionId)
    this.clearTimer(run.flushTimer)
    this.clearTimer(run.cancelTimer)
    run.flushTimer = run.cancelTimer = null
  }

  /** Connection lost: dsh turns keep running in dsh, but the server treats the run as failed. */
  dropRuns() {
    for (const run of [...this.runs.values()]) {
      this.log(`connection lost, detaching run ${run.runId}`)
      void this.host.cancel(run.sessionId).catch(() => {})
      run.finished = true
      this.unregister(run)
    }
  }

  runSend(run, msg) {
    if (run.finished && msg.type !== 'done') return
    this.send(run.ws, msg)
  }

  emit(run, event) {
    this.runSend(run, { type: 'event', runId: run.runId, event })
  }

  flushRun(run) {
    this.clearTimer(run.flushTimer)
    run.flushTimer = null
    if (run.think) {
      this.emit(run, { type: 'thinking', text: run.think })
      run.think = ''
    }
    if (run.text) {
      this.emit(run, { type: 'text', text: run.text })
      run.text = ''
    }
  }

  schedFlush(run) {
    if (run.flushTimer) return
    run.flushTimer = this.setTimer(() => {
      run.flushTimer = null
      this.flushRun(run)
    }, this.textBatchMs)
  }

  done(run, ok, error) {
    if (run.finished) return
    this.flushRun(run)
    run.finished = true
    this.clearTimer(run.flushTimer)
    this.clearTimer(run.cancelTimer)
    run.flushTimer = run.cancelTimer = null
    this.log(`run ${run.runId} end ok=${ok}${error ? ` error=${String(error).slice(0, 200)}` : ''}`)
    void this.finishRun(run, ok, error)
  }

  /**
   * Runs after `done` (the run is finished but still registered, so its session stays busy):
   * changes, final agents, the done frame, and only then the unregister.
   */
  async finishRun(run, ok, error) {
    let warning
    try {
      if (run.cp?.ok) {
        const res = await this.computeRunChanges(run)
        if (!res) warning = 'changes could not be computed'
        this.send(run.ws, {
          type: 'changes',
          requestId: run.runId,
          changes: res?.changes ?? [],
          ...(res?.truncated ? { truncated: true } : {}),
        })
      } else if (run.cp) {
        warning = run.cp.unavailable
        this.send(run.ws, { type: 'changes', requestId: run.runId, changes: [] })
      }
      const agents = this.tracker.agentsFor(run.runId)
      if (agents.length) this.flushAgents(run.runId, agents, run.ws)
    } catch (e) {
      this.log(`run ${run.runId} finish failed: ${errMsg(e)}`)
    }
    try {
      this.send(run.ws, {
        type: 'done',
        runId: run.runId,
        ok,
        sessionId: run.sessionId,
        ...(error ? { error: String(error) } : {}),
        ...(warning ? { warning: String(warning) } : {}),
      })
    } finally {
      this.unregister(run)
    }
    if (!this.stopped && this.ws === run.ws && this.tracker.hasRunning(run.runId)) {
      const timer = this.setTimer(() => this.endLinger(run.runId), LINGER_MS)
      this.lingering.set(run.runId, { ws: run.ws, timer })
      this.lingerBySession.set(run.sessionId, run.runId)
    } else {
      this.tracker.forget(run.runId)
    }
  }

  /** The changes of a run against its checkpoint, or null when they could not be computed in time. */
  async computeRunChanges(run) {
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), CHANGES_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      return await Promise.race([computeChanges(run.cwd, run.cp.checkpoint.tree), timeout])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Working directory of a run's session. Never throws. */
  async sessionCwd(sessionId, created) {
    const fallback = this.cfg.cwd ?? process.cwd()
    if (created) return fallback
    try {
      const { meta } = await this.host.inspect(sessionId)
      return typeof meta?.cwd === 'string' && meta.cwd ? meta.cwd : fallback
    } catch {
      return fallback
    }
  }

  /** Folders OmniChat may start a session in: the configured cwd, folders of mirrored sessions and of earlier runs; most recent first. */
  knownWorkspaces() {
    const out = []
    const seen = new Set()
    const add = (p) => {
      if (!isSafeCwd(p)) return
      const k = normCwd(p)
      if (seen.has(k)) return
      seen.add(k)
      out.push(p)
    }
    if (this.cfg.cwd) add(this.cfg.cwd)
    const sessions = [...this.mstate.models.values()].filter((m) => m.hasHuman && m.cwd && this.mstate.inScope(m.cwd))
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    for (const m of sessions) add(m.cwd)
    for (const c of this.knownCwds) add(c)
    return out.slice(0, MAX_WORKSPACES)
  }

  workspacesPayload() {
    return { workspaces: this.knownWorkspaces(), allowAnyCwd: this.cfg.allowAnyCwd === true }
  }

  /** Sends the workspaces list when it changed (after mirror snapshots / deltas and runs). */
  syncWorkspaces() {
    const ws = this.ws
    if (!ws || ws.readyState !== OPEN || !this.lastWorkspacesJson) return
    const payload = this.workspacesPayload()
    const json = JSON.stringify(payload)
    if (json === this.lastWorkspacesJson) return
    this.lastWorkspacesJson = json
    this.send(ws, { type: 'workspaces', ...payload })
  }

  /** May a new session be started in `cwd`? Shape is always checked; then it must be a known workspace unless `allowAnyCwd` is on. */
  cwdAllowed(cwd) {
    if (!isSafeCwd(cwd)) return false
    if (this.cfg.allowAnyCwd === true) return true
    const want = normCwd(cwd)
    return this.knownWorkspaces().some((w) => normCwd(w) === want)
  }

  async handleRun(ws, runId, sessionId, prompt, model, reqCwd) {
    if (this.runs.has(runId)) return
    const fail = (error, sid = sessionId) => this.send(ws, { type: 'done', runId, ok: false, sessionId: sid, error })
    if (sessionId && (this.bySession.has(sessionId) || this.host.isRunning(sessionId))) return fail('session busy in dsh')
    if (this.rewinding) return fail('a rewind is in progress')
    if (!sessionId && reqCwd !== undefined && !this.cwdAllowed(reqCwd)) {
      this.log(`run ${runId} refused: cwd not allowed`)
      return fail('cwd not allowed')
    }
    const run = {
      runId,
      ws,
      sessionId,
      claimed: false,
      turn: null,
      curTurn: 0,
      cancelled: false,
      finished: false,
      text: '',
      think: '',
      finalText: '',
      hadText: false,
      hadThink: false,
      flushTimer: null,
      cancelTimer: null,
    }
    this.log(`run ${runId} start (${sessionId ? 'resume' : 'new session'}, ${prompt.length} chars${model ? `, model ${model}` : ''})`)
    this.rememberOwn(runId)
    let created = false
    let startCwd
    try {
      if (!sessionId) {
        startCwd = reqCwd ?? this.cfg.cwd ?? this.mstate.recentCwd([process.cwd()])
        sessionId = await this.host.create(startCwd)
        if (!sessionId) throw new Error('session.create returned no sessionId')
        created = true
        run.sessionId = sessionId
      }
      if (this.bySession.has(sessionId)) return fail('session busy in dsh')
      this.runs.set(runId, run)
      this.bySession.set(sessionId, run)
      const cwd = created && startCwd ? startCwd : await this.sessionCwd(sessionId, created)
      run.cwd = cwd
      this.knownCwds.add(cwd)
      this.syncWorkspaces()
      run.cp = await createCheckpoint(cwd)
      if (run.finished) return
      if (run.cp.ok) {
        const { checkpointId, ref, createdAt, dirty } = run.cp.checkpoint
        this.send(run.ws, { type: 'checkpoint', requestId: runId, checkpointId, ref, createdAt, dirty })
      } else {
        this.send(run.ws, { type: 'checkpoint', requestId: runId, unavailable: run.cp.unavailable })
      }
      this.emit(run, { type: 'session', sessionId, cwd })
      if (model) await this.applyModel(sessionId, model, created)
      if (run.cancelled) return this.done(run, false, 'cancelled')
      await this.host.prompt(sessionId, runId, prompt)
      if (run.cancelled && !run.finished) void this.cancelRun(run)
    } catch (e) {
      if (run.finished) return
      if (this.runs.has(runId)) this.done(run, false, errMsg(e))
      else fail(errMsg(e), sessionId)
    }
  }

  /** selectModel is session-local but also overwrites the GUI default model: restore it afterwards. */
  async applyModel(sessionId, modelRef, isNew) {
    let ref = parseModelRef(modelRef)
    if (!ref) {
      const hit = this.models.find((m) => m.id === modelRef)
      if (!hit) return this.log('model ignored: unknown model id')
      ref = { provider: hit.provider, model: hit.id }
    }
    if (!this.host.canSelectModel()) return this.host.warnOnce('selectModel', 'sessionController.selectModel is missing: per-run model selection is skipped')
    const orig = this.host.defaultSelection()
    const same = orig && orig.provider === ref.provider && orig.model === ref.model
    if (same && isNew) return // a fresh session already starts on the default model
    await this.host.selectModel(sessionId, ref.provider, ref.model)
    if (orig && !same) {
      try {
        await this.host.saveDefault(orig)
      } catch (e) {
        this.log(`could not restore the default model: ${errMsg(e)}`)
      }
    } else if (!orig) {
      this.host.warnOnce('defaultModel', 'agentDefaultModel is unavailable: the dsh default model may have changed to the selected one')
    }
  }

  async cancelRun(run) {
    if (run.finished) return
    run.cancelled = true
    if (!run.cancelTimer) run.cancelTimer = this.setTimer(() => this.done(run, false, 'cancelled'), this.cancelGraceMs)
    try {
      await this.host.cancel(run.sessionId)
    } catch (e) {
      this.log(`cancel: ${errMsg(e)}`)
      this.done(run, false, 'cancelled')
    }
  }

  // ------------------------------------------------------------------ dsh events

  onSessionEvent(session, ev) {
    const sid = session?.id
    if (!sid || !ev || typeof ev !== 'object') return
    const run = this.bySession.get(sid)
    if (run) {
      try {
        this.runEvent(run, ev)
      } catch (e) {
        this.log(`run event error: ${errMsg(e)}`)
      }
    }
    try {
      if (ev.type === 'tool/call') this.rememberCall(sid, ev.data)
      this.tracker.onEvent(session, ev)
    } catch (e) {
      this.log(`subagent event error: ${errMsg(e)}`)
    }
    try {
      this.mirrorEvent(session, ev)
    } catch (e) {
      this.log(`mirror event error: ${errMsg(e)}`)
    }
  }

  /** Remembers a tool call's name and arguments so an approval request can show what it is about. */
  rememberCall(sid, d) {
    if (d?.callId === undefined || d?.callId === null) return
    const key = `${sid}:${d.callId}`
    this.calls.delete(key)
    this.calls.set(key, { name: d.name, arguments: d.arguments })
    if (this.calls.size > CALLS_MAX) this.calls.delete(this.calls.keys().next().value)
  }

  // ------------------------------------------------------------------ sub-agents

  /** Tracker changes: debounced, one pending frame per run. A lingering run whose children all ended is closed here. */
  sendAgents(runId, agents) {
    if (this.lingering.has(runId) && !this.tracker.hasRunning(runId)) return this.endLinger(runId)
    this.pendingAgents.set(runId, agents)
    if (this.agentTimers.has(runId)) return
    const t = this.setTimer(() => {
      this.agentTimers.delete(runId)
      this.flushAgents(runId, this.pendingAgents.get(runId))
    }, AGENTS_DEBOUNCE_MS)
    this.agentTimers.set(runId, t)
  }

  /** Sends an agents frame now (drops any pending debounced one for the run). Silently skipped when not connected. */
  flushAgents(runId, agents, ws) {
    const t = this.agentTimers.get(runId)
    if (t) {
      this.clearTimer(t)
      this.agentTimers.delete(runId)
    }
    this.pendingAgents.delete(runId)
    const target = ws ?? this.runs.get(runId)?.ws ?? this.lingering.get(runId)?.ws
    if (!target || !agents) return
    this.send(target, { type: 'agents', requestId: runId, agents })
  }

  endLinger(runId) {
    const l = this.lingering.get(runId)
    if (!l) return
    this.clearTimer(l.timer)
    this.lingering.delete(runId)
    for (const [sid, rid] of [...this.lingerBySession]) if (rid === runId) this.lingerBySession.delete(sid)
    this.flushAgents(runId, this.tracker.agentsFor(runId), l.ws)
    this.tracker.forget(runId)
  }

  /** Drops all sub-agent bookkeeping (connection lost or plugin stopped). */
  resetAgents() {
    for (const t of this.agentTimers.values()) this.clearTimer(t)
    this.agentTimers.clear()
    this.pendingAgents.clear()
    for (const [runId, l] of this.lingering) {
      this.clearTimer(l.timer)
      this.tracker.forget(runId)
    }
    this.lingering.clear()
    this.lingerBySession.clear()
  }

  // ------------------------------------------------------------------ rewind

  isKnownCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd) return false
    const norm = (p) => {
      const r = path.resolve(p)
      return process.platform === 'win32' ? r.toLowerCase() : r
    }
    const want = norm(cwd)
    if (want === norm(this.cfg.cwd ?? process.cwd())) return true
    for (const k of this.knownCwds) if (norm(k) === want) return true
    return false
  }

  async handleRewind(ws, m) {
    const reply = (fields) => this.send(ws, { type: 'rewound', requestId: m.requestId, ...fields })
    try {
      if (this.runs.size > 0 || this.rewinding) return reply({ ok: false, error: 'a run is in progress' })
      if (!this.isKnownCwd(m.cwd)) return reply({ ok: false, error: 'cwd is not a known working directory' })
      if (typeof m.ref !== 'string') return reply({ ok: false, error: 'invalid ref' })
      this.rewinding = true
      let r
      try {
        r = await rewindTo(m.cwd, m.ref, { removeNew: m.removeNew === true })
      } finally {
        this.rewinding = false
      }
      const fields = { ok: r?.ok === true }
      for (const k of ['error', 'restored', 'removed', 'backupRef']) if (r?.[k] !== undefined) fields[k] = r[k]
      reply(fields)
    } catch (e) {
      this.rewinding = false
      reply({ ok: false, error: errMsg(e) })
    }
  }

  /** Read-only preview access (`fs`). Runs even while a run is in progress; the bridge enforces every limit. */
  handleFs(ws, m) {
    const reply = (fields) => this.send(ws, { type: 'fs_result', requestId: m.requestId, ...fields })
    if (!this.previewFs) return reply({ ok: false, error: 'preview is disabled on this bridge' })
    const release = this.fsLimiter.admit()
    if (!release) return reply({ ok: false, error: 'too many requests' })
    try {
      if (!this.isKnownCwd(m.cwd)) return reply({ ok: false, error: 'cwd is not a known working directory' })
      const op = m.op === 'list' || m.op === 'read' ? m.op : null
      if (!op) return reply({ ok: false, error: 'invalid op' })
      const p = m.path === undefined ? '' : m.path
      const r = op === 'list' ? listDir(m.cwd, p) : readFile(m.cwd, p, m.maxBytes)
      const shown = typeof p === 'string' ? p.slice(0, 200) : ''
      this.log(`fs ${op} ${shown}: ${r.ok ? 'ok' : r.error}`)
      reply({ ...r })
    } catch {
      reply({ ok: false, error: 'read failed' })
    } finally {
      release()
    }
  }

  runEvent(run, ev) {
    const d = ev.data ?? {}
    switch (ev.type) {
      case 'turn/start':
        if (typeof d.turn === 'number') run.curTurn = d.turn
        break
      case 'user/message':
        if (!run.claimed && d.source?.kind === 'user' && d.source.rpcId === run.runId) {
          run.claimed = true
          run.turn = run.curTurn
          this.emit(run, { type: 'status', phase: 'turn_start', turn: run.turn })
        }
        break
      case 'assistant/message': {
        if (!run.claimed || d.turn !== run.turn) break
        const parts = Array.isArray(d.message?.content) ? d.message.content : []
        for (const c of parts) {
          if (!c || typeof c.text !== 'string') continue
          if (c.type === 'text') {
            run.finalText += c.text
            if (!run.hadText) {
              run.text += c.text
              this.schedFlush(run)
            }
          } else if (c.type === 'reasoning' && !run.hadThink) {
            run.think += c.text
            this.schedFlush(run)
          }
        }
        break
      }
      case 'tool/call':
        if (!run.claimed || d.turn !== run.turn) break
        this.flushRun(run)
        this.emit(run, { type: 'tool_call', callId: d.callId, tool: d.name, input: parseJson(d.arguments) })
        break
      case 'tool/result': {
        if (!run.claimed || d.turn !== run.turn) break
        this.flushRun(run)
        const text = textOf(d.message?.content)
        const failed = !!d.error || text.startsWith('Error')
        this.emit(run, {
          type: 'tool_result',
          callId: d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId,
          status: failed ? 'error' : 'completed',
          result: text || (typeof d.error === 'string' ? d.error : ''),
        })
        break
      }
      case 'turn/end': {
        if (!run.claimed || d.turn !== run.turn) break
        this.flushRun(run)
        const reason = d.reason ?? { kind: 'completed' }
        this.emit(run, { type: 'status', phase: 'turn_end', turn: run.turn, reason })
        if (run.finalText) this.emit(run, { type: 'final', text: run.finalText })
        const kind = String(reason.kind ?? 'completed')
        if (run.cancelled) this.done(run, false, 'cancelled')
        else if (kind === 'completed') this.done(run, true)
        else if (kind === 'error') this.done(run, false, reason.error?.message || 'dsh turn failed')
        else this.done(run, false, `turn ended: ${kind}`)
        break
      }
      default:
        break
    }
  }

  onStream(arg) {
    const agent = arg?.agent
    const frame = arg?.frame
    const sid = agent?.id ?? agent?.session?.id
    if (!sid || !frame) return
    const run = this.bySession.get(sid)
    if (run && run.claimed && !run.finished) {
      if (frame.type === 'start') {
        run.hadText = false
        run.hadThink = false
      } else if (frame.type === 'chunk') {
        const c = frame.chunk
        if (c?.type === 'text-delta' && typeof c.text === 'string') {
          run.hadText = true
          run.text += c.text
          this.schedFlush(run)
        } else if (c?.type === 'reasoning-delta' && typeof c.text === 'string') {
          run.hadThink = true
          run.think += c.text
          this.schedFlush(run)
        }
      }
      return
    }
    if (!this.mirrorEnabled) return
    const m = this.mstate.models.get(sid)
    if (!m || this.hydrating.has(sid)) return
    if (frame.type === 'start' || frame.type === 'end') m.setPending('')
    else if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
      m.setPending(m.pending + frame.chunk.text)
      this.mstate.markDirty(sid)
      this.scheduleFlush()
    }
  }

  // ------------------------------------------------------------------ mirror

  isOwn = (rpcId) => typeof rpcId === 'string' && this.ownIds.has(rpcId)

  mirrorEvent(session, ev) {
    if (!this.mirrorEnabled) return
    const sid = session.id
    const hdr = session.header ?? {}
    if (hdr.origin === 'subagent') return
    const model = this.mstate.models.get(sid)
    if (model && !this.hydrating.has(sid)) {
      if (model.add(ev, this.isOwn)) {
        this.mstate.markDirty(sid)
        this.scheduleFlush()
      }
      return
    }
    let h = this.hydrating.get(sid)
    if (!h) h = this.startHydrate(sid, hdr.cwd)
    h.buf.push(ev)
  }

  startHydrate(sid, cwd) {
    const h = { buf: [], p: null }
    this.hydrating.set(sid, h)
    h.p = (async () => {
      const m = new SessionModel(sid, cwd)
      try {
        const { meta, events } = await this.host.inspect(sid)
        if (typeof meta?.cwd === 'string') m.cwd = meta.cwd
        for (const ev of events) m.add(ev, this.isOwn)
      } catch (e) {
        this.log(`mirror: cannot read session history: ${errMsg(e)}`)
      }
      this.mstate.models.set(sid, m)
      this.hydrating.delete(sid)
      let changed = false
      for (const ev of h.buf) changed = m.add(ev, this.isOwn) || changed
      if (changed) {
        this.mstate.markDirty(sid)
        this.scheduleFlush()
      }
      return m
    })()
    return h
  }

  ensureModel(sid, cwd) {
    const m = this.mstate.models.get(sid)
    if (m && !this.hydrating.has(sid)) return Promise.resolve(m)
    return (this.hydrating.get(sid) ?? this.startHydrate(sid, cwd)).p
  }

  scheduleFlush() {
    if (this.flushTimer) return
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = null
      this.flushMirror()
    }, this.mirrorFlushMs)
  }

  flushMirror() {
    const ws = this.ws
    if (!this.mirrorReady || !ws || ws.readyState !== OPEN) return
    const frame = this.mstate.poll()
    if (frame) this.send(ws, frame)
    this.syncWorkspaces()
  }

  async sendFull(ws) {
    this.mirrorReady = false
    const items = (await this.host.list())
      .filter((i) => i && typeof i.sessionId === 'string' && !i.blank && i.origin !== 'subagent' && this.mstate.inScope(i.cwd))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, this.mstate.maxFull)
    const models = []
    for (const it of items) {
      if (this.ws !== ws) return
      models.push(await this.ensureModel(it.sessionId, it.cwd))
    }
    if (this.ws !== ws) return
    for (const m of models) if (!m.cwd) m.cwd = items.find((i) => i.sessionId === m.sessionId)?.cwd ?? ''
    this.send(ws, this.mstate.full(models))
    this.mirrorReady = true
    this.syncWorkspaces()
    this.scheduleFlush()
  }
}
