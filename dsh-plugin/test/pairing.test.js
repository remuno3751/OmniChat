import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addAllowedOrigin, dshHome, defaultPairingFile, loadOrCreatePairing, markPaired, readPairing, regeneratePairing, safeEqual, savePairing, setListenPort,
} from '../dist/pairing.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAIR_CLI = path.resolve(HERE, '..', 'dist', 'pair.js')

const dirs = []
function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omnichat-pairing-test-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true })
})

test('dshHome and defaultPairingFile honour DSH_HOME and fall back to ~/.dsh', () => {
  assert.equal(dshHome({ DSH_HOME: '/custom/dsh' }), '/custom/dsh')
  assert.equal(dshHome({ DSH_HOME: '' }), path.join(os.homedir(), '.dsh'))
  assert.equal(dshHome({}), path.join(os.homedir(), '.dsh'))
  assert.equal(defaultPairingFile({ DSH_HOME: '/custom/dsh' }), path.join('/custom/dsh', 'omnichat-bridge.json'))
})

test('create: fresh file with a 32-byte base64url pairing, parent directories created', () => {
  const file = path.join(scratch(), 'nested', 'deeper', 'omnichat-bridge.json')
  const r = loadOrCreatePairing({ file, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) })
  assert.equal(r.file, file)
  assert.equal(r.created, true)
  assert.equal(r.data.version, 1)
  assert.equal(r.data.pairing.length, 43) // 32 bytes in base64url
  assert.match(r.data.pairing, /^[A-Za-z0-9_-]+$/)
  assert.equal(r.data.createdAt, '2026-01-02T03:04:05.000Z')
  assert.deepEqual(r.data.allowedOrigins, [])
  assert.equal('pairedAt' in r.data, false)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, r.data)
  // no temp files left behind
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['omnichat-bridge.json'])
})

test('create uses the injected randomBytes', () => {
  const file = path.join(scratch(), 'p.json')
  const r = loadOrCreatePairing({ file, randomBytes: (n) => Buffer.alloc(n, 7) })
  assert.equal(r.data.pairing, Buffer.alloc(32, 7).toString('base64url'))
})

test('reuse: the same pairing is returned on every load and nothing is rewritten', () => {
  const file = path.join(scratch(), 'p.json')
  const first = loadOrCreatePairing({ file })
  const bytes = fs.readFileSync(file, 'utf8')
  const second = loadOrCreatePairing({ file, randomBytes: () => Buffer.alloc(32, 1) })
  assert.equal(second.created, false)
  assert.equal(second.data.pairing, first.data.pairing)
  assert.equal(fs.readFileSync(file, 'utf8'), bytes)
})

test('corrupt or invalid files are regenerated', () => {
  const dir = scratch()
  const cases = {
    'garbage.json': '{not json',
    'short.json': JSON.stringify({ version: 1, pairing: 'too-short' }),
    'number.json': JSON.stringify({ version: 1, pairing: 12345678901234567890123456789012345 }),
    'array.json': JSON.stringify(['x'.repeat(40)]),
    'empty.json': '',
  }
  for (const [name, content] of Object.entries(cases)) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, content)
    assert.equal(readPairing(file), null, name)
    const r = loadOrCreatePairing({ file })
    assert.equal(r.created, true, name)
    assert.ok(r.data.pairing.length >= 32, name)
    assert.equal(readPairing(file).pairing, r.data.pairing, name)
  }
})

test('readPairing returns null for a missing file and never throws', () => {
  assert.equal(readPairing(path.join(scratch(), 'missing.json')), null)
  assert.equal(readPairing(undefined), null)
})

test('reads are fresh: edits by another process are seen', () => {
  const file = path.join(scratch(), 'p.json')
  const { data } = loadOrCreatePairing({ file })
  fs.writeFileSync(file, JSON.stringify({ ...data, pairing: 'x'.repeat(40) }))
  assert.equal(readPairing(file).pairing, 'x'.repeat(40))
})

test('markPaired sets pairedAt once and keeps it', () => {
  const file = path.join(scratch(), 'p.json')
  loadOrCreatePairing({ file })
  const a = markPaired(file, () => Date.UTC(2026, 5, 1))
  assert.equal(a.pairedAt, '2026-06-01T00:00:00.000Z')
  const b = markPaired(file, () => Date.UTC(2027, 0, 1))
  assert.equal(b.pairedAt, '2026-06-01T00:00:00.000Z')
  assert.equal(readPairing(file).pairedAt, '2026-06-01T00:00:00.000Z')
})

test('addAllowedOrigin appends once and persists', () => {
  const file = path.join(scratch(), 'p.json')
  loadOrCreatePairing({ file })
  addAllowedOrigin(file, 'https://chat.example.com')
  const r = addAllowedOrigin(file, 'https://chat.example.com')
  assert.deepEqual(r.allowedOrigins, ['https://chat.example.com'])
  addAllowedOrigin(file, 'tauri://localhost')
  assert.deepEqual(readPairing(file).allowedOrigins, ['https://chat.example.com', 'tauri://localhost'])
})

test('setListenPort stores the port', () => {
  const file = path.join(scratch(), 'p.json')
  loadOrCreatePairing({ file })
  setListenPort(file, 20123)
  assert.equal(readPairing(file).listenPort, 20123)
})

test('mutators return null and do not create a file when there is no valid pairing file', () => {
  const dir = scratch()
  const file = path.join(dir, 'absent.json')
  assert.equal(markPaired(file), null)
  assert.equal(addAllowedOrigin(file, 'https://x.example.com'), null)
  assert.equal(setListenPort(file, 1234), null)
  assert.equal(fs.existsSync(file), false)
  fs.writeFileSync(file, '{broken')
  assert.equal(setListenPort(file, 1234), null)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})

test('savePairing writes atomically and reports I/O failure without throwing', () => {
  const dir = scratch()
  const file = path.join(dir, 'p.json')
  const { data } = loadOrCreatePairing({ file })
  assert.equal(savePairing(file, { ...data, listenPort: 19999 }), true)
  assert.equal(readPairing(file).listenPort, 19999)
  // a path under a regular file cannot be created
  assert.equal(savePairing(path.join(file, 'nope.json'), data), false)
})

test('loadOrCreatePairing throws a clear Error when the directory cannot be created', () => {
  const dir = scratch()
  const blocker = path.join(dir, 'blocker')
  fs.writeFileSync(blocker, 'x')
  assert.throws(
    () => loadOrCreatePairing({ file: path.join(blocker, 'sub', 'p.json') }),
    (e) => e instanceof Error && /cannot create OmniChat pairing file/.test(e.message),
  )
})

test('safeEqual: equal, different, different lengths, non-strings', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('', 'a'), false)
  assert.equal(safeEqual('é', 'e'), false) // multi-byte, different byte length
  assert.equal(safeEqual(undefined, 'a'), false)
  assert.equal(safeEqual('a', null), false)
  assert.equal(safeEqual(1, 1), false)
  const s = crypto.randomBytes(32).toString('base64url')
  assert.equal(safeEqual(s, s.slice()), true)
})

test('pair.js CLI: prints code, address and file with --file', () => {
  const file = path.join(scratch(), 'p.json')
  const { data } = loadOrCreatePairing({ file })
  const out = execFileSync(process.execPath, [PAIR_CLI, '--file', file], { encoding: 'utf8', cwd: os.tmpdir() })
  assert.equal(out, `OmniChat pairing code: ${data.pairing}\nLocal address: ws://127.0.0.1:19401/omnichat-bridge\nFile: ${file}\n`)
  // does not create anything when the file is absent
  assert.equal(readPairing(file).pairing, data.pairing)
})

test('pair.js CLI: uses listenPort from the file and --json output', () => {
  const file = path.join(scratch(), 'p.json')
  const { data } = loadOrCreatePairing({ file })
  setListenPort(file, 20777)
  markPaired(file)
  const out = execFileSync(process.execPath, [PAIR_CLI, '--file', file, '--json'], { encoding: 'utf8', cwd: os.tmpdir() })
  const j = JSON.parse(out)
  assert.deepEqual(Object.keys(j).sort(), ['code', 'file', 'paired', 'port', 'url'])
  assert.equal(j.code, data.pairing)
  assert.equal(j.port, 20777)
  assert.equal(j.url, 'ws://127.0.0.1:20777/omnichat-bridge')
  assert.equal(j.file, file)
  assert.equal(j.paired, true)
})

test('pair.js CLI: --home resolves <home>/omnichat-bridge.json', () => {
  const home = scratch()
  const { data } = loadOrCreatePairing({ file: path.join(home, 'omnichat-bridge.json') })
  const j = JSON.parse(execFileSync(process.execPath, [PAIR_CLI, '--home', home, '--json'], { encoding: 'utf8', cwd: os.tmpdir() }))
  assert.equal(j.code, data.pairing)
  assert.equal(j.paired, false)
})

test('pair.js CLI: missing file is a clear stderr message with exit 1 and no file is created', () => {
  const dir = scratch()
  const file = path.join(dir, 'none.json')
  let err
  try {
    execFileSync(process.execPath, [PAIR_CLI, '--file', file], { encoding: 'utf8', cwd: os.tmpdir(), stdio: 'pipe' })
  } catch (e) {
    err = e
  }
  assert.ok(err, 'expected a non-zero exit')
  assert.equal(err.status, 1)
  assert.equal(err.stdout, '')
  assert.equal(
    err.stderr,
    `No pairing file at ${file}. Start dsh once with the omnichat-bridge plugin installed (local mode).\n`,
  )
  assert.equal(fs.existsSync(file), false)
})

test('pair.js CLI: unknown argument exits 2', () => {
  let err
  try {
    execFileSync(process.execPath, [PAIR_CLI, '--bogus'], { encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    err = e
  }
  assert.equal(err.status, 2)
  assert.match(err.stderr, /unknown argument "--bogus"/)
})

test('regeneratePairing: fresh secret, pairedAt and allowedOrigins cleared, listenPort kept, written atomically', () => {
  const file = path.join(scratch(), 'omnichat-bridge.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    pairing: 'o'.repeat(43),
    createdAt: '2026-01-01T00:00:00.000Z',
    pairedAt: '2026-01-02T00:00:00.000Z',
    allowedOrigins: ['https://chat.example.com'],
    listenPort: 19555,
  }))
  const data = regeneratePairing({
    file,
    randomBytes: (n) => Buffer.alloc(n, 7),
    now: () => Date.UTC(2026, 9, 17),
  })
  const expected = Buffer.alloc(32, 7).toString('base64url')
  assert.equal(data.pairing, expected)
  assert.notEqual(data.pairing, 'o'.repeat(43))
  assert.equal(data.createdAt, '2026-10-17T00:00:00.000Z')
  assert.equal('pairedAt' in data, false)
  assert.deepEqual(data.allowedOrigins, [])
  assert.equal(data.listenPort, 19555)
  assert.deepEqual(readPairing(file), data)
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['omnichat-bridge.json'])
})

test('regeneratePairing: no previous file is fine (no listenPort); unwritable target throws without a secret in the message', () => {
  const dir = scratch()
  const file = path.join(dir, 'omnichat-bridge.json')
  const data = regeneratePairing({ file })
  assert.equal(data.listenPort, undefined)
  assert.equal(readPairing(file).pairing, data.pairing)
  const blocked = path.join(dir, 'file-not-dir')
  fs.writeFileSync(blocked, 'x')
  assert.throws(() => regeneratePairing({ file: path.join(blocked, 'omnichat-bridge.json') }), (e) => {
    assert.match(e.message, /cannot write OmniChat pairing file/)
    assert.equal(e.message.includes(data.pairing), false)
    return true
  })
})
