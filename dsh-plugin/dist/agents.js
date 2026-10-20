// Tracks dsh sub-agents (separate sessions whose header has origin 'subagent') for the OmniChat run that owns them.
// Pure state machine: no I/O, no timers. The caller feeds it session events and cordis subagent events.

const MAX_AGENTS = 50
const SUMMARY_MAX = 500
const ROLE_MAX = 120
const ARGS_MAX = 120
const FAIL_MAX = 120
const PENDING_MAX = 256
const TRUNC = '... [earlier output truncated]\n'

const byteLen = (s) => Buffer.byteLength(s, 'utf8')

/** Cut a string to n UTF-16 units without leaving a lone high surrogate at the end. */
function cut(s, n) {
  if (typeof s !== 'string') return undefined
  if (s.length <= n) return s
  let out = s.slice(0, n)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/** Non-empty text parts of a content array, in order. */
function texts(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '')
    .map((p) => p.text)
}

/** Newest `budget` bytes of s, starting on a character boundary and, when possible, after a newline. */
function tailBytes(s, budget) {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= budget) return s
  let start = buf.length - budget
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
  let tail = buf.subarray(start).toString('utf8')
  const nl = tail.indexOf('\n')
  if (nl !== -1 && nl < tail.length - 1) tail = tail.slice(nl + 1)
  return tail
}

export class SubagentTracker {
  constructor({ resolveRun, onChange, now = Date.now, logCapBytes = 64 * 1024 } = {}) {
    this.resolveRun = resolveRun
    this.onChange = onChange
    this.now = now
    this.logCap = logCapBytes
    this.records = new Map() // child session id -> record (internal, includes runId and parentId)
    this.pending = new Set() // child ids seen in subagent/start that have no session event yet
    this.labels = new Map() // child id -> label from the parent's subagent/catalog event
  }

  // ------------------------------------------------------------------ public API

  /** Feed every session/event of every session. */
  onEvent(session, ev) {
    try {
      const header = session?.header
      if (typeof session?.id !== 'string') return
      if (ev?.type === 'subagent/catalog') return this.onCatalog(ev)
      if (header?.origin !== 'subagent' || !header.parentSession) return
      this.pending.delete(session.id)

      let rec = this.records.get(session.id)
      let changed = false
      if (!rec) {
        const runId = this.ownerOf(header.parentSession)
        if (!runId) return
        if (this.countRun(runId) >= MAX_AGENTS) return
        rec = {
          id: session.id,
          parentId: header.parentSession,
          runId,
          role: this.labels.get(session.id) ?? 'subagent',
          status: 'running',
          startedAt: header.createdAt ?? ev?.time ?? this.now(),
          endedAt: null,
          summary: undefined,
          log: '',
        }
        this.records.set(session.id, rec)
        changed = true
      }
      changed = this.apply(rec, ev) || changed
      if (changed) this.emit(rec.runId)
    } catch {
      // never throw into dsh
    }
  }

  /** The parent session's `subagent/catalog` fact carries the child's label (the child's own descriptor may be missed). */
  onCatalog(ev) {
    const d = ev?.data
    const id = d?.childId
    const label = typeof d?.label === 'string' ? cut(d.label.trim(), ROLE_MAX) : ''
    if (typeof id !== 'string' || !label) return
    if (this.labels.size >= PENDING_MAX) this.labels.delete(this.labels.keys().next().value)
    this.labels.set(id, label)
    const rec = this.records.get(id)
    if (rec && rec.role !== label) {
      rec.role = label
      this.emit(rec.runId)
    }
  }

  /** 'subagent/start' cordis event. The child has no session object here, so it is only remembered. */
  onStart(info) {
    try {
      const id = info?.id
      if (typeof id !== 'string' || this.records.has(id)) return
      if (this.pending.size >= PENDING_MAX) this.pending.delete(this.pending.values().next().value)
      this.pending.add(id)
    } catch {
      // ignore
    }
  }

  /** 'subagent/end' cordis event. */
  onEnd(info) {
    try {
      const id = info?.id
      if (typeof id !== 'string') return
      this.pending.delete(id)
      const rec = this.records.get(id)
      if (!rec) return

      const status = info.stopReason === 'completed' ? 'done' : 'error'
      let changed = rec.status !== status
      rec.status = status

      const last = cut(texts(info.lastAssistantMessage).join('\n\n').trim(), SUMMARY_MAX)
      if (last && last !== rec.summary) {
        rec.summary = last
        changed = true
      }
      rec.endedAt = this.now()
      if (changed) this.emit(rec.runId)
    } catch {
      // ignore
    }
  }

  /** Copies of the agents of one run, in start order. */
  agentsFor(runId) {
    const out = []
    for (const rec of this.records.values()) if (rec.runId === runId) out.push(copy(rec))
    return out
  }

  hasRunning(runId) {
    for (const rec of this.records.values()) if (rec.runId === runId && rec.status === 'running') return true
    return false
  }

  /** Drop all agents of a run and their child-session mapping. */
  forget(runId) {
    try {
      for (const [id, rec] of this.records) {
        if (rec.runId !== runId) continue
        this.records.delete(id)
        this.labels.delete(id)
      }
    } catch {
      // ignore
    }
  }

  // ------------------------------------------------------------------ internals

  ownerOf(parentId) {
    const parent = this.records.get(parentId)
    if (parent) return parent.runId
    try {
      const run = this.resolveRun?.(parentId)
      return typeof run === 'string' && run ? run : undefined
    } catch {
      return undefined
    }
  }

  countRun(runId) {
    let n = 0
    for (const rec of this.records.values()) if (rec.runId === runId) n++
    return n
  }

  emit(runId) {
    if (typeof this.onChange !== 'function') return
    try {
      this.onChange(runId, this.agentsFor(runId))
    } catch {
      // a broken listener must not break the tracker
    }
  }

  /** Apply one session event to a record. Returns true when a reported field changed. */
  apply(rec, ev) {
    const data = ev?.data ?? {}
    switch (ev?.type) {
      case 'subagent/descriptor': {
        const label = typeof data.label === 'string' ? data.label.trim() : ''
        const role = label ? cut(label, ROLE_MAX) : undefined
        if (role && role !== rec.role) {
          rec.role = role
          return true
        }
        return false
      }
      case 'turn/start': {
        rec.endedAt = null
        const changed = rec.status !== 'running'
        rec.status = 'running'
        return changed
      }
      case 'turn/end': {
        const reason = data.reason ?? {}
        const status = reason.kind === 'completed' ? 'done' : 'error'
        let changed = rec.status !== status
        rec.status = status
        if (status === 'error') {
          const s = cut(String(reason.error?.message ?? reason.kind ?? 'error'), SUMMARY_MAX)
          if (s !== rec.summary) {
            rec.summary = s
            changed = true
          }
        }
        rec.endedAt = ev.time ?? this.now()
        return changed
      }
      case 'assistant/message': {
        const parts = texts(data.message?.content)
        if (parts.length === 0) return false
        for (const t of parts) this.appendLog(rec, t.trim(), '\n\n')
        const s = cut(parts.join('\n\n').trim(), SUMMARY_MAX)
        if (s) rec.summary = s
        return true // the log always grows here
      }
      case 'tool/call': {
        const name = String(data.name ?? '?')
        const raw = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? '') ?? ''
        const args = cut(raw, ARGS_MAX)
        this.appendLog(rec, `> tool ${name}${args ? ' ' + args : ''}`, '\n')
        return true
      }
      case 'tool/result': {
        const text = texts(data.message?.content)[0] ?? ''
        const errText = typeof data.error?.message === 'string' ? data.error.message : ''
        if (!data.error && !text.startsWith('Error')) return false
        this.appendLog(rec, `> failed: ${cut(text || errText || 'error', FAIL_MAX)}`, '\n')
        return true
      }
      default:
        return false
    }
  }

  /** Append a piece to the bounded log, keeping the newest bytes and a truncation marker. */
  appendLog(rec, piece, sep) {
    const cur = rec.log ?? ''
    const truncated = cur.startsWith(TRUNC)
    const body = truncated ? cur.slice(TRUNC.length) : cur
    const joined = body === '' ? piece : body + sep + piece
    const prefix = truncated ? TRUNC : ''
    if (byteLen(prefix + joined) <= this.logCap) {
      rec.log = prefix + joined
      return
    }
    const budget = this.logCap - byteLen(TRUNC)
    rec.log = budget > 0 ? TRUNC + tailBytes(joined, budget) : ''
  }
}

function copy(rec) {
  const out = {
    id: rec.id,
    role: rec.role,
    status: rec.status,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
  }
  if (rec.summary !== undefined) out.summary = rec.summary
  if (rec.log) out.log = rec.log
  return out
}
