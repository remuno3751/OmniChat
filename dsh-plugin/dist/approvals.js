/**
 * Tool-approval brokering for runs started from OmniChat. The plugin forwards dsh's `approval/request`
 * to the server as an `approval` frame and settles it when the server answers with `approval_reply`.
 */

const COMMAND_KEYS = ['command', 'cmd', 'script', 'code', 'commandLine']
const PATH_KEYS = ['file_path', 'filePath', 'path', 'filename', 'target', 'destination']
const COMMAND_MAX = 2000
const PATH_MAX = 1000
const REASON_MAX = 500

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
const firstOf = (args, keys) => {
  for (const k of keys) if (nonEmpty(args[k])) return args[k]
  return undefined
}

/** Extracts the command and/or path a tool call operates on, for display to the approver. */
export function describeCall(toolName, args) {
  let parsed = args
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = undefined
    }
  }
  const out = {}
  if (!isObj(parsed)) return out
  const command = firstOf(parsed, COMMAND_KEYS)
  const path = firstOf(parsed, PATH_KEYS)
  if (command !== undefined) out.command = command.slice(0, COMMAND_MAX)
  if (path !== undefined) out.path = path.slice(0, PATH_MAX)
  return out
}

const dropUndefined = (o) => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

export class ApprovalBroker {
  constructor({ send, timeoutMs = 600000, genId = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.send = send
    this.timeoutMs = timeoutMs
    this.genId = genId
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.pending = new Map() // approvalId -> entry
  }

  /**
   * Asks the server about one approval. Always resolves to 'allowed-once' | 'rejected' | 'cancelled'.
   * `call` is the optional `{name, arguments}` of the matching tool call, used for command/path display.
   */
  request({ requestId, req, call } = {}) {
    try {
      return this._request(requestId, req ?? {}, call)
    } catch {
      return Promise.resolve('rejected')
    }
  }

  _request(requestId, req, call) {
    const signal = req.signal
    if (signal?.aborted) return Promise.resolve('cancelled')

    const approvalId = this.genId()
    const reasonRaw = req.reason ?? req.displayReason?.en
    const reason = typeof reasonRaw === 'string' ? reasonRaw.slice(0, REASON_MAX) : undefined
    const details = describeCall(call?.name ?? req.toolName, call?.arguments ?? undefined)
    const frame = dropUndefined({
      type: 'approval',
      requestId,
      approvalId,
      tool: req.toolName,
      command: details.command,
      path: details.path,
      reason,
    })

    let sent = false
    try {
      sent = this.send(frame) === true
    } catch {
      sent = false
    }
    if (!sent) return Promise.resolve('rejected')

    return new Promise((resolve) => {
      const entry = { requestId, done: false, timer: null, onAbort: null, settle: null }
      entry.settle = (outcome) => {
        if (entry.done) return
        entry.done = true
        this.pending.delete(approvalId)
        if (entry.timer !== null) this.clearTimer(entry.timer)
        if (entry.onAbort) signal.removeEventListener('abort', entry.onAbort)
        resolve(outcome)
      }
      this.pending.set(approvalId, entry)
      try {
        entry.timer = this.setTimer(() => entry.settle('rejected'), this.timeoutMs)
        if (signal) {
          entry.onAbort = () => entry.settle('cancelled')
          signal.addEventListener('abort', entry.onAbort, { once: true })
        }
      } catch {
        entry.settle('rejected')
      }
    })
  }

  /** Handles an `approval_reply` frame. Returns true when it matched a pending approval. */
  reply(msg) {
    if (!isObj(msg)) return false
    const entry = this.pending.get(msg.approvalId)
    if (!entry) return false
    entry.settle(msg.decision === 'allowed-once' ? 'allowed-once' : 'rejected')
    return true
  }

  /** Resolves every pending approval of one run as 'cancelled'. Returns how many were settled. */
  cancelRun(requestId) {
    return this._settleWhere((e) => e.requestId === requestId, 'cancelled')
  }

  /** Resolves every pending approval (e.g. connection lost). Returns how many were settled. */
  cancelAll(outcome = 'rejected') {
    return this._settleWhere(() => true, outcome)
  }

  pendingCount() {
    return this.pending.size
  }

  _settleWhere(pred, outcome) {
    const hits = [...this.pending.values()].filter(pred)
    for (const e of hits) e.settle(outcome)
    return hits.length
  }
}
