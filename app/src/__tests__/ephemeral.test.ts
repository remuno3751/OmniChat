// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EPH_MAX_LIVE,
  EPH_PREFIX,
  dropEphemeralFrom,
  ephemeralConvIds,
  isEphemeralId,
  isRemoteProviderUrl,
  newEphemeralId,
  stripEphemeral,
} from '../ephemeral'

test('EPH_PREFIX and EPH_MAX_LIVE', () => {
  assert.equal(EPH_PREFIX, 'eph_')
  assert.equal(EPH_MAX_LIVE, 5)
})

test('isEphemeralId', () => {
  assert.equal(isEphemeralId('eph_abc'), true)
  assert.equal(isEphemeralId('eph_'), true)
  assert.equal(isEphemeralId('abc'), false)
  assert.equal(isEphemeralId('EPH_abc'), false)
  assert.equal(isEphemeralId('xeph_abc'), false)
  assert.equal(isEphemeralId(''), false)
  assert.equal(isEphemeralId(null), false)
  assert.equal(isEphemeralId(undefined), false)
})

test('newEphemeralId prefixes the generated id', () => {
  assert.equal(newEphemeralId(() => '1234'), 'eph_1234')
  const id = newEphemeralId(() => 'x')
  assert.ok(isEphemeralId(id))
})

test('isRemoteProviderUrl: local and LAN hosts are not remote', () => {
  const local = [
    'http://localhost:1234/v1',
    'http://localhost',
    'http://api.localhost:8080',
    'http://127.0.0.1:1234/v1',
    'http://127.255.0.9',
    'http://10.1.2.3:8080',
    'http://172.16.0.1/v1',
    'http://172.31.255.254',
    'http://192.168.1.20:11434',
    'http://169.254.10.10',
    'http://[::1]:1234/v1',
    'http://[fd12:3456::1]/v1',
    'http://[fc00::1]/v1',
    'http://[fe80::1]/v1',
    'http://printer.local:631',
    'http://nas.lan/api',
    'http://box.internal',
    'http://mybox:1234',
    'localhost:1234',
    'user:pw@192.168.0.5:8000',
  ]
  for (const u of local) assert.equal(isRemoteProviderUrl(u), false, u)
})

test('isRemoteProviderUrl: public and unknown hosts are remote', () => {
  const remote = [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'http://172.15.0.1/v1',
    'http://172.32.0.1/v1',
    'http://11.0.0.1',
    'http://192.169.1.1',
    'http://100.64.0.1',
    'http://[2001:db8::1]/v1',
    'https://example.com.lan.evil.com',
    'https://lan.example.com',
    'https://mylocal.example.org:443/',
    'http://8.8.8.8',
  ]
  for (const u of remote) assert.equal(isRemoteProviderUrl(u), true, u)
})

test('isRemoteProviderUrl: unparsable input counts as remote', () => {
  assert.equal(isRemoteProviderUrl(''), true)
  assert.equal(isRemoteProviderUrl('   '), true)
  assert.equal(isRemoteProviderUrl('http://'), true)
  assert.equal(isRemoteProviderUrl('http://[::1'), true)
})

test('ephemeralConvIds lists prefixed ids and flagged rows', () => {
  const convs = {
    eph_a: { id: 'eph_a' },
    b: { id: 'b', ephemeral: true },
    c: { id: 'c' },
  }
  assert.deepEqual(ephemeralConvIds(convs).sort(), ['b', 'eph_a'])
})

test('stripEphemeral does not mutate its input and removes both maps entries', () => {
  const input = {
    conversations: {
      n1: { id: 'n1', title: 'normal' },
      eph_1: { id: 'eph_1', title: 'Ephemeral chat', ephemeral: true },
      flag: { id: 'flag', ephemeral: true },
    },
    messages: {
      n1: { m1: { id: 'm1', conversationId: 'n1', content: 'hi' } },
      eph_1: { eph_m1: { id: 'eph_m1', conversationId: 'eph_1', content: 'secret' } },
      flag: { mx: { id: 'mx', conversationId: 'flag', content: 'secret' } },
    },
    providers: { p1: { id: 'p1' } },
  }
  const snapshot = JSON.parse(JSON.stringify(input))
  const out = stripEphemeral(input)

  assert.deepEqual(input, snapshot, 'input must not be mutated')
  assert.deepEqual(Object.keys(out.conversations), ['n1'])
  assert.deepEqual(Object.keys(out.messages), ['n1'])
  assert.deepEqual(out.providers, { p1: { id: 'p1' } })
  assert.notEqual(out.conversations, input.conversations)
  assert.equal(out.messages.n1, input.messages.n1)
})

test('stripEphemeral keeps everything when there is no ephemeral data', () => {
  const input = { conversations: { a: { id: 'a' } }, messages: { a: { m: { id: 'm' } } } }
  const out = stripEphemeral(input)
  assert.deepEqual(out, input)
})

test('dropEphemeralFrom with an explicit id set drops only those', () => {
  const convs = { eph_1: { id: 'eph_1' }, eph_2: { id: 'eph_2' }, n: { id: 'n' } }
  const msgs = { eph_1: { x: { id: 'x' } }, eph_2: { y: { id: 'y' } }, n: { z: { id: 'z' } } }
  const r = dropEphemeralFrom(convs, msgs, new Set(['eph_1']))
  assert.deepEqual(Object.keys(r.conversations).sort(), ['eph_2', 'n'])
  assert.deepEqual(Object.keys(r.messages).sort(), ['eph_2', 'n'])
  assert.deepEqual(Object.keys(convs).sort(), ['eph_1', 'eph_2', 'n'], 'input untouched')
})
