/**
 * Minimal bridge server for tests: a ws server on 127.0.0.1 with a random port.
 * Records every received frame, replies `welcome` to `ready` (configurable),
 * and can send frames, drop connections, or close them with a given code.
 */
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { decode } from "../src/protocol/codec";
import type { Frame, WelcomeFrame } from "../src/protocol/frames";

export interface FakeServerOptions {
  /** Fields for the auto `welcome` reply to `ready`. `null` disables auto-reply. */
  welcome?: Omit<Partial<WelcomeFrame>, "type"> | null;
}

export interface FakeServer {
  readonly url: string;
  /** Decoded frames received, in order (undecodable frames are not recorded here). */
  readonly frames: Frame[];
  /** Raw text of every frame received. */
  readonly raw: string[];
  /** Handshake query string of every connection. */
  readonly queries: URLSearchParams[];
  /** Auto-reply config, mutable between tests. */
  welcome: Omit<Partial<WelcomeFrame>, "type"> | null;
  /** Sends a frame (object) or raw text to the most recent open connection. */
  send(frame: object | string): void;
  /** Terminates all open connections without a close frame. */
  dropAll(): void;
  /** Closes all open connections with a close code (e.g. 4001). */
  closeAll(code: number, reason?: string): void;
  /** Number of currently open connections. */
  readonly connections: number;
  close(): Promise<void>;
}

function rawToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export async function createFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  const port = (wss.address() as AddressInfo).port;

  const clients: WebSocket[] = [];
  const frames: Frame[] = [];
  const raw: string[] = [];
  const queries: URLSearchParams[] = [];

  const server: FakeServer = {
    url: `ws://127.0.0.1:${port}/bridge`,
    frames,
    raw,
    queries,
    welcome: opts.welcome === undefined ? {} : opts.welcome,
    send(frame) {
      const sock = clients[clients.length - 1];
      if (!sock) throw new Error("no open connection");
      sock.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    dropAll() {
      for (const c of clients) c.terminate();
    },
    closeAll(code, reason) {
      for (const c of clients) c.close(code, reason);
    },
    get connections() {
      return clients.length;
    },
    async close() {
      for (const c of clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on("connection", (sock, req) => {
    queries.push(new URL(req.url ?? "/", "http://localhost").searchParams);
    clients.push(sock);
    sock.on("error", () => undefined);
    sock.on("close", () => {
      const i = clients.indexOf(sock);
      if (i >= 0) clients.splice(i, 1);
    });
    sock.on("message", (data: RawData) => {
      const text = rawToText(data);
      raw.push(text);
      const frame = decode(text);
      if (!frame) return;
      frames.push(frame);
      if (frame.type === "ready" && server.welcome !== null) {
        const welcome: WelcomeFrame = {
          type: "welcome",
          protocol: 1,
          serverVersion: "0.6.0",
          minExtensionVersion: "0.1.0",
          ...server.welcome,
        };
        sock.send(JSON.stringify(welcome));
      }
    });
  });

  return server;
}
