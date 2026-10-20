import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SubagentTracker } from '../dist/agents.js'

function setup(opts = {}) {
  const runs = new Map(Object.entries(opts.runs ?? { 'root-1': 'run-1', 'root-2': 'run-2' }))
  const state = { t: 1000 }
  const changes = []
  const tracker = new SubagentTracker({
    resolveRun: (id) => runs.get(id),
    onChange: (runId, agents) => changes.push({ runId, agents }),
    now: () => state.t,
    logCapBytes: opts.logCapBytes,
  })
  return { tracker, runs, state, changes }
}

const sess = (id, parentSession, createdAt = 500) => ({ id, header: { origin: 'subagent', parentSession, createdAt } })
const ev = (type, data = {}, time) => ({ type, seq: 0, time, data })
const text = (t) => ({ type: 'text', text: t })
const msg = (...parts) => ({ message: { content: parts } })

test('child lifecycle: descriptor, turn, assistant text, tool call, completed turn', () => {
  const { tracker, changes, state } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('subagent/descriptor', { mode: 'one-shot', label: 'Explore repo', provider: 'x' }, 600))
  tracker.onEvent(c, ev('turn/start', { turn: 1 }, 610))
  assert.equal(tracker.hasRunning('run-1'), true)
  tracker.onEvent(c, ev('assistant/message', { turn: 1, step: 1, ...msg({ type: 'reasoning', text: 'hmm' }, text('Found it.')) }, 620))
  tracker.onEvent(c, ev('tool/call', { callId: 'a', name: 'read', arguments: '{"path":"x.js"}' }, 630))
  tracker.onEvent(c, ev('tool/result', { callId: 'a', ...msg(text('file body')) }, 640))
  state.t = 2000
  tracker.onEvent(c, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 700))

  const [a] = tracker.agentsFor('run-1')
  assert.equal(a.id, 'child-1')
  assert.equal(a.role, 'Explore repo')
  assert.equal(a.status, 'done')
  assert.equal(a.startedAt, 500)
  assert.equal(a.endedAt, 700)
  assert.equal(a.summary, 'Found it.')
  assert.equal(a.log, 'Found it.\n> tool read {"path":"x.js"}')
  assert.equal(tracker.hasRunning('run-1'), false)
  assert.ok(changes.length >= 4)
  assert.equal(changes.at(-1).runId, 'run-1')
  assert.equal(changes.at(-1).agents[0].status, 'done')
})

test('startedAt falls back to event time, then now(), when header has no createdAt', () => {
  const { tracker, state } = setup()
  state.t = 3000
  tracker.onEvent({ id: 'c1', header: { origin: 'subagent', parentSession: 'root-1' } }, ev('turn/start', {}, 2500))
  assert.equal(tracker.agentsFor('run-1')[0].startedAt, 2500)
  tracker.onEvent({ id: 'c2', header: { origin: 'subagent', parentSession: 'root-1' } }, ev('turn/start', {}))
  assert.equal(tracker.agentsFor('run-1')[1].startedAt, 3000)
  assert.equal(tracker.agentsFor('run-1')[1].role, 'subagent')
})

test('owner resolution: grandchild belongs to the same run as its tracked child', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start'))
  tracker.onEvent(sess('grand-1', 'child-1'), ev('turn/start'))
  tracker.onEvent(sess('grand-2', 'child-1'), ev('turn/start'))
  const ids = tracker.agentsFor('run-1').map((a) => a.id)
  assert.deepEqual(ids, ['child-1', 'grand-1', 'grand-2'])
  assert.deepEqual(tracker.agentsFor('run-2'), [])
})

test('owner resolution: other root maps to other run', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('child-2', 'root-2'), ev('turn/start'))
  assert.deepEqual(tracker.agentsFor('run-1'), [])
  assert.deepEqual(tracker.agentsFor('run-2').map((a) => a.id), ['child-2'])
})

test('unknown owner is ignored and nothing is remembered', () => {
  const { tracker, runs, changes } = setup()
  tracker.onEvent(sess('orphan', 'nobody'), ev('turn/start'))
  assert.deepEqual(tracker.agentsFor('run-1'), [])
  assert.equal(changes.length, 0)
  // once the owner becomes resolvable, the next event is picked up
  runs.set('nobody', 'run-1')
  tracker.onEvent(sess('orphan', 'nobody'), ev('turn/start'))
  assert.deepEqual(tracker.agentsFor('run-1').map((a) => a.id), ['orphan'])
})

test('grandchild of an unknown owner is ignored', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('grand', 'unknown-child'), ev('turn/start'))
  assert.equal(tracker.agentsFor('run-1').length, 0)
})

test('non-subagent sessions and subagents without parentSession are ignored', () => {
  const { tracker, changes } = setup()
  tracker.onEvent({ id: 'root-1', header: { origin: 'user' } }, ev('turn/start'))
  tracker.onEvent({ id: 'x', header: { origin: 'subagent' } }, ev('turn/start'))
  tracker.onEvent({ id: 'y', header: {} }, ev('turn/start'))
  tracker.onEvent(null, ev('turn/start'))
  assert.equal(changes.length, 0)
  assert.deepEqual(tracker.agentsFor('run-1'), [])
})

test('turn/end with error sets error status and summary from the message', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('turn/start', {}, 600))
  tracker.onEvent(c, ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }, 650))
  const a = tracker.agentsFor('run-1')[0]
  assert.equal(a.status, 'error')
  assert.equal(a.summary, 'boom')
  assert.equal(a.endedAt, 650)
})

test('turn/end with a non-completed kind without message uses the kind as summary', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 650))
  const a = tracker.agentsFor('run-1')[0]
  assert.equal(a.status, 'error')
  assert.equal(a.summary, 'aborted')
})

test('continuable child: second turn goes back to running and can finish again', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('subagent/descriptor', { mode: 'continuable', provider: 'x' }))
  tracker.onEvent(c, ev('turn/start', { turn: 1 }, 10))
  tracker.onEvent(c, ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20))
  assert.equal(tracker.agentsFor('run-1')[0].status, 'done')
  tracker.onEvent(c, ev('turn/start', { turn: 2 }, 30))
  let a = tracker.agentsFor('run-1')[0]
  assert.equal(a.status, 'running')
  assert.equal(a.endedAt, null)
  assert.equal(tracker.hasRunning('run-1'), true)
  tracker.onEvent(c, ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 40))
  a = tracker.agentsFor('run-1')[0]
  assert.equal(a.status, 'done')
  assert.equal(a.endedAt, 40)
})

test('onStart before the first event: nothing is reported until a session event arrives', () => {
  const { tracker, changes } = setup()
  tracker.onStart({ runId: 'r', provider: 'x', id: 'child-1', local: true })
  assert.deepEqual(tracker.agentsFor('run-1'), [])
  assert.equal(changes.length, 0)
  tracker.onEvent(sess('child-1', 'root-1', 777), ev('subagent/descriptor', { label: 'Plan' }, 800))
  const [a] = tracker.agentsFor('run-1')
  assert.equal(a.id, 'child-1')
  assert.equal(a.role, 'Plan')
  assert.equal(a.startedAt, 777)
  assert.equal(changes.length, 1)
})

test('onStart and onEnd with unknown ids do not throw', () => {
  const { tracker, changes } = setup()
  tracker.onStart(undefined)
  tracker.onStart({})
  tracker.onEnd(undefined)
  tracker.onEnd({ id: 'nope', stopReason: 'completed' })
  assert.equal(changes.length, 0)
})

test('onEnd stopReason variants', () => {
  const cases = [
    ['completed', 'done'],
    ['aborted', 'error'],
    ['error', 'error'],
    ['something-else', 'error'],
  ]
  for (const [stopReason, status] of cases) {
    const { tracker, state } = setup()
    tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start', {}))
    state.t = 5000
    tracker.onEnd({ runId: 'r', provider: 'x', id: 'child-1', local: true, stopReason })
    const a = tracker.agentsFor('run-1')[0]
    assert.equal(a.status, status, stopReason)
    assert.equal(a.endedAt, 5000, stopReason)
  }
})

test('onEnd takes the summary from lastAssistantMessage', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start', {}))
  tracker.onEnd({
    id: 'child-1',
    stopReason: 'completed',
    lastAssistantMessage: [text('All done: 3 files changed.')],
  })
  assert.equal(tracker.agentsFor('run-1')[0].summary, 'All done: 3 files changed.')
})

test('onEnd for an aborted child keeps the previous summary when there is no last message', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('assistant/message', msg(text('partial'))))
  tracker.onEnd({ id: 'child-1', stopReason: 'aborted' })
  const a = tracker.agentsFor('run-1')[0]
  assert.equal(a.status, 'error')
  assert.equal(a.summary, 'partial')
})

test('log cap keeps the newest lines and stays within the byte budget', () => {
  const cap = 200
  const { tracker } = setup({ logCapBytes: cap })
  const c = sess('child-1', 'root-1')
  for (let i = 0; i < 30; i++) tracker.onEvent(c, ev('assistant/message', msg(text(`line ${i}`))))
  const { log } = tracker.agentsFor('run-1')[0]
  assert.ok(Buffer.byteLength(log, 'utf8') <= cap)
  assert.ok(log.startsWith('... [earlier output truncated]\n'))
  assert.ok(log.endsWith('line 29'))
  assert.ok(!log.includes('line 0\n'))
  assert.ok(!log.includes('line 1\n'))
})

test('log cap never splits multibyte characters (Japanese)', () => {
  for (let cap = 80; cap <= 160; cap += 7) {
    const { tracker } = setup({ logCapBytes: cap })
    const c = sess('child-1', 'root-1')
    for (let i = 0; i < 10; i++) {
      tracker.onEvent(c, ev('assistant/message', msg(text(`こんにちは世界 ${i} 日本語のテキスト`))))
    }
    const { log } = tracker.agentsFor('run-1')[0]
    assert.ok(Buffer.byteLength(log, 'utf8') <= cap, `cap ${cap}`)
    assert.ok(!log.includes('�'), `cap ${cap}`)
    assert.equal(Buffer.from(log, 'utf8').toString('utf8'), log, `cap ${cap}`)
    assert.ok(log.endsWith('日本語のテキスト'), `cap ${cap}`)
  }
})

test('log cap applies to a single huge piece, keeping its tail', () => {
  const { tracker } = setup({ logCapBytes: 100 })
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('assistant/message', msg(text('あ'.repeat(200)))))
  const { log } = tracker.agentsFor('run-1')[0]
  assert.ok(Buffer.byteLength(log, 'utf8') <= 100)
  assert.ok(log.startsWith('... [earlier output truncated]\n'))
  assert.equal(log.replace('... [earlier output truncated]\n', '').replace(/あ/g, ''), '')
})

test('failing tool result is logged, successful one is not', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('tool/call', { name: 'bash', arguments: { command: 'ls' } }))
  tracker.onEvent(c, ev('tool/result', msg(text('ok output'))))
  tracker.onEvent(c, ev('tool/result', { error: true, ...msg(text('Error: no such file')) }))
  assert.equal(tracker.agentsFor('run-1')[0].log, '> tool bash {"command":"ls"}\n> failed: Error: no such file')
})

test('long summaries and tool arguments are cut', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('assistant/message', msg(text('x'.repeat(1000)))))
  tracker.onEvent(c, ev('tool/call', { name: 'write', arguments: 'a'.repeat(300) }))
  const a = tracker.agentsFor('run-1')[0]
  assert.equal(a.summary.length, 500)
  const toolLine = a.log.split('\n').find((l) => l.startsWith('> tool write'))
  assert.equal(toolLine, '> tool write ' + 'a'.repeat(120))
})

test('a newer assistant text replaces the summary; a message without text does not', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('assistant/message', msg(text('first'))))
  tracker.onEvent(c, ev('assistant/message', msg({ type: 'reasoning', text: 'thinking' })))
  assert.equal(tracker.agentsFor('run-1')[0].summary, 'first')
  tracker.onEvent(c, ev('assistant/message', msg(text('second'))))
  assert.equal(tracker.agentsFor('run-1')[0].summary, 'second')
  assert.equal(tracker.agentsFor('run-1')[0].log, 'first\n\nsecond')
})

test('role from descriptor label is cut to 120 chars and falls back to subagent', () => {
  const { tracker } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('subagent/descriptor', { label: 'L'.repeat(300) }))
  assert.equal(tracker.agentsFor('run-1')[0].role, 'L'.repeat(120))
  const d = sess('child-2', 'root-1')
  tracker.onEvent(d, ev('subagent/descriptor', { mode: 'one-shot' }))
  assert.equal(tracker.agentsFor('run-1')[1].role, 'subagent')
})

test('forget drops all agents of a run and their children', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start'))
  tracker.onEvent(sess('grand-1', 'child-1'), ev('turn/start'))
  tracker.onEvent(sess('child-2', 'root-2'), ev('turn/start'))
  tracker.forget('run-1')
  assert.deepEqual(tracker.agentsFor('run-1'), [])
  assert.equal(tracker.hasRunning('run-1'), false)
  assert.deepEqual(tracker.agentsFor('run-2').map((a) => a.id), ['child-2'])
})

test('hasRunning reflects running agents only', () => {
  const { tracker } = setup()
  assert.equal(tracker.hasRunning('run-1'), false)
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('turn/start'))
  assert.equal(tracker.hasRunning('run-1'), true)
  tracker.onEnd({ id: 'child-1', stopReason: 'completed' })
  assert.equal(tracker.hasRunning('run-1'), false)
})

test('agentsFor returns copies in start order', () => {
  const { tracker } = setup()
  tracker.onEvent(sess('child-b', 'root-1'), ev('turn/start'))
  tracker.onEvent(sess('child-a', 'root-1'), ev('turn/start'))
  const list = tracker.agentsFor('run-1')
  assert.deepEqual(list.map((a) => a.id), ['child-b', 'child-a'])
  list[0].status = 'error'
  assert.equal(tracker.agentsFor('run-1')[0].status, 'running')
})

test('onChange fires only on real changes', () => {
  const { tracker, changes } = setup()
  const c = sess('child-1', 'root-1')
  tracker.onEvent(c, ev('turn/start', {}, 10))
  assert.equal(changes.length, 1) // creation
  tracker.onEvent(c, ev('turn/start', {}, 11)) // already running
  assert.equal(changes.length, 1)
  tracker.onEvent(c, ev('subagent/descriptor', { label: 'Same' }))
  assert.equal(changes.length, 2) // role changed
  tracker.onEvent(c, ev('subagent/descriptor', { label: 'Same' }))
  assert.equal(changes.length, 2) // same role
  tracker.onEvent(c, ev('session/other', {}))
  assert.equal(changes.length, 2) // unknown event type
  tracker.onEvent(c, ev('turn/end', { reason: { kind: 'completed' } }, 12))
  assert.equal(changes.length, 3)
  tracker.onEnd({ id: 'child-1', stopReason: 'completed' })
  assert.equal(changes.length, 3) // already done, no summary
  tracker.onEvent(c, ev('turn/end', { reason: { kind: 'completed' } }, 13))
  assert.equal(changes.length, 3)
})

test('onChange receives a fresh array and a throwing listener does not break tracking', () => {
  const seen = []
  const tracker = new SubagentTracker({
    resolveRun: () => 'run-1',
    onChange: (runId, agents) => {
      seen.push(agents)
      throw new Error('listener broke')
    },
  })
  tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start'))
  tracker.onEvent(sess('child-1', 'root-1'), ev('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0], seen[1])
  assert.equal(tracker.agentsFor('run-1')[0].status, 'done')
})

test('a throwing resolveRun is treated as an unknown owner', () => {
  const tracker = new SubagentTracker({
    resolveRun: () => {
      throw new Error('boom')
    },
  })
  assert.doesNotThrow(() => tracker.onEvent(sess('child-1', 'root-1'), ev('turn/start')))
  assert.deepEqual(tracker.agentsFor('run-1'), [])
})

test('at most 50 agents per run', () => {
  const { tracker, changes } = setup()
  for (let i = 0; i < 55; i++) tracker.onEvent(sess(`child-${i}`, 'root-1'), ev('turn/start'))
  const list = tracker.agentsFor('run-1')
  assert.equal(list.length, 50)
  assert.equal(list[0].id, 'child-0')
  assert.equal(list[49].id, 'child-49')
  // the other run has its own budget
  tracker.onEvent(sess('other', 'root-2'), ev('turn/start'))
  assert.equal(tracker.agentsFor('run-2').length, 1)
  // ignored children stay ignored, even with further events
  tracker.onEvent(sess('child-50', 'root-1'), ev('turn/end', { reason: { kind: 'completed' } }))
  assert.equal(tracker.agentsFor('run-1').length, 50)
  assert.equal(changes.at(-1).runId, 'run-2')
})

test('never throws on malformed input', () => {
  const { tracker } = setup()
  assert.doesNotThrow(() => {
    tracker.onEvent(sess('c', 'root-1'), null)
    tracker.onEvent(sess('c', 'root-1'), ev('assistant/message', { message: null }))
    tracker.onEvent(sess('c', 'root-1'), ev('tool/result', { message: { content: 'nope' } }))
    tracker.onEvent(sess('c', 'root-1'), ev('turn/end', { reason: null }))
    tracker.onEvent(sess('c', 'root-1'), ev('tool/call', { name: null, arguments: undefined }))
    tracker.onEnd({ id: 'c', stopReason: 'completed', lastAssistantMessage: 'x' })
    tracker.onEnd(null)
  })
  assert.equal(tracker.agentsFor('run-1')[0].status, 'done') // last onEnd wins
})

test('the parent subagent/catalog label becomes the role, before or after the first child event', () => {
  const changes = []
  const tr = new SubagentTracker({ resolveRun: (sid) => (sid === 'parent' ? 'run1' : undefined), onChange: (runId, agents) => changes.push(agents.map((a) => a.role)) })
  const parent = { id: 'parent', header: {} }
  const child = (id) => ({ id, header: { origin: 'subagent', parentSession: 'parent', createdAt: 1 } })
  // catalog first
  tr.onEvent(parent, { type: 'subagent/catalog', data: { childId: 'c1', label: 'Read the file', mode: 'continuable' } })
  tr.onEvent(child('c1'), { type: 'turn/start', time: 2, data: { turn: 1 } })
  assert.equal(tr.agentsFor('run1')[0].role, 'Read the file')
  // child event first, then catalog
  tr.onEvent(child('c2'), { type: 'turn/start', time: 3, data: { turn: 1 } })
  assert.equal(tr.agentsFor('run1').find((a) => a.id === 'c2').role, 'subagent')
  tr.onEvent(parent, { type: 'subagent/catalog', data: { childId: 'c2', label: 'Second helper', mode: 'one-shot' } })
  assert.equal(tr.agentsFor('run1').find((a) => a.id === 'c2').role, 'Second helper')
  assert.ok(changes.length >= 3)
})
