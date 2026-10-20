import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../dist/config.js'

const NO_ENV = {}

test('default mode is local; no server settings needed', () => {
  const r = validateConfig({}, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.config.mode, 'local')
  assert.equal(r.config.listenPort, 19401)
  assert.deepEqual(r.config.allowedOrigins, [])
  assert.equal(r.config.pairingFile, undefined)
  assert.equal(r.config.mirror, true)
  assert.equal(r.config.mirrorScope, 'all')
  assert.equal(r.config.approvals, 'remote')
  assert.equal(r.config.approvalTimeoutMs, 600000)
  assert.ok(r.config.name.length > 0)
  for (const k of ['serverUrl', 'token', 'username', 'password']) assert.equal(k in r.config, false, k)
})

test('local config has exactly the documented fields', () => {
  const r = validateConfig({ pairingFile: '/x/p.json', listenPort: 20001, allowedOrigins: ['https://chat.example.com'], name: 'pc', cwd: '/w' }, NO_ENV)
  assert.deepEqual(Object.keys(r.config).sort(), [
    'allowAnyCwd', 'allowedOrigins', 'approvalTimeoutMs', 'approvals', 'cwd', 'listenPort', 'mirror', 'mirrorScope', 'mode', 'name', 'pairingFile',
  ])
  assert.equal(r.config.pairingFile, '/x/p.json')
  assert.equal(r.config.listenPort, 20001)
  assert.equal(r.config.cwd, '/w')
})

test('mode: raw config wins over OMNICHAT_MODE, which wins over the default', () => {
  assert.equal(validateConfig({ mode: 'remote', serverUrl: 'http://h:1', token: 't' }, { OMNICHAT_MODE: 'local' }).config.mode, 'remote')
  assert.equal(validateConfig({}, { OMNICHAT_MODE: 'remote', OMNICHAT_SERVER_URL: 'http://h:1', OMNICHAT_TOKEN: 't' }).config.mode, 'remote')
  assert.equal(validateConfig({}, { OMNICHAT_MODE: '  remote ' , OMNICHAT_SERVER_URL: 'http://h:1', OMNICHAT_TOKEN: 't' }).config.mode, 'remote')
  assert.equal(validateConfig({ mode: 'local' }, { OMNICHAT_MODE: 'remote' }).config.mode, 'local')
  assert.equal(validateConfig({ mode: '' }, NO_ENV).config.mode, 'local')
})

test('invalid mode is an error that does not echo the value', () => {
  const r = validateConfig({ mode: 'SECRET-MODE' }, NO_ENV)
  assert.equal(r.config, null)
  assert.deepEqual(r.errors, ['mode must be "local" or "remote"'])
  assert.ok(!r.errors.join(';').includes('SECRET-MODE'))
  assert.match(validateConfig({}, { OMNICHAT_MODE: 'cloud' }).errors.join(';'), /mode must be "local" or "remote"/)
})

test('remote mode keeps today\'s behaviour and output, plus mode', () => {
  let r = validateConfig({ mode: 'remote' }, NO_ENV)
  assert.equal(r.config, null)
  assert.match(r.errors.join(';'), /serverUrl is required/)
  assert.match(r.errors.join(';'), /credentials missing/)

  r = validateConfig({ mode: 'remote', serverUrl: 'ftp://x', token: 'SECRET' }, NO_ENV)
  assert.match(r.errors.join(';'), /serverUrl must be an http\(s\):\/\/ or ws\(s\):\/\/ URL/)
  assert.ok(!r.errors.join(';').includes('SECRET'))

  r = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', token: 't', mirrorScope: 'nope', approvals: 'x', mirror: 'maybe' }, NO_ENV)
  assert.equal(r.errors.length, 3)

  r = validateConfig({ mode: 'remote', serverUrl: 'http://h:1', username: 'u', password: 'p' }, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(Object.keys(r.config).sort(), [
    'allowAnyCwd', 'approvalTimeoutMs', 'approvals', 'cwd', 'mirror', 'mirrorScope', 'mode', 'name', 'password', 'serverUrl', 'token', 'username',
  ])
  assert.equal(r.config.mode, 'remote')
  assert.equal(r.config.serverUrl, 'http://h:1/')
  assert.equal(r.config.mirror, true)
  assert.equal(r.config.mirrorScope, 'all')
  assert.equal(r.config.approvals, 'remote')
  assert.equal(r.config.password, 'p')

  // env fallbacks still apply in remote mode
  r = validateConfig({ mode: 'remote' }, { OMNICHAT_SERVER_URL: 'https://c.example.com', OMNICHAT_TOKEN: 'tok' })
  assert.equal(r.config.serverUrl, 'https://c.example.com/')
  assert.equal(r.config.token, 'tok')
})

test('local mode ignores server settings with a warning, not an error', () => {
  const r = validateConfig({ serverUrl: 'ftp://not-checked', token: 'SECRET-TOKEN', username: 'u', password: 'SECRET-PW' }, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.ok(r.config)
  assert.deepEqual(r.warnings, [
    '"serverUrl" is ignored in local mode',
    '"token" is ignored in local mode',
    '"username" is ignored in local mode',
    '"password" is ignored in local mode',
  ])
  assert.ok(!JSON.stringify(r).includes('SECRET'))
})

test('no warnings for empty server settings in local mode', () => {
  const r = validateConfig({ serverUrl: '', token: null, username: undefined }, NO_ENV)
  assert.deepEqual(r.warnings, [])
})

test('listenPort: default, env fallback, digit strings, and range errors', () => {
  assert.equal(validateConfig({}, { OMNICHAT_LOCAL_PORT: '20100' }).config.listenPort, 20100)
  assert.equal(validateConfig({ listenPort: 20200 }, { OMNICHAT_LOCAL_PORT: '20100' }).config.listenPort, 20200)
  assert.equal(validateConfig({ listenPort: '1' }, NO_ENV).config.listenPort, 1)
  assert.equal(validateConfig({ listenPort: ' 65535 ' }, NO_ENV).config.listenPort, 65535)
  for (const bad of [0, 65536, 1.5, '0', '65536', 'abc', '12x', -3, NaN, true]) {
    const r = validateConfig({ listenPort: bad }, NO_ENV)
    assert.equal(r.config, null, String(bad))
    assert.deepEqual(r.errors, ['listenPort must be an integer between 1 and 65535'], String(bad))
  }
  assert.match(validateConfig({}, { OMNICHAT_LOCAL_PORT: 'nope' }).errors.join(';'), /listenPort must be an integer/)
})

test('allowedOrigins: array or comma string, normalised to origins and deduped', () => {
  let r = validateConfig({ allowedOrigins: ['https://chat.example.com/some/path', 'https://chat.example.com', 'http://192.168.1.10:8787', 'tauri://localhost'] }, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.config.allowedOrigins, ['https://chat.example.com', 'http://192.168.1.10:8787', 'tauri://localhost'])

  r = validateConfig({ allowedOrigins: ' https://a.example.com , ,https://b.example.com:443,https://a.example.com ' }, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.config.allowedOrigins, ['https://a.example.com', 'https://b.example.com'])

  r = validateConfig({ allowedOrigins: '' }, NO_ENV)
  assert.deepEqual(r.config.allowedOrigins, [])
})

test('allowedOrigins: invalid entries are errors naming the entry', () => {
  let r = validateConfig({ allowedOrigins: ['https://ok.example.com', 'javascript:alert(1)'] }, NO_ENV)
  assert.equal(r.config, null)
  assert.deepEqual(r.errors, ['allowedOrigins entry "javascript:alert(1)" is not an origin (e.g. https://chat.example.com)'])

  r = validateConfig({ allowedOrigins: 'not a url' }, NO_ENV)
  assert.match(r.errors.join(';'), /allowedOrigins entry "not a url" is not an origin/)

  r = validateConfig({ allowedOrigins: 'tauri://other-app' }, NO_ENV)
  assert.match(r.errors.join(';'), /allowedOrigins entry "tauri:\/\/other-app" is not an origin/)

  r = validateConfig({ allowedOrigins: 'ws://chat.example.com' }, NO_ENV)
  assert.match(r.errors.join(';'), /is not an origin/)

  r = validateConfig({ allowedOrigins: 42 }, NO_ENV)
  assert.match(r.errors.join(';'), /allowedOrigins must be an array of strings or a comma separated string/)

  r = validateConfig({ allowedOrigins: [{ origin: 'https://x.example.com' }] }, NO_ENV)
  assert.match(r.errors.join(';'), /allowedOrigins entries must be strings/)
})

test('pairingFile: optional string path', () => {
  assert.equal(validateConfig({ pairingFile: '  /x/p.json  ' }, NO_ENV).config.pairingFile, '/x/p.json')
  assert.equal(validateConfig({ pairingFile: '' }, NO_ENV).config.pairingFile, undefined)
  const r = validateConfig({ pairingFile: 5 }, NO_ENV)
  assert.deepEqual(r.errors, ['pairingFile must be a string path'])
})

test('shared fields are validated the same way in local mode', () => {
  let r = validateConfig({ mirrorScope: 'nope', approvals: 'x', mirror: 'maybe', approvalTimeoutMs: -1 }, NO_ENV)
  assert.equal(r.config, null)
  assert.equal(r.errors.length, 4)
  assert.match(r.errors.join(';'), /mirrorScope must be "all" or "cwd"/)
  assert.match(r.errors.join(';'), /approvals must be "remote", "gui" or "deny"/)
  assert.match(r.errors.join(';'), /mirror must be true or false/)
  assert.match(r.errors.join(';'), /approvalTimeoutMs must be a positive integer/)

  r = validateConfig({ approvalTimeoutMs: '5000', approvals: 'gui', mirror: 'off', mirrorScope: 'cwd' }, NO_ENV)
  assert.deepEqual(r.errors, [])
  assert.equal(r.config.approvalTimeoutMs, 5000)
  assert.equal(r.config.approvals, 'gui')
  assert.equal(r.config.mirror, false)
  assert.equal(r.config.mirrorScope, 'cwd')
})

test('local-mode errors never contain secret values', () => {
  const r = validateConfig({ token: 'SECRET-LOCAL-TOKEN', password: 'SECRET-LOCAL-PW', listenPort: 'x', allowedOrigins: ['not a url'] }, NO_ENV)
  assert.equal(r.config, null)
  assert.ok(r.errors.length >= 2)
  assert.ok(!r.errors.join('\n').includes('SECRET-LOCAL'))
})

test('unknown keys still warn, and the new keys are not reported as unknown', () => {
  const r = validateConfig({ bogus: 1, listenPort: 19500, allowedOrigins: [], pairingFile: '/p', mode: 'local' }, NO_ENV)
  assert.deepEqual(r.warnings, ['unknown config key "bogus" ignored'])
})

test('never throws on odd input', () => {
  for (const raw of [null, undefined, 'x', [], 7]) {
    assert.doesNotThrow(() => validateConfig(raw, NO_ENV))
    assert.ok(validateConfig(raw, NO_ENV).config)
  }
})
