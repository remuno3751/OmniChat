import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApprovalBroker, describeCall } from '../dist/approvals.js'

let n = 0
const ids = () => `ap-${++n}`

function setup(opts = {}) {
  const frames = []
  let sendResult = true
  const broker = new ApprovalBroker({
    send: (f) => {
      frames.push(f)
      return typeof opts.sendResult === 'boolean' ? opts.sendResult : sendResult
    },
    genId: opts.genId ?? ids,
    timeoutMs: opts.timeoutMs,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
  })
  return { broker, frames, setSend: (v) => (sendResult = v) }
}

test('frame shape for a bash call extracts the command', async () => {
  const { broker, frames } = setup({ genId: () => 'a1' })
  const p = broker.request({
    requestId: 'run-1',
    req: { agent: 'x', toolName: 'bash', reason: 'list files' },
    call: { name: 'bash', arguments: '{"command":"ls -la"}' },
  })
  assert.deepEqual(frames, [
    { type: 'approval', requestId: 'run-1', approvalId: 'a1', tool: 'bash', command: 'ls -la', reason: 'list files' },
  ])
  assert.equal(broker.pendingCount(), 1)
  assert.equal(broker.reply({ approvalId: 'a1', decision: 'allowed-once' }), true)
  assert.equal(await p, 'allowed-once')
})

test('frame shape for an edit call extracts the path and falls back to displayReason', async () => {
  const { broker, frames } = setup({ genId: () => 'a2' })
  const p = broker.request({
    requestId: 'run-2',
    req: { toolName: 'edit', displayReason: { en: 'Edit file' } },
    call: { name: 'edit', arguments: { file_path: '/src/app.js', old_string: 'a' } },
  })
  assert.deepEqual(frames[0], {
    type: 'approval',
    requestId: 'run-2',
    approvalId: 'a2',
    tool: 'edit',
    path: '/src/app.js',
    reason: 'Edit file',
  })
  broker.reply({ approvalId: 'a2', decision: 'rejected' })
  await p
})

test('frame omits command/path/reason when absent', async () => {
  const { broker, frames } = setup({ genId: () => 'a3' })
  const p = broker.request({ requestId: 'r', req: { toolName: 'noop' } })
  assert.deepEqual(frames[0], { type: 'approval', requestId: 'r', approvalId: 'a3', tool: 'noop' })
  broker.cancelAll()
  await p
})

test('allow resolves allowed-once; reject and unknown decision resolve rejected', async () => {
  const { broker } = setup({ genId: ids })
  const req = (id) => broker.request({ requestId: 'r', req: { toolName: 't' } })
  const pa = req()
  const pr = req()
  const pu = req()
  const [a, r, u] = [...broker.pending.keys()]
  assert.equal(broker.reply({ approvalId: a, decision: 'allowed-once' }), true)
  assert.equal(broker.reply({ approvalId: r, decision: 'rejected' }), true)
  assert.equal(broker.reply({ approvalId: u, decision: 'maybe' }), true)
  assert.equal(await pa, 'allowed-once')
  assert.equal(await pr, 'rejected')
  assert.equal(await pu, 'rejected')
  assert.equal(broker.pendingCount(), 0)
})

test('timeout resolves rejected and clears the pending entry', async () => {
  const { broker } = setup({ timeoutMs: 5 })
  const out = await broker.request({ requestId: 'r', req: { toolName: 't' } })
  assert.equal(out, 'rejected')
  assert.equal(broker.pendingCount(), 0)
})

test('settling clears the timer', async () => {
  const cleared = []
  const { broker } = setup({
    genId: () => 'tm',
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: (t) => cleared.push(t),
  })
  const p = broker.request({ requestId: 'r', req: { toolName: 't' } })
  broker.reply({ approvalId: 'tm', decision: 'allowed-once' })
  assert.equal(await p, 'allowed-once')
  assert.equal(cleared.length, 1)
  assert.equal(cleared[0].ms, 600000)
})

test('abort signal resolves cancelled and cleans up pending', async () => {
  const { broker } = setup()
  const ac = new AbortController()
  const p = broker.request({ requestId: 'r', req: { toolName: 't', signal: ac.signal } })
  assert.equal(broker.pendingCount(), 1)
  ac.abort()
  assert.equal(await p, 'cancelled')
  assert.equal(broker.pendingCount(), 0)
  assert.equal(broker.reply({ approvalId: 'whatever', decision: 'allowed-once' }), false)
})

test('abort after settle is a no-op', async () => {
  const { broker } = setup({ genId: () => 'x1' })
  const ac = new AbortController()
  const p = broker.request({ requestId: 'r', req: { toolName: 't', signal: ac.signal } })
  broker.reply({ approvalId: 'x1', decision: 'allowed-once' })
  ac.abort()
  assert.equal(await p, 'allowed-once')
})

test('already aborted signal resolves cancelled without sending', async () => {
  const { broker, frames } = setup()
  const ac = new AbortController()
  ac.abort()
  assert.equal(await broker.request({ requestId: 'r', req: { toolName: 't', signal: ac.signal } }), 'cancelled')
  assert.equal(frames.length, 0)
  assert.equal(broker.pendingCount(), 0)
})

test('send returning false resolves rejected with no pending entry', async () => {
  const { broker } = setup({ sendResult: false })
  assert.equal(await broker.request({ requestId: 'r', req: { toolName: 't' } }), 'rejected')
  assert.equal(broker.pendingCount(), 0)
})

test('send throwing resolves rejected and never throws synchronously', async () => {
  const broker = new ApprovalBroker({
    send: () => {
      throw new Error('boom')
    },
  })
  assert.equal(await broker.request({ requestId: 'r', req: { toolName: 't' } }), 'rejected')
  assert.equal(broker.pendingCount(), 0)
})

test('request with no arguments still resolves', async () => {
  const { broker } = setup()
  const p = broker.request()
  assert.equal(broker.pendingCount(), 1)
  broker.cancelAll()
  assert.equal(await p, 'rejected')
})

test('cancelRun resolves only that run as cancelled', async () => {
  const { broker } = setup()
  const a1 = broker.request({ requestId: 'A', req: { toolName: 't' } })
  const a2 = broker.request({ requestId: 'A', req: { toolName: 't' } })
  const b = broker.request({ requestId: 'B', req: { toolName: 't' } })
  assert.equal(broker.cancelRun('A'), 2)
  assert.equal(await a1, 'cancelled')
  assert.equal(await a2, 'cancelled')
  assert.equal(broker.pendingCount(), 1)
  broker.cancelRun('B')
  assert.equal(await b, 'cancelled')
})

test('cancelAll resolves everything with the given outcome', async () => {
  const { broker } = setup()
  const p1 = broker.request({ requestId: 'A', req: { toolName: 't' } })
  const p2 = broker.request({ requestId: 'B', req: { toolName: 't' } })
  assert.equal(broker.cancelAll(), 2)
  assert.equal(await p1, 'rejected')
  assert.equal(await p2, 'rejected')
  assert.equal(broker.pendingCount(), 0)

  const p3 = broker.request({ requestId: 'C', req: { toolName: 't' } })
  broker.cancelAll('cancelled')
  assert.equal(await p3, 'cancelled')
})

test('duplicate and unknown replies are ignored', async () => {
  const { broker } = setup({ genId: () => 'dup' })
  const p = broker.request({ requestId: 'r', req: { toolName: 't' } })
  assert.equal(broker.reply({ approvalId: 'nope', decision: 'allowed-once' }), false)
  assert.equal(broker.reply({ approvalId: 'dup', decision: 'allowed-once' }), true)
  assert.equal(broker.reply({ approvalId: 'dup', decision: 'rejected' }), false)
  assert.equal(await p, 'allowed-once')
  assert.equal(broker.reply(null), false)
})

test('a reply for another run approval does not resolve ours', async () => {
  const { broker, frames } = setup({ genId: ids })
  const ours = broker.request({ requestId: 'run-ours', req: { toolName: 't' } })
  const theirs = broker.request({ requestId: 'run-theirs', req: { toolName: 't' } })
  const theirApproval = frames[1].approvalId
  assert.notEqual(frames[0].approvalId, theirApproval)
  assert.equal(broker.reply({ approvalId: theirApproval, decision: 'allowed-once' }), true)
  assert.equal(await theirs, 'allowed-once')
  assert.equal(broker.pendingCount(), 1)
  broker.cancelRun('run-ours')
  assert.equal(await ours, 'cancelled')
})

test('describeCall handles bad JSON, objects and missing args', () => {
  assert.deepEqual(describeCall('bash', '{not json'), {})
  assert.deepEqual(describeCall('bash', undefined), {})
  assert.deepEqual(describeCall('bash', null), {})
  assert.deepEqual(describeCall('bash', '"just a string"'), {})
  assert.deepEqual(describeCall('bash', '{"command":"pwd"}'), { command: 'pwd' })
})

test('describeCall picks the first non-empty key and skips non-strings', () => {
  assert.deepEqual(describeCall('x', { command: '', cmd: 'echo hi' }), { command: 'echo hi' })
  assert.deepEqual(describeCall('x', { command: 42, script: 'run.sh' }), { command: 'run.sh' })
  assert.deepEqual(describeCall('x', { filename: 'a.txt', path: 'b.txt' }), { path: 'b.txt' })
  assert.deepEqual(describeCall('x', { target: '/t', destination: '/d' }), { path: '/t' })
  assert.deepEqual(describeCall('x', { other: 'value' }), {})
})

test('describeCall caps command at 2000 and path at 1000 chars', () => {
  const r = describeCall('x', { command: 'c'.repeat(3000), file_path: 'p'.repeat(1500) })
  assert.equal(r.command.length, 2000)
  assert.equal(r.path.length, 1000)
})
