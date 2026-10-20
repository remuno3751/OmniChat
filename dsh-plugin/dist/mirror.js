import { textOf, toolCallMd, toolFailMd, normCwd } from './wire.js'

const MAX_MESSAGES = 300
const MAX_FULL_SESSIONS = 30

function sig(m) {
  return `${m.status}\u0000${m.text}`
}

/**
 * In-memory model of one dsh session built from its durable events (same output as the
 * daemon's log-based SessionModel: keys u:<turn>:<k> / a:<turn>, one assistant message per turn).
 */
export class SessionModel {
  constructor(sessionId, cwd) {
    this.sessionId = sessionId
    this.cwd = cwd || ''
    this.title = null
    this.updatedAt = 0
    this.lastSeq = -1
    this.curTurn = 0
    this.order = 0
    this.users = new Map()
    this.userIds = new Set()
    this.userCount = new Map()
    this.turns = new Map()
    this.calls = new Map()
    this.ownUsers = new Set()
    this.ownTurns = new Set()
    this.pending = ''
  }

  get hasHuman() {
    return this.users.size > 0
  }

  turnAgg(turn, time) {
    let t = this.turns.get(turn)
    if (!t) {
      t = { turn, createdAt: time, order: this.order++, text: '', end: null }
      this.turns.set(turn, t)
    }
    return t
  }

  /** Feed one durable event. `isOwn(rpcId)` tells whether a user message belongs to one of our runs. Returns true if it changed anything. */
  add(ev, isOwn = () => false) {
    if (!ev || typeof ev !== 'object') return false
    if (typeof ev.seq === 'number') {
      if (ev.seq <= this.lastSeq) return false
      this.lastSeq = ev.seq
    }
    const d = ev.data ?? {}
    const time = typeof ev.time === 'number' ? ev.time : Date.now()
    if (time > this.updatedAt) this.updatedAt = time
    switch (ev.type) {
      case 'turn/start':
        if (typeof d.turn === 'number') this.curTurn = d.turn
        this.pending = ''
        return false
      case 'turn/end': {
        if (typeof d.turn !== 'number') return false
        const kind = String(d.reason?.kind ?? 'completed')
        const t = this.turnAgg(d.turn, time)
        t.end = kind === 'completed' ? 'done' : kind === 'error' ? 'error' : 'stopped'
        t.errorMessage = d.reason?.error?.message
        t.endKind = kind
        this.pending = ''
        return true
      }
      case 'user/message': {
        if (d.source?.kind !== 'user' || (d.role !== undefined && d.role !== 'user')) return false
        const id = typeof d.id === 'string' ? d.id : null
        if (id && this.userIds.has(id)) return false
        if (id) this.userIds.add(id)
        const k = this.userCount.get(this.curTurn) ?? 0
        this.userCount.set(this.curTurn, k + 1)
        const key = `u:${this.curTurn}:${k}`
        this.users.set(key, { key, role: 'user', text: textOf(d.content), createdAt: time, status: 'done', order: this.order++ })
        if (d.source?.rpcId !== undefined && isOwn(d.source.rpcId)) {
          this.ownUsers.add(key)
          this.ownTurns.add(this.curTurn)
        }
        return true
      }
      case 'assistant/message': {
        if (typeof d.turn !== 'number') return false
        const t = this.turnAgg(d.turn, time)
        this.pending = ''
        const content = d.message?.content
        if (Array.isArray(content)) for (const c of content) if (c && c.type === 'text' && typeof c.text === 'string') t.text += c.text
        return true
      }
      case 'tool/call': {
        if (typeof d.turn !== 'number') return false
        const t = this.turnAgg(d.turn, time)
        const name = String(d.name ?? 'tool')
        if (typeof d.callId === 'string') this.calls.set(d.callId, name)
        this.pending = ''
        t.text += toolCallMd(name, d.arguments)
        return true
      }
      case 'tool/result': {
        if (typeof d.turn !== 'number') return false
        const t = this.turnAgg(d.turn, time)
        const text = textOf(d.message?.content)
        if (d.error || text.startsWith('Error')) {
          const callId = d.callId ?? d.message?.toolCallId ?? d.message?.source?.callId
          const name = (typeof callId === 'string' && this.calls.get(callId)) || 'tool'
          t.text += toolFailMd(name, text || (typeof d.error === 'string' ? d.error : 'error'))
          return true
        }
        return false
      }
      case 'session/title':
        if (typeof d.title === 'string' && d.title !== this.title) {
          this.title = d.title
          return true
        }
        return false
      default:
        return false
    }
  }

  /** Live (not yet durable) assistant text of the current attempt. */
  setPending(text) {
    this.pending = text
    if (text) this.turnAgg(this.curTurn, Date.now())
  }

  messages({ includeOwn = false } = {}) {
    const all = []
    for (const m of this.users.values()) if (includeOwn || !this.ownUsers.has(m.key)) all.push(m)
    for (const t of this.turns.values()) {
      if (!includeOwn && this.ownTurns.has(t.turn)) continue
      const live = t.end === null && t.turn === this.curTurn ? this.pending : ''
      const text = t.text + live || (t.end === 'error' && t.errorMessage ? `⚠️ ${t.errorMessage}` : t.end === 'stopped' && t.endKind ? `⚠️ turn ended: ${t.endKind}` : '')
      if (!text) continue
      all.push({ key: `a:${t.turn}`, role: 'assistant', text, createdAt: t.createdAt, status: t.end ?? 'streaming', order: t.order })
    }
    all.sort((a, b) => a.order - b.order)
    return all.map((m) => ({ key: m.key, role: m.role, text: m.text, createdAt: m.createdAt, status: m.status }))
  }
}

/** Tracks what was already sent to the server so only changes go out as `full:false` deltas. */
export class MirrorState {
  constructor({ scope = 'all', cwd, maxMessages = MAX_MESSAGES, maxFull = MAX_FULL_SESSIONS } = {}) {
    this.scope = scope
    this.cwdNorm = normCwd(cwd || '')
    this.maxMessages = maxMessages
    this.maxFull = maxFull
    this.models = new Map()
    this.sent = new Map()
    this.dirty = new Set()
  }

  /**
   * The working folder of the session the user last typed in (in the dsh GUI), skipping the folders in `skip` (such as the plugin's own
   * profile folder). New OmniChat sessions start there instead of in a folder the GUI does not list. undefined when nothing qualifies.
   */
  recentCwd(skip = []) {
    const skipN = new Set(skip.map((c) => normCwd(c || '')))
    let best
    for (const m of this.models.values()) {
      if (!m.hasHuman || !m.cwd || skipN.has(normCwd(m.cwd))) continue
      if (!best || (m.updatedAt || 0) > (best.updatedAt || 0)) best = m
    }
    return best?.cwd
  }

  inScope(cwd) {
    if (this.scope === 'all') return true
    if (!this.cwdNorm) return true
    return normCwd(cwd) === this.cwdNorm
  }

  toSession(m, msgs) {
    return { sessionId: m.sessionId, cwd: m.cwd, title: m.title, updatedAt: m.updatedAt || Date.now(), messages: msgs }
  }

  markDirty(sessionId) {
    this.dirty.add(sessionId)
  }

  full(models) {
    this.sent.clear()
    this.dirty.clear()
    const list = models
      .filter((m) => m.hasHuman && this.inScope(m.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxFull)
    const sessions = []
    for (const m of list) {
      const msgs = m.messages().slice(-this.maxMessages)
      this.sent.set(m.sessionId, { title: m.title, msgs: new Map(msgs.map((x) => [x.key, sig(x)])) })
      sessions.push(this.toSession(m, msgs))
    }
    return { type: 'sessions', full: true, sessions }
  }

  poll() {
    const sessions = []
    for (const id of this.dirty) {
      const m = this.models.get(id)
      if (!m || !m.hasHuman || !this.inScope(m.cwd)) continue
      const prev = this.sent.get(id)
      const msgs = m.messages().slice(-this.maxMessages)
      const changed = msgs.filter((x) => prev?.msgs.get(x.key) !== sig(x))
      const titleChanged = !prev || prev.title !== m.title
      if (!changed.length && !titleChanged) continue
      const rec = prev ?? { title: null, msgs: new Map() }
      rec.title = m.title
      for (const x of changed) rec.msgs.set(x.key, sig(x))
      this.sent.set(id, rec)
      sessions.push(this.toSession(m, changed))
    }
    this.dirty.clear()
    return sessions.length ? { type: 'sessions', full: false, sessions } : null
  }
}
