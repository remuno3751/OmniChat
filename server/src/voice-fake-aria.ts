// Test helper (not a test): a fake Aria (docs/design/ARIA-VOICE.md, ARIA-VOICE-PHASE2.md, ARIA-HOST.md) on a random port, in this process.
// REST: /health, /voices, /voices/models, /voices/fast(/models, /models/:id), /tts/preview, /llm/endpoints, /llm/models, /llm/model,
// /voice/placement(/stt). WS: /live/ws?user=&token=&private=.
// Every request and every frame the server sends on /live/ws is recorded. Tests push frames with conn.send / conn.sendBinary.
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

export interface FakeRequest { method: string; path: string; query: Record<string, string>; auth: string; body: any }

export interface LiveConn {
  /** the OmniChat user id from ?user= */
  user: string;
  /** the token from ?token= */
  token: string;
  /** the id Aria reports as `session` in `ready` (fake-1, fake-2, ...) */
  session: string;
  /** true when the live URL had private=1 (echoed as `ready.private`) */
  private: boolean;
  /** every frame the client sent, in order: JSON objects, binary frames as Buffer */
  frames: any[];
  closed: boolean;
  closeCode: number | null;
  send(obj: Record<string, unknown>): void;
  sendBinary(buf: Buffer): void;
  /** closes the socket from the Aria side with a close code (default 1000) */
  close(code?: number): void;
  /** drops the TCP connection without a close frame (the OmniChat server sees 1006) */
  terminate(): void;
  /** the utterance_id Aria would give this turn: `<session>:<turn>`, unique per connection */
  utterance(turn: number): string;
  /** sends turn_end, with `stats` when given (e.g. { first_audio_ms, reply_chars }) */
  turnEnd(turn: number, stats?: Record<string, unknown>): void;
  ws: WebSocket;
}

export interface FakeModel { uuid: string; name: string; license: string; speakers: unknown[] }
export interface FakeFastModel { id: string; name: string; files: string[]; ready?: boolean }
export interface FakeState {
  /** standard (aivmx) voices, GET /voices */
  models: FakeModel[];
  /** Fast (piper-plus) voices, GET /voices/fast */
  fast: FakeFastModel[];
  llm: { endpoints: { name: string; models: string[] }[]; roles: Record<"fast" | "deep", { endpoint: string; model: string }> };
  placement: { gpus: { index: number; name: string }[]; stt: { model: string; device: string; device_index: number; url: string } };
  /** `tts_modes` in /voice/placement and in `ready`; null leaves the key out */
  ttsModes: string[] | null;
  /** /health answer: HTTP status (default 200) and the body's `status` */
  healthCode: number;
  health: string;
  /** HTTP status of GET /voices/fast (default 200; anything but 2xx = Aria cannot list its Fast voices) */
  fastCode: number;
  /** false: GET /voice/placement answers 500 */
  placementOk: boolean;
  /** false: POST /tts/preview answers 404 (no read-aloud REST on Aria) */
  previewOk: boolean;
  /** true: POST /voices/models answers 204 with no body (the model is still registered) */
  uploadNoBody: boolean;
}

export interface FakeAriaOpts {
  chatToken: string;
  adminToken: string;
  /** send the built-in `ready` after `hello` (default true) */
  autoReady?: boolean;
}

export interface FakeAria {
  baseUrl: string;
  port: number;
  requests: FakeRequest[];
  liveConnections: LiveConn[];
  state: FakeState;
  /** called for every frame the client sends on /live/ws, after it is recorded (null removes it) */
  setScript(fn: ((frame: any, conn: LiveConn) => void) | null): void;
  stop(): Promise<void>;
}

/** Polls until f() is true, else throws. */
export async function until(f: () => boolean, ms = 5000): Promise<void> {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** A valid 100 ms mono 16 kHz 16-bit WAV of silence. The fake's /tts/preview answers with exactly these bytes. */
export function fakeWav(ms = 100, rate = 16000): Buffer {
  const n = Math.round((rate * ms) / 1000) * 2;
  const b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

const bearer = (req: IncomingMessage): string => {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ""));
  return m ? m[1].trim() : "";
};

function readAll(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

export function startFakeAria(opts: FakeAriaOpts): Promise<FakeAria> {
  const requests: FakeRequest[] = [];
  const liveConnections: LiveConn[] = [];
  const state: FakeState = {
    models: [{ uuid: "seed-uuid-1", name: "seed-voice", license: "test-license", speakers: [{ id: "spk-1", name: "Seed", styles: [{ id: 0, name: "normal" }] }] }],
    fast: [{ id: "seed-fast", name: "seed-fast", files: ["model", "config"] }],
    llm: {
      endpoints: [{ name: "local", models: ["m1", "m2", "m3"] }],
      roles: { fast: { endpoint: "local", model: "m1" }, deep: { endpoint: "local", model: "m3" } },
    },
    placement: { gpus: [{ index: 0, name: "GPU 0 (test)" }], stt: { model: "small", device: "cpu", device_index: 0, url: "" } },
    ttsModes: ["balanced", "fast"],
    healthCode: 200,
    fastCode: 200,
    health: "ok",
    placementOk: true,
    previewOk: true,
    uploadNoBody: false,
  };
  let script: ((frame: any, conn: LiveConn) => void) | null = null;
  let seq = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const raw = await readAll(req);
    const ct = String(req.headers["content-type"] ?? "");
    let body: any = raw;
    if (ct.includes("json")) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = raw.toString("utf8"); } }
    const auth = bearer(req);
    const method = req.method ?? "GET";
    const p = url.pathname;
    requests.push({ method, path: p, query: Object.fromEntries(url.searchParams), auth, body });
    const send = (status: number, obj: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (method === "GET" && p === "/health") return send(state.healthCode, { status: state.health });
    const role = auth === opts.adminToken ? "admin" : auth === opts.chatToken ? "chat" : "";
    if (!role) return send(401, { error: "unauthorized" });
    // every write is admin-only (ARIA-VOICE-PHASE2.md: POST /llm/model, POST /voices/models, POST /voices/fast/models, DELETE, POST /voice/placement/stt)
    if (method !== "GET" && role !== "admin" && p !== "/tts/preview") return send(403, { error: "admin token required" });

    if (method === "GET" && p === "/voices") return send(200, { models: state.models });
    if (method === "POST" && p === "/voices/models") {
      const name = url.searchParams.get("name") ?? "";
      if (!name.endsWith(".aivmx")) return send(400, { error: `unsupported model format: ${name}` });
      const m: FakeModel = { uuid: randomUUID(), name: name.replace(/\.[^.]+$/, ""), license: "uploaded", speakers: [] };
      state.models.push(m);
      if (state.uploadNoBody) { res.writeHead(204); return res.end(); }
      return send(200, { uuid: m.uuid, name: m.name });
    }
    const del = /^\/voices\/models\/([^/]+)$/.exec(p);
    if (method === "DELETE" && del) {
      const i = state.models.findIndex((m) => m.uuid === del[1]);
      if (i < 0) return send(404, { error: "not found" });
      state.models.splice(i, 1);
      return send(200, { ok: true });
    }
    if (method === "GET" && p === "/voices/fast") return send(state.fastCode, state.fastCode < 300 ? { models: state.fast } : { error: "unavailable" });
    if (method === "POST" && p === "/voices/fast/models") {
      const name = url.searchParams.get("name") ?? "";
      const file = url.searchParams.get("file") ?? "";
      if (!/^[a-z0-9_-]{1,40}$/.test(name)) return send(400, { error: "name must be 1 to 40 of a-z, 0-9, - or _" });
      if (file !== "zip" && file !== "model" && file !== "config") return send(400, { error: "file must be zip, model or config" });
      const raw2 = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      if (raw2.subarray(0, 3).toString("latin1") === "BAD") return send(422, { error: "not a piper-plus model" });
      let m = state.fast.find((x) => x.id === name);
      if (!m) { m = { id: name, name, files: [] }; state.fast.push(m); }
      if (!m.files.includes(file)) m.files.push(file);
      return send(200, { model: { id: name, name, files: m.files } });
    }
    const fdel = /^\/voices\/fast\/([^/]+)$/.exec(p);
    if (method === "DELETE" && fdel) {
      const i = state.fast.findIndex((m) => m.id === decodeURIComponent(fdel[1]));
      if (i < 0) return send(404, { error: "not found" });
      state.fast.splice(i, 1);
      return send(200, { ok: true });
    }
    if (method === "POST" && p === "/tts/preview") {
      if (!state.previewOk) return send(404, { error: "no route" });
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(fakeWav());
    }
    if (method === "GET" && p === "/llm/endpoints") {
      return send(200, { endpoints: state.llm.endpoints, roles: state.llm.roles, usage: { fast: { requests: 0, errors: 0, fallbacks: 0 } } });
    }
    if (method === "GET" && p === "/llm/models") {
      return send(200, { models: state.llm.endpoints.flatMap((e) => e.models.map((name) => ({ endpoint: e.name, name }))) });
    }
    if (method === "POST" && p === "/llm/model") {
      const b = (body && typeof body === "object" ? body : {}) as any;
      const ep = state.llm.endpoints.find((e) => e.name === (b.name ?? b.endpoint ?? "local")) ?? state.llm.endpoints[0];
      if (b.model === "bad") return send(400, { error: "model not in list", available: ep.models });
      if (b.target === "role") {
        if (b.name !== "fast" && b.name !== "deep") return send(400, { error: "unknown role" });
        state.llm.roles[b.name as "fast" | "deep"] = { endpoint: b.endpoint ?? state.llm.roles[b.name as "fast" | "deep"].endpoint, model: b.model };
      }
      return send(200, { ok: true });
    }
    if (method === "GET" && p === "/voice/placement") {
      if (!state.placementOk) return send(500, { error: "placement unavailable" });
      return send(200, {
        gpus: state.placement.gpus, stt: state.placement.stt,
        ...(state.ttsModes ? { tts_modes: state.ttsModes } : {}),
      });
    }
    if (method === "POST" && p === "/voice/placement/stt") {
      const b = (body && typeof body === "object" ? body : {}) as any;
      state.placement.stt = {
        model: b.model ?? state.placement.stt.model, device: b.device ?? state.placement.stt.device,
        device_index: b.device_index ?? state.placement.stt.device_index, url: b.url ?? state.placement.stt.url,
      };
      return send(200, { ok: true, stt: state.placement.stt });
    }
    return send(404, { error: "no route" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname !== "/live/ws") return socket.destroy();
    const token = url.searchParams.get("token") ?? "";
    if (token !== opts.chatToken && token !== opts.adminToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    requests.push({ method: "WS", path: "/live/ws", query: Object.fromEntries(url.searchParams), auth: token, body: null });
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => undefined);
      seq += 1;
      const session = `fake-${seq}`;
      const conn: LiveConn = {
        user: url.searchParams.get("user") ?? "", token, session, private: url.searchParams.get("private") === "1",
        frames: [], closed: false, closeCode: null, ws,
        send: (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); },
        sendBinary: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b, { binary: true }); },
        close: (code) => ws.close(code ?? 1000),
        terminate: () => ws.terminate(),
        utterance: (turn) => `${session}:${turn}`,
        turnEnd: (turn, stats) => conn.send({ type: "turn_end", turn, interrupted: false, ...(stats ? { stats } : {}) }),
      };
      liveConnections.push(conn);
      ws.on("message", (data, isBinary) => {
        let f: any;
        if (isBinary) f = Buffer.from(data as Buffer);
        else { const t = (data as Buffer).toString("utf8"); try { f = JSON.parse(t); } catch { f = t; } }
        conn.frames.push(f);
        if (!isBinary && f?.type === "hello" && opts.autoReady !== false) {
          conn.send({
            type: "ready", codec: "pcm16", sample_rate: 16000, session, private: conn.private,
            settings: f.values ?? {}, ...(state.ttsModes ? { tts_modes: state.ttsModes } : {}),
          });
        }
        script?.(f, conn);
      });
      ws.on("close", (code) => { conn.closed = true; conn.closeCode = code; });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, port, requests, liveConnections, state,
        setScript(fn) { script = fn; },
        stop: () => new Promise<void>((res) => {
          for (const c of liveConnections) c.ws.terminate();
          wss.close();
          server.closeAllConnections();
          server.close(() => res());
        }),
      });
    });
  });
}
