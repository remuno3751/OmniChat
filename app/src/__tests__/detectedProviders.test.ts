// Run: node --import tsx --test src/__tests__/detectedProviders.test.ts
// @ts-nocheck -- node:test typings are not available in this tsconfig.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, visibleServers, pickAddModel } from '../detectedServers'

const srv = (name, baseUrl, modelIds) => ({ name, kind: 'openai-compatible', baseUrl, models: modelIds ? modelIds.length : 0, modelIds })

test('normalizeUrl trims, drops trailing slashes and lowercases', () => {
  assert.equal(normalizeUrl('  HTTP://Localhost:1234/v1/// '), 'http://localhost:1234/v1')
})

test('visibleServers excludes servers already configured, ignoring trailing slash and case', () => {
  const found = [srv('LM Studio', 'http://localhost:1234/v1'), srv('Ollama', 'http://LOCALHOST:11434/v1/')]
  const providers = [{ baseUrl: 'http://localhost:1234/v1/' }]
  const out = visibleServers(found, providers)
  assert.deepEqual(out.map((s) => s.name), ['Ollama'])
})

test('visibleServers dedupes by normalized baseUrl, first wins', () => {
  const found = [srv('A', 'http://h:1/v1'), srv('B', 'HTTP://H:1/v1/'), srv('C', 'http://h:2/v1')]
  const out = visibleServers(found, [])
  assert.deepEqual(out.map((s) => s.name), ['A', 'C'])
})

test('visibleServers tolerates garbage input', () => {
  assert.deepEqual(visibleServers(null, null), [])
  assert.deepEqual(visibleServers(undefined, undefined), [])
  assert.deepEqual(visibleServers({}, 'x'), [])
  const found = [null, undefined, { name: 'no url' }, { name: 'num', baseUrl: 42 }, srv('ok', 'http://ok/v1')]
  const providers = [null, {}, { baseUrl: null }, { baseUrl: 'http://other' }]
  assert.deepEqual(visibleServers(found, providers).map((s) => s.name), ['ok'])
})

test('pickAddModel skips embedding and rerank models', () => {
  assert.equal(pickAddModel(srv('x', 'u', ['text-embedding-nomic', 'llama3', 'qwen'])), 'llama3')
  assert.equal(pickAddModel(srv('x', 'u', ['bge-reranker-v2', 'Embed-small', 'chat-1'])), 'chat-1')
})

test('pickAddModel falls back to the first model when all are embedding/rerank', () => {
  assert.equal(pickAddModel(srv('x', 'u', ['nomic-embed', 'bge-rerank'])), 'nomic-embed')
})

test('pickAddModel returns default when there are no models', () => {
  assert.equal(pickAddModel(srv('x', 'u', [])), 'default')
  assert.equal(pickAddModel(srv('x', 'u')), 'default')
  assert.equal(pickAddModel(srv('x', 'u', ['', null, 7])), 'default')
  assert.equal(pickAddModel(null), 'default')
  assert.equal(pickAddModel({ name: 'x', baseUrl: 'u', modelIds: 'not-array' }), 'default')
})
