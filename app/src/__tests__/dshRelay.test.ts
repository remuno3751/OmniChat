// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DshRelay, buildBridgeUrl, localUrl } from '../dshRelay'
import type { RelayOptions, RelayStatus, Timers, WsLike } from '../dshRelay'

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

  // Scripted events.
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

  private fire(type: string, ev: unknown): void {
    for (const fn of this.handlers[type] ?? []) fn(ev)
  }
}

class FakeTimers implements Timers {
  now = 0
  rnd = 0
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

  random(): number {
    return this.rnd
  }

  // Runs due tasks in (time, id) order, up to and including now + ms.
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

function harness(extra: Partial<RelayOptions> = {}) {
  const locals: FakeWs[] = []
  const servers: FakeWs[] = []
  const statuses: RelayStatus[] = []
  const timers = new FakeTimers()
  const relay = new DshRelay({
    port: 4567,
    pairing: 'PAIR',
    bridgeName: 'laptop',
    serverUrl: 'https://omni.example',
    token: 'tok',
    version: '1.2.3',
    localFactory: (url) => {
      const w = new FakeWs(url)
      locals.push(w)
      return w
    },
    serverFactory: (url) => {
      const w = new FakeWs(url)
      servers.push(w)
      return w
    },
    onStatus: (s) => {
      statuses.push(s)
    },
    timers,
    ...extra,
  })
  return { relay, locals, servers, statuses, timers }
}

type H = ReturnType<typeof harness>

const READY = '{"type":"ready","seq":0,"instance":"i1"}'

// Opens the local socket and answers hello with the given ready frame.
function localReady(h: H, ready: string = READY): FakeWs {
  const local = h.locals[h.locals.length - 1]
  local.open()
  local.message(ready)
  return local
}

function parse(s: string | undefined): any {
  return JSON.parse(s ?? 'null')
}

test('buildBridgeUrl maps schemes, appends /bridge and sets token and name', () => {
  assert.equal(
    buildBridgeUrl('https://omni.example/api/', 'laptop', 'tok'),
    'wss://omni.example/api/bridge?token=tok&name=laptop',
  )
  assert.equal(
    buildBridgeUrl('http://localhost:8787', 'my-pc', 'a b'),
    'ws://localhost:8787/bridge?token=a+b&name=my-pc',
  )
})

test('localUrl points at the plugin loopback bridge', () => {
  assert.equal(localUrl(4567), 'ws://127.0.0.1:4567/omnichat-bridge')
})

test('happy path: hello, ready first, then verbatim ordered relay both ways', () => {
  const h = harness()
  h.relay.start()
  const local = h.locals[0]
  assert.equal(local.url, 'ws://127.0.0.1:4567/omnichat-bridge')
  local.open()
  assert.deepEqual(parse(local.sent[0]), {
    type: 'hello',
    pairing: 'PAIR',
    client: 'omnichat-app',
    version: '1.2.3',
  })
  local.message(READY)
  assert.equal(h.servers.length, 1)
  assert.equal(h.servers[0].url, buildBridgeUrl('https://omni.example', 'laptop', 'tok'))
  h.servers[0].open()
  assert.deepEqual(h.servers[0].sent, [READY])

  local.message('{"type":"event", "n":1}')
  local.message('{"type":"event","n":2}')
  h.servers[0].message('{"type":"reply"}')

  assert.deepEqual(h.servers[0].sent, [READY, '{"type":"event", "n":1}', '{"type":"event","n":2}'])
  assert.deepEqual(local.sent.slice(1), ['{"type":"reply"}'])
  const st = h.relay.getStatus()
  assert.equal(st.framesToServer, 3)
  assert.equal(st.framesToLocal, 1)
})

test('firstPair adds pair only until paired; reconnect sends resume with rcv count', () => {
  const h = harness({ firstPair: true })
  h.relay.start()
  const first = h.locals[0]
  first.open()
  assert.equal(parse(first.sent[0]).pair, true)
  first.message('{"type":"ready","seq":5,"instance":"i1"}')
  h.servers[0].open()

  first.message('{"type":"event","n":1}') // counts -> 6
  first.message('{"type":"models","list":[]}') // neutral
  first.message('{"type":"sessions"}') // neutral
  first.message('not json at all') // unparseable -> counts -> 7

  first.remoteClose(1006)
  h.timers.advance(1000)
  const second = h.locals[1]
  second.open()
  const hello = parse(second.sent[0])
  assert.equal(hello.pair, undefined)
  assert.deepEqual(hello.resume, { instance: 'i1', sinceSeq: 7 })
})

test('ready seq initialises the counter and ready/models/sessions are not counted', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h, '{"type":"ready","seq":10,"instance":"i9"}')
  local.message('{"type":"models"}')
  local.message('{"type":"ready","seq":99}') // second ready: forwarded, not counted
  local.remoteClose(1006)
  h.timers.advance(1000)
  h.locals[1].open()
  const hello = parse(h.locals[1].sent[0])
  assert.deepEqual(hello.resume, { instance: 'i9', sinceSeq: 10 })
})

test('frames queue while the server is connecting and flush in order after ready', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h)
  local.message('{"type":"event","n":1}')
  local.message('{"type":"event","n":2}')
  assert.deepEqual(h.servers[0].sent, [])
  h.servers[0].open()
  assert.deepEqual(h.servers[0].sent, [READY, '{"type":"event","n":1}', '{"type":"event","n":2}'])
  local.message('{"type":"event","n":3}')
  assert.equal(h.servers[0].sent[3], '{"type":"event","n":3}')
})

test('back-pressure: over high water queues and drains in order when it falls', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h)
  h.servers[0].open()
  h.servers[0].bufferedAmount = 2 * 1024 * 1024

  local.message('b1')
  h.timers.advance(50)
  local.message('b2')
  h.timers.advance(50)
  assert.deepEqual(h.servers[0].sent, [READY])

  h.servers[0].bufferedAmount = 0
  h.timers.advance(50)
  assert.deepEqual(h.servers[0].sent, [READY, 'b1', 'b2'])
})

test('queue overflow closes both sockets and restarts with backoff', () => {
  const h = harness({ queueLimitBytes: 10 })
  h.relay.start()
  const local = localReady(h)
  local.message('aaaaaa')
  assert.equal(h.servers[0].closed, null)
  local.message('bbbbbb') // 12 bytes > 10
  assert.deepEqual(h.servers[0].closed, { code: 1013, reason: 'overflow' })
  assert.deepEqual(local.closed, { code: 1013, reason: 'overflow' })
  assert.equal(h.relay.getStatus().lastError, 'queue overflow')
  h.timers.advance(999)
  assert.equal(h.locals.length, 1)
  h.timers.advance(1)
  assert.equal(h.locals.length, 2)
})

test('4401 -> auth-failed with no reconnect; retry() restarts', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h)
  h.servers[0].open()
  local.remoteClose(4401)
  const st = h.relay.getStatus()
  assert.equal(st.local, 'auth-failed')
  assert.equal(st.lastError, 'pairing rejected')
  assert.notEqual(h.servers[0].closed, null)
  h.timers.advance(10 * 60 * 1000)
  assert.equal(h.locals.length, 1)

  h.relay.retry()
  assert.equal(h.locals.length, 2)
  assert.equal(h.relay.getStatus().local, 'connecting')
})

test('4403 -> auth-failed with origin message', () => {
  const h = harness()
  h.relay.start()
  h.locals[0].remoteClose(4403)
  assert.equal(h.relay.getStatus().local, 'auth-failed')
  assert.equal(h.relay.getStatus().lastError, 'origin not allowed')
  h.timers.advance(10 * 60 * 1000)
  assert.equal(h.locals.length, 1)
})

test('4000 -> replaced with no retry', () => {
  const h = harness()
  h.relay.start()
  localReady(h)
  h.locals[0].remoteClose(4000)
  const st = h.relay.getStatus()
  assert.equal(st.local, 'replaced')
  assert.equal(st.lastError, 'another client took over')
  h.timers.advance(10 * 60 * 1000)
  assert.equal(h.locals.length, 1)
})

test('4429 retries after at least 60000 ms', () => {
  const h = harness()
  h.relay.start()
  h.locals[0].remoteClose(4429)
  assert.equal(h.relay.getStatus().lastError, 'locked, retrying later')
  h.timers.advance(59999)
  assert.equal(h.locals.length, 1)
  h.timers.advance(1)
  assert.equal(h.locals.length, 2)
})

test('local drops back off 1000, 2000, 4000 and reset after stableMs', () => {
  const h = harness()
  h.relay.start()

  h.locals[0].remoteClose(1006)
  h.timers.advance(999)
  assert.equal(h.locals.length, 1)
  h.timers.advance(1)
  assert.equal(h.locals.length, 2)

  h.locals[1].remoteClose(1006)
  h.timers.advance(1999)
  assert.equal(h.locals.length, 2)
  h.timers.advance(1)
  assert.equal(h.locals.length, 3)

  h.locals[2].remoteClose(1006)
  h.timers.advance(3999)
  assert.equal(h.locals.length, 3)
  h.timers.advance(1)
  assert.equal(h.locals.length, 4)

  // Stay up past stableMs, then drop: backoff starts over at 1000.
  const local = localReady(h)
  h.servers[0].open()
  h.timers.advance(5000)
  local.remoteClose(1006)
  assert.deepEqual(h.servers[0].closed, { code: 1000, reason: 'local lost' })
  h.timers.advance(999)
  assert.equal(h.locals.length, 4)
  h.timers.advance(1)
  assert.equal(h.locals.length, 5)
})

test('server drop closes local and restarts the pipeline', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h)
  h.servers[0].open()
  h.servers[0].remoteClose(4001)
  const st = h.relay.getStatus()
  assert.equal(st.lastError, 'device revoked')
  assert.equal(st.server, 'connecting')
  assert.equal(st.serverAttempts, 1)
  assert.deepEqual(local.closed, { code: 1000, reason: 'server lost' })
  h.timers.advance(999)
  assert.equal(h.locals.length, 1)
  h.timers.advance(1)
  assert.equal(h.locals.length, 2)
  assert.equal(h.relay.getStatus().local, 'connecting')
})

test('hello timeout counts as a failed attempt', () => {
  const h = harness({ helloTimeoutMs: 10000 })
  h.relay.start()
  const local = h.locals[0]
  local.open()
  h.timers.advance(9999)
  assert.equal(local.closed, null)
  h.timers.advance(1)
  assert.notEqual(local.closed, null)
  assert.equal(h.relay.getStatus().lastError, 'hello timeout')
  h.timers.advance(1000)
  assert.equal(h.locals.length, 2)
})

test('first frame that is not ready closes and retries', () => {
  const h = harness()
  h.relay.start()
  const local = h.locals[0]
  local.open()
  local.message('{"type":"models"}')
  assert.notEqual(local.closed, null)
  assert.equal(h.relay.getStatus().lastError, 'expected ready frame')
  assert.equal(h.servers.length, 0)
  h.timers.advance(1000)
  assert.equal(h.locals.length, 2)
})

test('stop() closes everything and ignores late events from old sockets', () => {
  const h = harness()
  h.relay.start()
  const local = localReady(h)
  h.servers[0].open()
  const server = h.servers[0]
  const sentBefore = local.sent.length
  const serverSentBefore = server.sent.length

  h.relay.stop()
  let st = h.relay.getStatus()
  assert.equal(st.local, 'off')
  assert.equal(st.server, 'off')
  assert.notEqual(local.closed, null)
  assert.notEqual(server.closed, null)

  local.message('{"type":"event"}')
  server.message('{"type":"reply"}')
  server.remoteClose(1006)
  local.remoteClose(1006)
  h.timers.advance(100000)

  assert.equal(h.locals.length, 1)
  assert.equal(h.servers.length, 1)
  assert.equal(local.sent.length, sentBefore)
  assert.equal(server.sent.length, serverSentBefore)
  st = h.relay.getStatus()
  assert.equal(st.local, 'off')
  assert.equal(st.server, 'off')
})

test('status sequence: local connecting then connected, server connecting then connected', () => {
  const h = harness()
  h.relay.start()
  localReady(h)
  h.servers[0].open()
  const seq: string[] = []
  for (const s of h.statuses) {
    const key = `${s.local}/${s.server}`
    if (seq[seq.length - 1] !== key) seq.push(key)
  }
  assert.deepEqual(seq, [
    'connecting/off',
    'connected/off',
    'connected/connecting',
    'connected/connected',
  ])
  // Every status object is a fresh copy.
  assert.notEqual(h.statuses[0], h.statuses[1])
})

test('throwing onStatus and throwing sockets never escape the relay', () => {
  const h = harness({
    onStatus: () => {
      throw new Error('boom')
    },
  })
  assert.doesNotThrow(() => h.relay.start())
  const local = h.locals[0]
  local.open()
  assert.doesNotThrow(() => local.message(READY))
  assert.doesNotThrow(() => h.servers[0].open())
  assert.doesNotThrow(() => local.remoteClose(1006))
})
