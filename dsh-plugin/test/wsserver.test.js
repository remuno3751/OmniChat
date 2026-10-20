import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { MiniWsServer } from '../dist/wsserver.js';

const text = (msg) => msg.data.toString();

async function startServer(opts = {}) {
  const conns = [];
  const srv = new MiniWsServer({
    hosts: ['127.0.0.1'],
    port: 0,
    onConnection(sock, req) {
      conns.push({ sock, req });
      sock.addEventListener('message', (e) => sock.send(e.data));
    },
    ...opts,
  });
  const [{ port }] = await srv.listen();
  return { srv, port, url: `ws://127.0.0.1:${port}/omnichat-bridge`, conns };
}

async function openClient(url, options) {
  const ws = new WebSocket(url, options);
  await once(ws, 'open');
  return ws;
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (data) => resolve({ data })));
}

function nextServerClose(sock) {
  return new Promise((resolve) => sock.addEventListener('close', resolve));
}

// Masked client frame builder; payloads up to 125 bytes only.
function maskedFrame(fin, opcode, payload) {
  assert.ok(payload.length < 126);
  const mask = randomBytes(4);
  const head = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  const body = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// Parses one unmasked server frame from the front of buf, or returns null.
function parseServerFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    len = Number(b.readBigUInt64BE(2));
    off = 10;
  }
  if (b.length < off + len) return null;
  return { opcode, payload: b.subarray(off, off + len), size: off + len };
}

// Raw TCP client that performs the upgrade by hand and reads frames.
async function openRaw(port) {
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.on('error', () => {});
  let buf = Buffer.alloc(0);
  const waiters = new Set();
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    for (const w of [...waiters]) w();
  });
  const until = (pred) =>
    new Promise((resolve) => {
      const check = () => {
        if (pred()) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });

  await once(sock, 'connect');
  const key = randomBytes(16).toString('base64');
  sock.write(
    `GET /omnichat-bridge HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  await until(() => buf.indexOf('\r\n\r\n') >= 0);
  const idx = buf.indexOf('\r\n\r\n');
  const head = buf.subarray(0, idx).toString();
  buf = buf.subarray(idx + 4);
  assert.match(head, /^HTTP\/1\.1 101 /);

  return {
    sock,
    async readFrame() {
      let frame;
      await until(() => (frame = parseServerFrame(buf)) !== null);
      buf = buf.subarray(frame.size);
      return frame;
    },
  };
}

test('echoes text both ways, incl. 16/64-bit lengths and unicode', async () => {
  const { srv, url, conns } = await startServer();
  const ws = await openClient(url);
  try {
    ws.send('hi');
    assert.equal(text(await nextMessage(ws)), 'hi');

    const mid = 'm'.repeat(300);
    ws.send(mid);
    assert.equal(text(await nextMessage(ws)), mid);

    const big = 'b'.repeat(70001);
    ws.send(big);
    assert.equal(text(await nextMessage(ws)), big);

    const uni = 'a€日本🙂😀ñz';
    assert.equal(Array.from(uni).length, 8);
    ws.send(uni);
    assert.equal(text(await nextMessage(ws)), uni);

    // Server -> client, 16-bit and 64-bit lengths.
    const srvSock = conns[0].sock;
    const mid2 = 'M'.repeat(300);
    const pending1 = nextMessage(ws);
    srvSock.send(mid2);
    assert.equal(text(await pending1), mid2);

    const big2 = 'B'.repeat(70001);
    const pending2 = nextMessage(ws);
    srvSock.send(big2);
    assert.equal(text(await pending2), big2);
  } finally {
    ws.terminate();
    await srv.close();
  }
});

test('server ping reaches client; client ping gets a pong', async () => {
  const { srv, url, conns } = await startServer();
  const ws = await openClient(url);
  try {
    const gotPing = once(ws, 'ping');
    conns[0].sock.ping('p1');
    const [pingData] = await gotPing;
    assert.equal(pingData.toString(), 'p1');

    const gotPong = once(ws, 'pong');
    ws.ping('q1');
    const [pongData] = await gotPong;
    assert.equal(pongData.toString(), 'q1');
  } finally {
    ws.terminate();
    await srv.close();
  }
});

test('close code and reason round-trip in both directions', async () => {
  const { srv, url, conns } = await startServer();

  // client -> server
  const ws1 = await openClient(url);
  const srvClose1 = nextServerClose(conns[0].sock);
  const cliClose1 = once(ws1, 'close');
  ws1.close(4001, 'client-bye');
  const ev1 = await srvClose1;
  assert.equal(ev1.code, 4001);
  assert.equal(ev1.reason, 'client-bye');
  const [cc1, cr1] = await cliClose1;
  assert.equal(cc1, 4001);
  assert.equal(cr1.toString(), 'client-bye');

  // server -> client
  const ws2 = await openClient(url);
  const cliClose2 = once(ws2, 'close');
  const srvClose2 = nextServerClose(conns[1].sock);
  conns[1].sock.close(4002, 'srv-bye');
  const [cc2, cr2] = await cliClose2;
  assert.equal(cc2, 4002);
  assert.equal(cr2.toString(), 'srv-bye');
  const ev2 = await srvClose2;
  assert.equal(ev2.code, 4002);
  assert.equal(ev2.reason, 'srv-bye');

  await srv.close();
});

test('binary frame from client closes the connection with 1003', async () => {
  const { srv, url, conns } = await startServer();
  const ws = await openClient(url);
  try {
    const srvClose = nextServerClose(conns[0].sock);
    const cliClose = once(ws, 'close');
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const [code] = await cliClose;
    assert.equal(code, 1003);
    assert.equal((await srvClose).code, 1003);
  } finally {
    ws.terminate();
    await srv.close();
  }
});

test('wrong path is rejected with 404', async () => {
  const { srv, port } = await startServer();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong-path`);
  ws.on('error', () => {});
  try {
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 404);
  } finally {
    ws.terminate();
    await srv.close();
  }
});

test('plain HTTP request gets 404 with an empty body', async () => {
  const { srv, port } = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/omnichat-bridge`, resolve).on('error', reject);
    });
    assert.equal(res.statusCode, 404);
    let body = '';
    res.on('data', (c) => (body += c));
    await once(res, 'end');
    assert.equal(body, '');
  } finally {
    await srv.close();
  }
});

test('allowedHosts rejects a foreign Host header with 403', async () => {
  const { srv, port, url } = await startServer({
    allowedHosts: (h) => /^127\.0\.0\.1(:\d+)?$/.test(h ?? ''),
  });
  try {
    const ok = await openClient(url);
    ok.terminate();

    const evil = new WebSocket(url, { headers: { Host: 'evil.example' } });
    evil.on('error', () => {});
    const [, res] = await once(evil, 'unexpected-response');
    assert.equal(res.statusCode, 403);
    evil.terminate();
    assert.ok(port > 0);
  } finally {
    await srv.close();
  }
});

test('checkUpgrade: false -> 403, numeric status -> that status, true -> open', async () => {
  const { srv, url } = await startServer({
    checkUpgrade: (req) => {
      const t = req.headers['x-token'];
      if (t === 'ok') return true;
      if (t === 'teapot') return 401;
      return false;
    },
  });
  try {
    const none = new WebSocket(url);
    none.on('error', () => {});
    const [, res403] = await once(none, 'unexpected-response');
    assert.equal(res403.statusCode, 403);
    none.terminate();

    const numeric = new WebSocket(url, { headers: { 'x-token': 'teapot' } });
    numeric.on('error', () => {});
    const [, res401] = await once(numeric, 'unexpected-response');
    assert.equal(res401.statusCode, 401);
    numeric.terminate();

    const good = await openClient(url, { headers: { 'x-token': 'ok' } });
    good.terminate();
  } finally {
    await srv.close();
  }
});

test('port 0 binds loopback only, every address shares the first port', async () => {
  const srv = new MiniWsServer({ port: 0, onConnection() {} });
  const addrs = await srv.listen();
  try {
    assert.ok(addrs.length >= 1);
    assert.ok(addrs.some((a) => a.address === '127.0.0.1'));
    for (const a of addrs) {
      assert.ok(['127.0.0.1', '::1'].includes(a.address), `unexpected bind ${a.address}`);
      assert.notEqual(a.address, '0.0.0.0');
      assert.notEqual(a.address, '::');
      assert.notEqual(a.port, 0);
      assert.equal(a.port, addrs[0].port);
    }
    const ws = await openClient(`ws://127.0.0.1:${addrs[0].port}/omnichat-bridge`);
    ws.terminate();
    if (addrs.some((a) => a.address === '::1')) {
      const ws6 = await openClient(`ws://[::1]:${addrs[0].port}/omnichat-bridge`);
      ws6.terminate();
    }
  } finally {
    await srv.close();
  }
});

test('listen rejects when 127.0.0.1 is already in use', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  const srv = new MiniWsServer({ hosts: ['127.0.0.1'], port, onConnection() {} });
  try {
    await assert.rejects(srv.listen(), { code: 'EADDRINUSE' });
  } finally {
    await srv.close();
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('multiple clients are independent and req headers are passed through', async () => {
  const { srv, url, conns } = await startServer();
  const a = await openClient(url, { headers: { Origin: 'http://localhost:9999' } });
  const b = await openClient(url);
  try {
    assert.equal(conns[0].req.headers.origin, 'http://localhost:9999');
    const pa = nextMessage(a);
    const pb = nextMessage(b);
    a.send('from-a');
    b.send('from-b');
    assert.equal(text(await pa), 'from-a');
    assert.equal(text(await pb), 'from-b');
  } finally {
    a.terminate();
    b.terminate();
    await srv.close();
  }
});

test('close() terminates clients and stops listening', async () => {
  const { srv, port, url } = await startServer();
  const ws = await openClient(url);
  const cliClosed = once(ws, 'close');
  await srv.close();
  const [code] = await cliClosed;
  assert.equal(code, 1006);

  const accepted = await new Promise((resolve) => {
    const c = net.connect({ host: '127.0.0.1', port });
    c.on('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.on('error', () => resolve(false));
  });
  assert.equal(accepted, false, 'server still accepted connections after close()');
});

test('fragmented message from a raw client is reassembled (with interleaved ping)', async () => {
  const { srv, port } = await startServer();
  const raw = await openRaw(port);
  try {
    raw.sock.write(maskedFrame(false, 0x1, Buffer.from('Hel')));
    raw.sock.write(maskedFrame(true, 0x9, Buffer.from('x')));
    raw.sock.write(maskedFrame(true, 0x0, Buffer.from('lo wörld')));

    const pong = await raw.readFrame();
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.payload.toString(), 'x');

    const echo = await raw.readFrame();
    assert.equal(echo.opcode, 0x1);
    assert.equal(echo.payload.toString(), 'Hello wörld');
  } finally {
    raw.sock.destroy();
    await srv.close();
  }
});

test('unmasked client frame closes with 1002', async () => {
  const { srv, port } = await startServer();
  const raw = await openRaw(port);
  try {
    raw.sock.write(Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]));
    const close = await raw.readFrame();
    assert.equal(close.opcode, 0x8);
    assert.equal(close.payload.readUInt16BE(0), 1002);
  } finally {
    raw.sock.destroy();
    await srv.close();
  }
});
