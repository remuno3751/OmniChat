// Minimal RFC 6455 WebSocket server. Server side only, built on node:http,
// node:net and node:crypto. No runtime dependencies.

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_TIMEOUT_MS = 5000;
const SKIPPABLE_BIND_ERRORS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0', '::ffff:0.0.0.0']);
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const noop = () => {};

function isLoopback(addr) {
  if (typeof addr !== 'string') return false;
  if (addr === '::1') return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return /^127\./.test(v4);
}

function isValidCloseCode(code) {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WsSock {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  readyState = WsSock.OPEN;

  #socket;
  #maxPayload;
  #log;
  #onFinish;
  #listeners = new Map([
    ['message', new Set()],
    ['close', new Set()],
    ['error', new Set()],
  ]);
  #buf = Buffer.alloc(0);
  #frag = null;
  #fragSize = 0;
  #closeSent = false;
  #closeCode;
  #closeReason;
  #finished = false;
  #closeTimer = null;

  constructor(socket, { maxPayload, log = noop, onFinish = noop, initial } = {}) {
    this.#socket = socket;
    this.#maxPayload = maxPayload;
    this.#log = log;
    this.#onFinish = onFinish;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (error) => {
      this.#dispatch('error', { error });
      this.#fail(1006);
    });
    socket.on('close', () => this.#finish());
    if (initial && initial.length > 0) {
      this.#buf = Buffer.from(initial);
      process.nextTick(() => this.#parse());
    }
  }

  get bufferedAmount() {
    return this.#socket.writableLength ?? 0;
  }

  send(data) {
    if (this.readyState !== WsSock.OPEN) {
      throw new Error(`WebSocket is not open (readyState ${this.readyState})`);
    }
    this.#write(encodeFrame(OP_TEXT, Buffer.from(String(data), 'utf8')));
  }

  ping(data = '') {
    if (this.readyState !== WsSock.OPEN) {
      throw new Error(`WebSocket is not open (readyState ${this.readyState})`);
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (payload.length > 125) throw new RangeError('ping payload exceeds 125 bytes');
    this.#write(encodeFrame(OP_PING, payload));
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= WsSock.CLOSING) return;
    if (!isValidCloseCode(code)) throw new RangeError(`invalid close code ${code}`);
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    if (reasonBuf.length > 123) throw new RangeError('close reason exceeds 123 bytes');
    this.readyState = WsSock.CLOSING;
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this.#closeSent = true;
    this.#write(encodeFrame(OP_CLOSE, payload));
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_TIMEOUT_MS);
    this.#closeTimer.unref();
  }

  terminate() {
    if (this.#finished) return;
    this.#socket.destroy();
    this.#finish();
  }

  addEventListener(type, fn) {
    this.#listeners.get(type)?.add(fn);
  }

  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  #write(buf) {
    if (!this.#socket.destroyed) this.#socket.write(buf);
  }

  #dispatch(type, event) {
    const fns = this.#listeners.get(type);
    if (!fns) return;
    for (const fn of [...fns]) {
      try {
        fn(event);
      } catch (err) {
        this.#log(`ws ${type} listener threw: ${err?.message ?? err}`);
      }
    }
  }

  #finish() {
    if (this.#finished) return;
    this.#finished = true;
    this.readyState = WsSock.CLOSED;
    clearTimeout(this.#closeTimer);
    this.#buf = Buffer.alloc(0);
    this.#frag = null;
    try {
      this.#onFinish(this);
    } catch (err) {
      this.#log(`ws onFinish threw: ${err?.message ?? err}`);
    }
    this.#dispatch('close', {
      code: this.#closeCode ?? 1006,
      reason: this.#closeReason ?? '',
    });
  }

  // Protocol error or policy violation: send a close frame, flush, destroy.
  #fail(code) {
    if (this.#finished) return;
    this.#closeCode = code;
    this.#closeReason = '';
    this.readyState = WsSock.CLOSING;
    const sock = this.#socket;
    if (!this.#closeSent) {
      this.#closeSent = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      sock.write(encodeFrame(OP_CLOSE, payload), () => sock.destroy());
    } else {
      sock.destroy();
    }
    this.#finish();
  }

  #onData(chunk) {
    if (this.#finished) return;
    this.#buf = this.#buf.length > 0 ? Buffer.concat([this.#buf, chunk]) : chunk;
    this.#parse();
  }

  #parse() {
    while (!this.#finished && this.#buf.length >= 2) {
      const buf = this.#buf;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (!masked) return this.#fail(1002);
      if (rsv !== 0) return this.#fail(1002);
      if (![OP_CONT, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) {
        return this.#fail(1002);
      }
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(this.#maxPayload)) return this.#fail(1009);
        len = Number(big);
        off = 10;
      }
      if (opcode >= 0x8 && (!fin || len > 125)) return this.#fail(1002);
      if (len > this.#maxPayload) return this.#fail(1009);
      if (buf.length < off + 4 + len) return;

      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      this.#buf = buf.subarray(off + 4 + len);
      this.#onFrame(fin, opcode, payload);
    }
  }

  #onFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) return this.#onClose(payload);
    if (this.#closeSent) return; // closing: discard everything but the close frame

    switch (opcode) {
      case OP_PING:
        this.#write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        return;
      case OP_BINARY:
        return this.#fail(1003);
      case OP_TEXT:
        if (this.#frag) return this.#fail(1002);
        if (fin) return this.#deliverText(payload);
        this.#frag = [payload];
        this.#fragSize = payload.length;
        return;
      case OP_CONT: {
        if (!this.#frag) return this.#fail(1002);
        this.#fragSize += payload.length;
        if (this.#fragSize > this.#maxPayload) return this.#fail(1009);
        this.#frag.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.#frag);
          this.#frag = null;
          return this.#deliverText(whole);
        }
        return;
      }
      default:
        return this.#fail(1002);
    }
  }

  #deliverText(buf) {
    let text;
    try {
      text = UTF8.decode(buf);
    } catch {
      return this.#fail(1007);
    }
    this.#dispatch('message', { data: text });
  }

  #onClose(payload) {
    if (payload.length === 1) return this.#fail(1002);
    let code = 1005;
    let reason = '';
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isValidCloseCode(code)) return this.#fail(1002);
      try {
        reason = UTF8.decode(payload.subarray(2));
      } catch {
        return this.#fail(1007);
      }
    }
    this.#closeCode = code;
    this.#closeReason = reason;
    this.readyState = WsSock.CLOSING;
    if (!this.#closeSent) {
      // Echo the peer's close frame (same code and reason).
      this.#closeSent = true;
      this.#write(encodeFrame(OP_CLOSE, payload));
    }
    this.#socket.end();
    this.#finish();
  }
}

export class MiniWsServer {
  #hosts;
  #port;
  #path;
  #maxPayload;
  #allowedHosts;
  #checkUpgrade;
  #onConnection;
  #log;
  #servers = [];
  #clients = new Set();

  constructor({
    hosts = ['127.0.0.1', '::1'],
    port,
    path = '/omnichat-bridge',
    maxPayload = 4 * 1024 * 1024,
    allowedHosts,
    checkUpgrade,
    onConnection,
    log,
  } = {}) {
    for (const h of hosts) {
      if (WILDCARD_HOSTS.has(h)) throw new Error(`refusing to bind wildcard address "${h}"`);
      if (net.isIP(h) === 0) throw new TypeError(`host must be an IP literal: "${h}"`);
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new TypeError('port must be an integer in 0..65535');
    }
    this.#hosts = [...hosts];
    this.#port = port;
    this.#path = path;
    this.#maxPayload = maxPayload;
    this.#allowedHosts = allowedHosts;
    this.#checkUpgrade = checkUpgrade;
    this.#onConnection = onConnection;
    this.#log = log ?? noop;
  }

  async listen() {
    if (this.#servers.length > 0) throw new Error('already listening');
    const bound = [];
    let port = this.#port;
    try {
      for (const host of this.#hosts) {
        const server = this.#createServer();
        try {
          await new Promise((resolve, reject) => {
            const onError = (err) => reject(err);
            server.once('error', onError);
            server.listen({ host, port }, () => {
              server.off('error', onError);
              resolve();
            });
          });
        } catch (err) {
          if (host === '::1' && SKIPPABLE_BIND_ERRORS.has(err.code)) continue;
          throw err;
        }
        this.#servers.push(server);
        const addr = server.address();
        bound.push({ address: addr.address, port: addr.port });
        if (port === 0) port = addr.port;
      }
    } catch (err) {
      await this.#closeServers();
      throw err;
    }
    return bound;
  }

  async close() {
    for (const client of [...this.#clients]) client.terminate();
    this.#clients.clear();
    await this.#closeServers();
  }

  async #closeServers() {
    const servers = this.#servers;
    this.#servers = [];
    await Promise.all(
      servers.map(
        (s) =>
          new Promise((resolve) => {
            s.close(() => resolve());
            s.closeAllConnections?.();
          }),
      ),
    );
  }

  #createServer() {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
      res.end();
    });
    server.on('connection', (s) => s.setNoDelay(true));
    server.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    return server;
  }

  #handleUpgrade(req, socket, head) {
    socket.on('error', noop);
    const reject = (status) => {
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403;
      this.#log(`ws upgrade rejected ${code} for ${req.url}`);
      const text = http.STATUS_CODES[code] ?? 'Error';
      const response = `HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
      socket.write(response, () => socket.destroy());
    };

    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject(400);
    }
    if (pathname !== this.#path) return reject(404);
    if (req.method !== 'GET') return reject(400);

    const upgrade = req.headers.upgrade;
    if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return reject(400);
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(400);
    if (req.headers['sec-websocket-version'] !== '13') return reject(400);

    if (!isLoopback(socket.remoteAddress)) return reject(403);

    if (this.#allowedHosts) {
      let ok = false;
      try {
        ok = Boolean(this.#allowedHosts(req.headers.host));
      } catch {
        ok = false;
      }
      if (!ok) return reject(403);
    }

    if (this.#checkUpgrade) {
      let result;
      try {
        result = this.#checkUpgrade(req);
      } catch {
        result = false;
      }
      if (typeof result === 'number') return reject(result);
      if (!result) return reject(403);
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.setTimeout(0);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const sock = new WsSock(socket, {
      maxPayload: this.#maxPayload,
      log: this.#log,
      onFinish: (s) => this.#clients.delete(s),
      initial: head,
    });
    this.#clients.add(sock);

    if (this.#onConnection) {
      try {
        this.#onConnection(sock, req);
      } catch (err) {
        this.#log(`onConnection threw: ${err?.message ?? err}`);
        try {
          sock.close(1011, 'internal error');
        } catch {
          sock.terminate();
        }
      }
    }
  }
}
