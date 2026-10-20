// Live end-to-end check: acts as the OmniChat app against a real OmniChat server whose
// dsh-bridge is this plugin running inside `dsh web`. Usage (see README "動作確認"):
//   SERVER=http://127.0.0.1:8787 USERNAME=u PASSWORD=p BRIDGE=dsh-live node scripts/live-check.mjs [steps]
// steps (comma separated, default "chat,continue,stop,model"): chat, continue, stop, model, wait-mirror
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const SERVER = process.env.SERVER ?? 'http://127.0.0.1:8787'
const BRIDGE = process.env.BRIDGE ?? 'dsh-live'
const MODEL_REF = process.env.MODEL_REF ?? ''
const steps = (process.argv[2] ?? 'chat,continue,stop,model').split(',')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body, token) {
  const r = await fetch(SERVER + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}

let token = process.env.TOKEN
if (!token) {
  const login = await api('POST', '/auth/login', { username: process.env.USERNAME, password: process.env.PASSWORD })
  token = login.json?.token
}
if (!token) throw new Error('no token (set TOKEN or USERNAME/PASSWORD)')

const ws = new WebSocket(SERVER.replace(/^http/, 'ws') + `/ws?token=${token}`)
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
const frames = []
ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))

const bridges = (await api('GET', '/bridges', undefined, token)).json?.bridges ?? []
console.log('bridges:', JSON.stringify(bridges))
if (!bridges.some((b) => b.name === BRIDGE)) throw new Error(`bridge '${BRIDGE}' is not online`)

const provId = randomUUID()
await api('PUT', `/providers/${provId}`, { name: 'dsh live', kind: 'dsh-bridge', baseUrl: BRIDGE, model: 'x' }, token)
const models = (await api('GET', `/providers/${provId}/models`, undefined, token)).json
console.log('models:', JSON.stringify(models?.models), models?.error ?? '')

const last = (id) => { let m; for (const f of frames) for (const x of f.messages ?? []) if (x.id === id) m = x; return m }
const deltas = (id) => frames.filter((f) => f.type === 'delta' && f.messageId === id)

async function turn(conv, text, { stopAfterDeltas = 0, timeoutMs = 240000 } = {}) {
  const a = randomUUID()
  const t0 = Date.now()
  ws.send(JSON.stringify({ type: 'send', conversationId: conv, content: text, userMessageId: randomUUID(), assistantMessageId: a }))
  let stopped = false
  while (Date.now() - t0 < timeoutMs) {
    const m = last(a)
    if (stopAfterDeltas && !stopped && deltas(a).length >= stopAfterDeltas) {
      ws.send(JSON.stringify({ type: 'stop', messageId: a }))
      stopped = true
    }
    if (m && m.status !== 'streaming') {
      const d = deltas(a)
      console.log(`  -> status=${m.status} deltas=${d.length} ms=${Date.now() - t0} content=${JSON.stringify(m.content.slice(0, 160))}`)
      return m
    }
    await sleep(100)
  }
  throw new Error('timeout waiting for the assistant message')
}

const conv = randomUUID()
await api('PUT', `/conversations/${conv}`, { providerId: provId }, token)

if (steps.includes('chat')) {
  console.log('chat: first message')
  const m = await turn(conv, 'Reply with just the word pong.')
  if (m.status !== 'done') throw new Error('first message did not finish')
}
if (steps.includes('continue')) {
  console.log('continue: second message, same conversation (session continuity)')
  const m = await turn(conv, 'What was the exact word I asked you to reply with in my first message? Answer in one short sentence.')
  if (m.status !== 'done') throw new Error('second message did not finish')
}
if (steps.includes('stop')) {
  console.log('stop: long answer, Stop after a few deltas')
  const conv2 = randomUUID()
  await api('PUT', `/conversations/${conv2}`, { providerId: provId }, token)
  const m = await turn(conv2, 'Write a long, detailed story (at least 600 words) about a lighthouse keeper. Start writing the story immediately.', { stopAfterDeltas: 3 })
  if (m.status !== 'stopped') throw new Error(`expected status stopped, got ${m.status}`)
}
if (steps.includes('model')) {
  const ref = MODEL_REF || models?.models?.find((x) => /e2b/.test(x.id))?.id
  console.log('model: conversation model =', ref)
  const conv3 = randomUUID()
  await api('PUT', `/conversations/${conv3}`, { providerId: provId, model: ref }, token)
  const m = await turn(conv3, 'Reply with just the word ok.')
  if (m.status !== 'done') throw new Error('model message did not finish')
}
if (steps.includes('tool')) {
  console.log('tool: a prompt that makes dsh call a tool (rendered as markdown)')
  const conv4 = randomUUID()
  await api('PUT', `/conversations/${conv4}`, { providerId: provId }, token)
  const m = await turn(conv4, 'Use your file listing / glob tool to list the files in the current workspace directory, then say how many files there are.')
  if (!m.content.includes('🔧')) throw new Error('no tool call marker in the reply: ' + JSON.stringify(m.content.slice(0, 300)))
  console.log('  tool markdown present:', JSON.stringify(m.content.slice(0, 300)))
}
if (steps.includes('wait-mirror')) {
  console.log('wait-mirror: waiting up to 120 s for a mirrored dsh-<sessionId> conversation')
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    const sync = (await api('GET', '/sync?since=0', undefined, token)).json
    const mirrored = (sync?.conversations ?? []).filter((c) => c.id.startsWith('dsh-'))
    for (const c of mirrored) {
      const msgs = (sync.messages ?? []).filter((x) => x.conversationId === c.id).sort((a, b) => a.createdAt - b.createdAt)
      if (msgs.some((x) => x.role === 'user') && msgs.some((x) => x.role === 'assistant' && x.status === 'done')) {
        console.log('mirrored conversation', c.id, 'title=', c.title)
        for (const x of msgs) console.log(`  ${x.role} [${x.status}] ${JSON.stringify(x.content.slice(0, 120))}`)
        ws.close()
        process.exit(0)
      }
    }
    await sleep(1000)
  }
  throw new Error('no mirrored conversation appeared')
}
console.log('OK')
ws.close()
