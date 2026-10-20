// Minimal RFC 6455 server side for tests (text frames, close, ping/pong). No dependencies.
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket(req, socket, { onMessage, onClose }) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  let closed = false;
  const conn = {
    send(obj) {
      if (closed) return;
      const payload = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
      socket.write(frame(0x1, payload));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      socket.write(frame(0x8, body));
      socket.end();
      onClose?.(code);
    },
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = readFrame(buf);
      if (!f) break;
      buf = buf.subarray(f.size);
      if (f.opcode === 0x1) {
        let obj;
        try { obj = JSON.parse(f.payload.toString("utf8")); } catch { obj = null; }
        if (obj) onMessage?.(obj, conn);
      } else if (f.opcode === 0x8) {
        if (!closed) {
          closed = true;
          socket.end();
          onClose?.(1005);
        }
      } else if (f.opcode === 0x9) {
        socket.write(frame(0xa, f.payload));
      }
    }
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      onClose?.(1006);
    }
  });
  socket.on("error", () => {});
  return conn;
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Parse one frame from buf; returns {opcode, payload, size} or null when incomplete. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: off + len };
}
