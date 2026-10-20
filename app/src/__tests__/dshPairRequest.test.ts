// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshPairRequest } from '../dshPairRequest'
import type { PairRequestOptions, PairRequestStatus, PairRequestTimers } from '../dshPairRequest'
import type { WsLike } from '../dshRelay'

class FakeWs implements WsLike {
  readyState = 0
  bufferedAmount = 0
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  readonly url: string
  private readonly handlers: Record<string, Array<(ev: any) => void>> = {}

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on closed socket')
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
    this.readyState = 3
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: any) => void): void {
    if (!this.handlers[type]) this.handlers[type] = []
    this.handlers[type].push(fn)
  }

  open(): void {
    this.readyState = 1
    this.fire('open', {})
  }

  message(data: string): void {
    this.fire('message', { data })
  }

  remoteClose(code: number): void {
    this.readyState = 3
    this.fire('close', { code })
  }

  error(): void {
    this.fire('error', {})
  }

  private fire(type: string, ev: unknown): void {
    for (const fn of this.handlers[type] ?? []) fn(ev)
  }
}

class FakeTimers implements PairRequestTimers {
  now = 0
  private seq = 0
  private readonly tasks = new Map<number, { at: number; fn: () => void }>()

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.tasks.set(id, { at: this.now + ms, fn })
    return id
  }

  clearTimeout(h: unknown): void {
    this.tasks.delete(h as number)
  }

  advance(ms: number): void {
    const end = this.now + ms
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      const first = due[0]
      if (!first) break
      this.tasks.delete(first[0])
      this.now = first[1].at
      first[1].fn()
    }
    this.now = end
  }
}

function harness(extra: Partial<PairRequestOptions> = {}) {
  const sockets: FakeWs[] = []
  const statuses: PairRequestStatus[] = []
  const approved: string[] = []
  const timers = new FakeTimers()
  const req = new DshPairRequest({
    port: 19401,
    clientName: 'OmniChat (test)',
    wsFactory: (url) => {
      const w = new FakeWs(url)
      sockets.push(w)
      return w
    },
    timers,
    now: () => timers.now,
    onChange: (s) => {
      statuses.push(s)
    },
    onApproved: (token) => {
      approved.push(token)
    },
    ...extra,
  })
  return { req, sockets, statuses, approved, timers }
}

const HELLO = '{"type":"hello","client":"omnichat-app","version":"app","pairRequest":true,"clientName":"OmniChat (test)"}'

// Starts the request and opens the socket; returns the socket.
function openSocket(h: ReturnType<typeof harness>): FakeWs {
  h.req.start()
  const ws = h.sockets[h.sockets.length - 1]
  ws.open()
  return ws
}

function pendingSocket(h: ReturnType<typeof harness>, sec = 60): FakeWs {
  const ws = openSocket(h)
  ws.message(JSON.stringify({ type: 'pair-pending', requestId: 'r1', expiresInSec: sec }))
  return ws
}

test('connects to the loopback bridge and sends the exact hello frame on open', () => {
  const h = harness()
  h.req.start()
  const ws = h.sockets[0]
  assert.equal(ws.url, 'ws://127.0.0.1:19401/omnichat-bridge')
  assert.equal(h.req.getStatus().state, 'connecting')
  assert.deepEqual(ws.sent, [])
  ws.open()
  assert.deepEqual(ws.sent, [HELLO])
})

test('start is idempotent: a second call opens no socket', () => {
  const h = harness()
  h.req.start()
  h.req.start()
  assert.equal(h.sockets.length, 1)
})

test('pair-pending moves to pending with expiresAt and cancels the hello timeout', () => {
  const h = harness()
  h.timers.now = 1000
  const ws = openSocket(h)
  ws.message('{"type":"pair-pending","requestId":"r1","expiresInSec":60}')
  const st = h.req.getStatus()
  assert.equal(st.state, 'pending')
  assert.equal(st.expiresAt, 1000 + 60000)
  assert.equal(st.error, undefined)
  h.timers.advance(30000)
  assert.equal(h.req.getStatus().state, 'pending')
  assert.equal(ws.closed, null)
})

test('a second pair-pending while pending is ignored', () => {
  const h = harness()
  const ws = pendingSocket(h, 60)
  const before = h.req.getStatus().expiresAt
  ws.message('{"type":"pair-pending","requestId":"r2","expiresInSec":5}')
  assert.equal(h.req.getStatus().expiresAt, before)
})

test('pair-approved calls onApproved exactly once, closes 1000 and never exposes the token', () => {
  const h = harness()
  const ws = pendingSocket(h)
  const token = 'SECRET-TOKEN-VALUE-123'
  ws.message(JSON.stringify({ type: 'pair-approved', pairing: token }))
  assert.deepEqual(h.approved, [token])
  assert.equal(h.req.getStatus().state, 'approved')
  assert.deepEqual(ws.closed, { code: 1000, reason: undefined })
  for (const s of h.statuses) {
    assert.equal(JSON.stringify(s).includes(token), false)
  }
  assert.equal(JSON.stringify(h.req.getStatus()).includes(token), false)
})

test('pair-approved with a token trims it and rejects values over 200 characters', () => {
  const h = harness()
  const ws = pendingSocket(h)
  ws.message(JSON.stringify({ type: 'pair-approved', pairing: '  tok  ' }))
  assert.deepEqual(h.approved, ['tok'])

  const h2 = harness()
  const ws2 = pendingSocket(h2)
  ws2.message(JSON.stringify({ type: 'pair-approved', pairing: 'x'.repeat(201) }))
  assert.equal(h2.req.getStatus().state, 'error')
  assert.equal(h2.req.getStatus().error, 'invalid')
  assert.deepEqual(h2.approved, [])
})

test('pair-denied with reason denied gives state denied', () => {
  const h = harness()
  const ws = pendingSocket(h)
  ws.message('{"type":"pair-denied","reason":"denied"}')
  assert.equal(h.req.getStatus().state, 'denied')
  assert.equal(h.req.getStatus().error, undefined)
  assert.deepEqual(h.approved, [])
})

test('pair-denied with reason expired gives state expired', () => {
  const h = harness()
  const ws = pendingSocket(h)
  ws.message('{"type":"pair-denied","reason":"expired"}')
  assert.equal(h.req.getStatus().state, 'expired')
})

test('pair-denied with reason invalidated gives state denied', () => {
  const h = harness()
  const ws = pendingSocket(h)
  ws.message('{"type":"pair-denied","reason":"invalidated"}')
  assert.equal(h.req.getStatus().state, 'denied')
})

test('expiry by frame: a terminal expired result is reported as expired', () => {
  const h = harness()
  const ws = pendingSocket(h, 60)
  ws.message('{"type":"pair-denied","reason":"expired"}')
  assert.equal(h.req.getStatus().state, 'expired')
  h.timers.advance(120000)
  assert.equal(h.req.getStatus().state, 'expired')
})

test('expiry by timer: expires at expiresInSec plus 5 s and closes the socket', () => {
  const h = harness()
  const ws = pendingSocket(h, 10)
  h.timers.advance(14999)
  assert.equal(h.req.getStatus().state, 'pending')
  h.timers.advance(1)
  assert.equal(h.req.getStatus().state, 'expired')
  assert.deepEqual(ws.closed, { code: 1000, reason: undefined })
})

test('close code 4403 maps to error origin', () => {
  const h = harness()
  openSocket(h).remoteClose(4403)
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'origin')
})

test('close code 4429 maps to error locked, also while pending', () => {
  const h = harness()
  pendingSocket(h).remoteClose(4429)
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'locked')
})

test('close code 4003 maps to error busy', () => {
  const h = harness()
  openSocket(h).remoteClose(4003)
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'busy')
})

test('close code 4002 maps to state denied', () => {
  const h = harness()
  pendingSocket(h).remoteClose(4002)
  assert.equal(h.req.getStatus().state, 'denied')
  assert.equal(h.req.getStatus().error, undefined)
})

test('other close codes and socket errors map to error unreachable', () => {
  const h = harness()
  openSocket(h).remoteClose(1006)
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'unreachable')

  const h2 = harness()
  h2.req.start()
  h2.sockets[0].error()
  assert.equal(h2.req.getStatus().error, 'unreachable')

  const h3 = harness()
  h3.req.start()
  h3.sockets[0].remoteClose(1000)
  assert.equal(h3.req.getStatus().error, 'unreachable')
})

test('a socket that never answers the hello times out as unreachable', () => {
  const h = harness({ helloTimeoutMs: 10000 })
  openSocket(h)
  h.timers.advance(9999)
  assert.equal(h.req.getStatus().state, 'connecting')
  h.timers.advance(1)
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'unreachable')
  assert.notEqual(h.sockets[0].closed, null)
})

test('a socket that never opens also times out as unreachable', () => {
  const h = harness({ helloTimeoutMs: 10000 })
  h.req.start()
  h.timers.advance(10000)
  assert.equal(h.req.getStatus().error, 'unreachable')
})

test('a factory that throws ends in error unreachable', () => {
  const h = harness({
    wsFactory: () => {
      throw new Error('no WebSocket')
    },
  })
  assert.doesNotThrow(() => h.req.start())
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'unreachable')
})

test('invalid pair-pending expiry is an invalid error', () => {
  const h = harness()
  const ws = openSocket(h)
  ws.message('{"type":"pair-pending","requestId":"r1","expiresInSec":"soon"}')
  assert.equal(h.req.getStatus().state, 'error')
  assert.equal(h.req.getStatus().error, 'invalid')
  assert.notEqual(ws.closed, null)
})

test('empty token and non-string token are invalid', () => {
  for (const pairing of ['', '   ', 42, null]) {
    const h = harness()
    const ws = pendingSocket(h)
    ws.message(JSON.stringify({ type: 'pair-approved', pairing }))
    assert.equal(h.req.getStatus().error, 'invalid')
    assert.deepEqual(h.approved, [])
  }
})

test('malformed and unknown frames are ignored', () => {
  const h = harness()
  const ws = openSocket(h)
  const before = h.statuses.length
  ws.message('not json')
  ws.message('null')
  ws.message('{"type":"something-else"}')
  ws.message('[1,2]')
  assert.equal(h.statuses.length, before)
  assert.equal(h.req.getStatus().state, 'connecting')
  assert.deepEqual(h.approved, [])
})

test('cancel closes 1000, returns to idle and calls no callbacks afterwards', () => {
  const h = harness()
  const ws = pendingSocket(h)
  const before = h.statuses.length
  h.req.cancel()
  assert.deepEqual(ws.closed, { code: 1000, reason: undefined })
  assert.equal(h.req.getStatus().state, 'idle')
  ws.message(JSON.stringify({ type: 'pair-approved', pairing: 'late' }))
  ws.remoteClose(1006)
  h.timers.advance(120000)
  assert.deepEqual(h.approved, [])
  assert.equal(h.statuses.length, before)
  assert.equal(h.req.getStatus().state, 'idle')
})

test('cancel during connecting stops the hello timeout', () => {
  const h = harness({ helloTimeoutMs: 10000 })
  h.req.start()
  h.req.cancel()
  h.timers.advance(20000)
  assert.equal(h.statuses[h.statuses.length - 1].state, 'connecting')
  assert.equal(h.req.getStatus().state, 'idle')
})

test('frames after a terminal state are ignored', () => {
  const h = harness()
  const ws = pendingSocket(h)
  ws.message(JSON.stringify({ type: 'pair-approved', pairing: 'tok-1' }))
  const before = h.statuses.length
  ws.message('{"type":"pair-pending","requestId":"r2","expiresInSec":60}')
  ws.message('{"type":"pair-denied","reason":"denied"}')
  ws.message(JSON.stringify({ type: 'pair-approved', pairing: 'tok-2' }))
  ws.remoteClose(4002)
  h.timers.advance(120000)
  assert.deepEqual(h.approved, ['tok-1'])
  assert.equal(h.statuses.length, before)
  assert.equal(h.req.getStatus().state, 'approved')
})

test('a denied request does not later expire or call onApproved', () => {
  const h = harness()
  const ws = pendingSocket(h, 10)
  ws.message('{"type":"pair-denied","reason":"denied"}')
  h.timers.advance(60000)
  assert.equal(h.req.getStatus().state, 'denied')
  assert.deepEqual(h.approved, [])
})

test('a throwing onChange or onApproved never escapes', () => {
  const h = harness({
    onChange: () => {
      throw new Error('boom')
    },
    onApproved: () => {
      throw new Error('boom')
    },
  })
  assert.doesNotThrow(() => h.req.start())
  const ws = h.sockets[0]
  assert.doesNotThrow(() => ws.open())
  assert.doesNotThrow(() => ws.message('{"type":"pair-pending","requestId":"r","expiresInSec":60}'))
  assert.doesNotThrow(() => ws.message('{"type":"pair-approved","pairing":"tok"}'))
  assert.equal(h.req.getStatus().state, 'approved')
})
