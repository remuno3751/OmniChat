// @ts-nocheck -- node:test typings are not available in this tsconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ariaHttpBase, ariaFetchJson, AriaHttpError } from '../voice/ariaRest';

test('ariaHttpBase maps the scheme and drops the path', () => {
  assert.equal(ariaHttpBase('wss://a.ts.net/live/ws?x=1'), 'https://a.ts.net');
  assert.equal(ariaHttpBase('ws://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.equal(ariaHttpBase('https://a.ts.net:8443/x'), 'https://a.ts.net:8443');
  assert.equal(ariaHttpBase('ftp://a'), null);
  assert.equal(ariaHttpBase(''), null);
});

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('ariaFetchJson sends the bearer token and a JSON body, and parses the answer', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return res(200, { ok: true }); };
  const r = await ariaFetchJson('http://x', '/llm/model', { method: 'POST', token: 'T', body: { a: 1 }, fetchImpl });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.url, 'http://x/llm/model');
  assert.equal(seen.init.headers.authorization, 'Bearer T');
  assert.equal(seen.init.headers['content-type'], 'application/json');
  assert.equal(seen.init.body, '{"a":1}');
});

test('ariaFetchJson errors carry the status and message but never the token', async () => {
  const fetchImpl = async () => res(403, { detail: 'admin scope required' });
  await assert.rejects(ariaFetchJson('http://x', '/voices', { token: 'SECRET', fetchImpl }), (e) => e instanceof AriaHttpError && e.status === 403 && /admin scope/.test(e.message) && !/SECRET/.test(e.message));
  const net = async () => { throw new Error('boom SECRET'); };
  await assert.rejects(ariaFetchJson('http://x', '/v', { token: 'SECRET', fetchImpl: net }), (e) => e.status === 0 && e.message === 'network');
});

test('ariaFetchJson sends a raw body as it is', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = init; return res(200, ''); };
  const bytes = new Uint8Array([1, 2, 3]);
  await ariaFetchJson('http://x', '/voices/models?name=a.aivmx', { method: 'POST', body: bytes, contentType: 'application/octet-stream', fetchImpl });
  assert.equal(seen.body, bytes);
  assert.equal(seen.headers['content-type'], 'application/octet-stream');
});
