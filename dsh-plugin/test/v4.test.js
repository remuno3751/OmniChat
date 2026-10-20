import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OmniBridge } from '../dist/bridge.js'
import { createHost } from '../dist/host.js'
import { validateConfig } from '../dist/config.js'
import { makeCtx, makeServer, until, sleep } from './helpers.js'

// Runs without a configured cwd fall back to process.cwd(); keep that out of the real repository.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-plugin-cwd-')))

const cleanup = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()()
})

async function boot({ config = {}, ctx = {}, server: serverOpts = {}, noWait = false } = {}) {
  const server = await makeServer(serverOpts)
  const dsh = makeCtx(ctx)
  const logs = []
  const { config: cfg, errors } = validateConfig({ mode: 'remote', serverUrl: server.url, name: 'pc-v4', token: 'TOKEN-V4-SECRET', ...config })
  assert.deepEqual(errors, [])
  const bridge = new OmniBridge({
    host: createHost(dsh.ctx, (m) => logs.push(m)),
    config: cfg,
    log: (m) => logs.push(m),
    reconnectMinMs: 30,
    reconnectMaxMs: 120,
    textBatchMs: 5,
    mirrorFlushMs: 10,
    cancelGraceMs: 150,
    modelsPollMs: 10000,
    dshVersion: '0.2.0-test',
  })
  bridge.start()
  cleanup.push(async () => {
    bridge.stop()
    dsh.dispose()
    await server.close()
  })
  if (!noWait) await until(() => server.framesOf('ready').length === 1, 4000, 'ready')
  return { server, dsh, bridge, logs }
}

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanup.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* best effort */
    }
  })
  return dir
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function makeRepo() {
  const dir = mkTmp('omni-v4-repo-')
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'dev@example.test'])
  git(dir, ['config', 'user.name', 'dev'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/** Everything about a repo that the bridge must never touch. */
function userState(repo) {
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    branch: git(repo, ['symbolic-ref', '--short', 'HEAD']),
    heads: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/stash']),
    stash: git(repo, ['stash', 'list']),
    index: fs.readFileSync(path.join(repo, '.git', 'index')),
  }
}

const run = (server, o) => server.send({ type: 'run', runId: 'r1', sessionId: null, prompt: 'hello', ...o })
const doneFrames = (server) => server.framesOf('done')

async function startRun(server, dsh, runId = 'r1') {
  run(server, { runId })
  await until(() => dsh.calls.some((c) => c[0] === 'prompt' && c[1].requestId === runId), 4000, `prompt ${runId}`)
  return dsh.calls.find((c) => c[0] === 'prompt' && c[1].requestId === runId)[1].sessionId
}

/** The dsh turn of a run starts and its prompt is claimed by the run. */
const claim = (dsh, sid, runId, turn = 1) => dsh.startTurn(sid, turn, 'hello', runId)
const finishTurn = (dsh, sid, turn = 1, kind = 'completed') => dsh.event(sid, 'turn/end', { turn, reason: { kind } })

async function nextFrame(server, type, pred = () => true, ms = 4000) {
  await until(() => server.rec.frames.some((f) => f.type === type && pred(f)), ms, type)
  return server.rec.frames.find((f) => f.type === type && pred(f))
}

// ---------------------------------------------------------------------------- checkpoint / changes / done

test('checkpoint precedes the first event, changes precede done, and the user repo is untouched', async () => {
  const repo = makeRepo()
  const { server, dsh } = await boot({ config: { cwd: repo } })
  const before = userState(repo)
  const sid = await startRun(server, dsh)
  claim(dsh, sid, 'r1')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
  finishTurn(dsh, sid)
  await until(() => doneFrames(server).length === 1, 4000, 'done')
  const after = userState(repo)

  const frames = server.rec.frames
  const cpI = frames.findIndex((f) => f.type === 'checkpoint')
  const evI = frames.findIndex((f) => f.type === 'event')
  const chI = frames.findIndex((f) => f.type === 'changes')
  const doneI = frames.findIndex((f) => f.type === 'done')
  assert.ok(cpI >= 0 && cpI < evI, 'checkpoint frame before the first event frame')
  assert.ok(chI > evI && chI < doneI, 'changes frame after the events and before done')

  const cp = frames[cpI]
  assert.equal(cp.requestId, 'r1')
  assert.equal(cp.dirty, false)
  assert.match(cp.ref, /^refs\/omnichat\/checkpoints\//)
  git(repo, ['rev-parse', '--verify', '-q', cp.ref]) // throws when the ref is missing

  assert.deepEqual(
    frames[chI].changes.map((c) => [c.path, c.status, c.additions, c.deletions]),
    [
      ['a.txt', 'modified', 2, 1],
      ['b.txt', 'added', 1, 0],
    ],
  )
  assert.equal(doneFrames(server)[0].ok, true)
  assert.equal(doneFrames(server)[0].warning, undefined)

  assert.equal(after.head, before.head)
  assert.equal(after.branch, before.branch)
  assert.equal(after.heads, before.heads)
  assert.equal(after.stash, '')
  assert.ok(after.index.equals(before.index), 'real index bytes unchanged')
})

test('a non-git cwd: checkpoint is unavailable, changes are empty and done carries a warning', async () => {
  const dir = mkTmp('omni-v4-plain-')
  const { server, dsh } = await boot({ config: { cwd: dir } })
  const sid = await startRun(server, dsh)
  claim(dsh, sid, 'r1')
  finishTurn(dsh, sid)
  await until(() => doneFrames(server).length === 1, 4000, 'done')

  const cp = server.framesOf('checkpoint')[0]
  assert.equal(cp.unavailable, 'not a git repository')
  assert.equal(cp.ref, undefined)
  assert.deepEqual(server.framesOf('changes')[0].changes, [])
  const d = doneFrames(server)[0]
  assert.equal(d.ok, true)
  assert.equal(d.warning, 'not a git repository')
})

// ---------------------------------------------------------------------------- rewind

test('rewind restores checkpoint bytes, removes new files on request, and refuses bad requests', async () => {
  const repo = makeRepo()
  const orig = Buffer.from('line1\r\nline2\r\n')
  const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  fs.writeFileSync(path.join(repo, 'a.txt'), orig)
  fs.writeFileSync(path.join(repo, 'bin.dat'), bin)
  const { server, dsh } = await boot({ config: { cwd: repo } })
  const sid = await startRun(server, dsh)
  const ref = server.framesOf('checkpoint')[0].ref
  claim(dsh, sid, 'r1')
  fs.writeFileSync(path.join(repo, 'a.txt'), Buffer.from('changed\n'))
  fs.rmSync(path.join(repo, 'bin.dat'))
  fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n')
  finishTurn(dsh, sid)
  await until(() => doneFrames(server).length === 1, 4000, 'done')

  server.send({ type: 'rewind', requestId: 'rw1', ref, cwd: repo, removeNew: true })
  const rw1 = await nextFrame(server, 'rewound', (f) => f.requestId === 'rw1')
  assert.equal(rw1.ok, true, rw1.error)
  assert.equal(rw1.restored, 2)
  assert.equal(rw1.removed, 1)
  assert.match(rw1.backupRef, /^refs\/omnichat\/checkpoints\/pre-rewind-/)
  git(repo, ['rev-parse', '--verify', '-q', rw1.backupRef])
  assert.ok(fs.readFileSync(path.join(repo, 'a.txt')).equals(orig), 'a.txt bytes restored')
  assert.ok(fs.readFileSync(path.join(repo, 'bin.dat')).equals(bin), 'deleted binary restored')
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), false)

  server.send({ type: 'rewind', requestId: 'rw2', ref, cwd: mkTmp('omni-v4-other-') })
  const rw2 = await nextFrame(server, 'rewound', (f) => f.requestId === 'rw2')
  assert.equal(rw2.ok, false)
  assert.equal(rw2.error, 'cwd is not a known working directory')

  server.send({ type: 'rewind', requestId: 'rw3', ref: 'refs/heads/main', cwd: repo })
  const rw3 = await nextFrame(server, 'rewound', (f) => f.requestId === 'rw3')
  assert.equal(rw3.ok, false)
  assert.equal(rw3.error, 'invalid ref')
  server.send({ type: 'rewind', requestId: 'rw3b', ref: 42, cwd: repo })
  const rw3b = await nextFrame(server, 'rewound', (f) => f.requestId === 'rw3b')
  assert.equal(rw3b.error, 'invalid ref')

  const sid2 = await startRun(server, dsh, 'r2')
  server.send({ type: 'rewind', requestId: 'rw4', ref, cwd: repo })
  const rw4 = await nextFrame(server, 'rewound', (f) => f.requestId === 'rw4')
  assert.equal(rw4.ok, false)
  assert.equal(rw4.error, 'a run is in progress')
  claim(dsh, sid2, 'r2')
  finishTurn(dsh, sid2)
  await until(() => doneFrames(server).length === 2, 4000, 'second done')
})

// ---------------------------------------------------------------------------- approvals

test('approvals (remote): a run tool approval is brokered through the server', async () => {
  const { server, dsh } = await boot()
  const h = dsh.handlers.get('approval/request')[0]
  assert.equal(h.options.prepend, true)
  const sid = await startRun(server, dsh)
  dsh.event(sid, 'tool/call', { turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: { command: 'rm -rf x' } })

  const p1 = h.fn({ agent: { id: sid }, toolName: 'bash', callId: 'c9', reason: 'clean up' }, () => 'next')
  const f1 = await nextFrame(server, 'approval')
  assert.equal(f1.requestId, 'r1')
  assert.equal(f1.tool, 'bash')
  assert.equal(f1.command, 'rm -rf x')
  assert.equal(f1.reason, 'clean up')
  server.send({ type: 'approval_reply', approvalId: f1.approvalId, decision: 'allowed-once' })
  assert.equal(await p1, 'allowed-once')

  const p2 = h.fn({ agent: { id: sid }, toolName: 'bash', callId: 'c9' }, () => 'next')
  const f2 = await nextFrame(server, 'approval', (f) => f.approvalId !== f1.approvalId)
  server.send({ type: 'approval_reply', approvalId: f2.approvalId, decision: 'rejected' })
  assert.equal(await p2, 'rejected')

  let passed = false
  const r3 = h.fn({ agent: { id: 'foreign-session' } }, () => {
    passed = true
    return 'next'
  })
  assert.equal(r3, 'next')
  assert.equal(passed, true)
  await sleep(30)
  assert.equal(server.framesOf('approval').length, 2, 'no frame for a session not started from OmniChat')
})

test('approvals (remote): no answer within approvalTimeoutMs rejects the approval', async () => {
  const { server, dsh } = await boot({ config: { approvalTimeoutMs: 50 } })
  const h = dsh.handlers.get('approval/request')[0]
  const sid = await startRun(server, dsh)
  const p = h.fn({ agent: { id: sid }, toolName: 'edit' }, () => 'next')
  assert.equal(await p, 'rejected')
  assert.equal(server.framesOf('approval').length, 1)
})

test('approvals (remote): losing the server connection rejects pending approvals', async () => {
  const { server, dsh } = await boot()
  const h = dsh.handlers.get('approval/request')[0]
  const sid = await startRun(server, dsh)
  const p = h.fn({ agent: { id: sid }, toolName: 'bash' }, () => 'next')
  await nextFrame(server, 'approval')
  server.dropAll()
  assert.equal(await p, 'rejected')
})

test('approvals "gui" registers no approval handler', async () => {
  const { dsh } = await boot({ config: { approvals: 'gui' } })
  assert.equal((dsh.handlers.get('approval/request') ?? []).length, 0)
})

// ---------------------------------------------------------------------------- sub-agents

test('sub-agents: agents frames follow children of our runs, including children still running after the parent turn', async () => {
  const { server, dsh } = await boot()
  const sid = await startRun(server, dsh)
  claim(dsh, sid, 'r1')
  const addChild = (id, parent) =>
    dsh.sessions.set(id, { id, header: { origin: 'subagent', parentSession: parent, cwd: '/w', createdAt: Date.now() }, events: [] })

  addChild('child-1', sid)
  dsh.event('child-1', 'subagent/descriptor', { mode: 'continuable', label: 'helper' })
  dsh.event('child-1', 'turn/start', { turn: 1 })
  const first = await nextFrame(server, 'agents')
  assert.equal(first.requestId, 'r1')
  assert.equal(first.agents.length, 1)
  assert.equal(first.agents[0].role, 'helper')
  assert.equal(first.agents[0].status, 'running')
  dsh.event('child-1', 'assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'found it' }] } })
  dsh.event('child-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const done1 = await nextFrame(server, 'agents', (f) => f.agents[0]?.status === 'done')
  assert.equal(done1.agents[0].summary, 'found it')

  addChild('child-2', sid)
  dsh.event('child-2', 'subagent/descriptor', { label: 'worker' })
  dsh.event('child-2', 'turn/start', { turn: 1 })
  await sleep(150)
  finishTurn(dsh, sid)
  await until(() => doneFrames(server).length === 1, 4000, 'parent done')
  const doneI = server.rec.frames.findIndex((f) => f.type === 'done')

  dsh.event('child-2', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await nextFrame(server, 'agents', (f) => f.agents.some((a) => a.role === 'worker' && a.status === 'done'))
  const lateI = server.rec.frames.findIndex((f) => f.type === 'agents' && f.agents.some((a) => a.role === 'worker' && a.status === 'done'))
  assert.ok(lateI > doneI, 'a lingering child reports after the parent done frame')
  assert.ok(server.rec.frames.filter((f) => f.type === 'agents').every((f) => f.requestId === 'r1'))

  addChild('foreign', 'not-an-omnichat-session')
  dsh.event('foreign', 'subagent/descriptor', { label: 'alien' })
  dsh.event('foreign', 'turn/start', { turn: 1 })
  await sleep(150)
  assert.equal(server.rec.frames.filter((f) => f.type === 'agents' && JSON.stringify(f).includes('alien')).length, 0)
})
