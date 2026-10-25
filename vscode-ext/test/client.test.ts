import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client, type ClientOptions, type ClientStatus } from "../src/conn/client";
import type { Frame } from "../src/protocol/frames";
import { createFakeServer, type FakeServer } from "./fake-server";

/** Socket double for timer-driven tests (no real I/O). */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.readyState = 3;
  }
  ping(): void {}
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  message(obj: object): void {
    this.emit("message", Buffer.from(JSON.stringify(obj)));
  }
  drop(code: number): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.alloc(0));
  }
}

const WELCOME = { type: "welcome", protocol: 1, serverVersion: "0.6.0", minExtensionVersion: "0.1.0" };

function baseOpts(url: string, extra: Partial<ClientOptions> = {}): ClientOptions {
  return {
    url,
    token: "tok-123",
    name: "my-pc",
    instance: "6f1c-uuid",
    version: "0.2.0",
    tools: ["read_file", "list_dir"],
    workspaces: () => ["/work/app"],
    onFrame: () => undefined,
    onStatus: () => undefined,
    ...extra,
  };
}

function fakeHarness() {
  const sockets: FakeSocket[] = [];
  const statuses: Array<[ClientStatus, string | undefined]> = [];
  const client = createClient(
    baseOpts("ws://127.0.0.1:1", {
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      onStatus: (s, d) => statuses.push([s, d]),
      random: () => 0.5, // jitter multiplier 1.0 -> exact backoff values
    }),
  );
  return {
    client,
    sockets,
    statuses,
    last: () => sockets[sockets.length - 1]!,
    lastStatus: () => statuses[statuses.length - 1]?.[0],
  };
}

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: FakeServer | undefined;
let client: Client | undefined;

afterEach(async () => {
  vi.useRealTimers();
  client?.close();
  client = undefined;
  await server?.close();
  server = undefined;
});

describe("createClient (fake timers, FakeSocket)", () => {
  it("reconnects with exponential backoff capped at 30s, and resets after welcome", () => {
    vi.useFakeTimers();
    const h = fakeHarness();
    h.last().open();
    h.last().drop(1006);
    expect(h.lastStatus()).toBe("offline");

    for (const ms of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = h.sockets.length;
      vi.advanceTimersByTime(ms - 1);
      expect(h.sockets.length).toBe(before);
      vi.advanceTimersByTime(1);
      expect(h.sockets.length).toBe(before + 1);
      h.last().drop(1006);
    }

    // A successful welcome resets the attempt counter: next delay is 1 s again.
    vi.advanceTimersByTime(30_000);
    h.last().open();
    h.last().message(WELCOME);
    expect(h.lastStatus()).toBe("online");
    h.last().drop(1006);
    const before = h.sockets.length;
    vi.advanceTimersByTime(999);
    expect(h.sockets.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(h.sockets.length).toBe(before + 1);
  });

  it("close code 4001 sets unauthorized and never reconnects", () => {
    vi.useFakeTimers();
    const h = fakeHarness();
    h.last().open();
    h.last().drop(4001);
    expect(h.lastStatus()).toBe("unauthorized");
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
  });

  it("welcome with a minExtensionVersion above ours is incompatible, no reconnect", () => {
    vi.useFakeTimers();
    const h = fakeHarness();
    h.last().open();
    h.last().message({ ...WELCOME, minExtensionVersion: "0.3.0" });
    const [status, detail] = h.statuses[h.statuses.length - 1]!;
    expect(status).toBe("incompatible");
    expect(detail).toContain("0.2.0");
    expect(detail).toContain("need >= 0.3.0");
    expect(h.client.send({ type: "workspaces", workspaces: [], allowAnyCwd: false })).toBe(false);
    h.last().drop(1006);
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.lastStatus()).toBe("incompatible");
  });

  it("protocol mismatch is incompatible: connection kept, runs not accepted, no reconnect", () => {
    vi.useFakeTimers();
    const h = fakeHarness();
    h.last().open();
    h.last().message({ ...WELCOME, protocol: 99 });
    expect(h.lastStatus()).toBe("incompatible");
    expect(h.last().readyState).toBe(1);
    expect(h.client.sendWorkspaces()).toBe(false);
    h.client.close();
  });

  it("send() is dropped until online; close() stops everything", () => {
    vi.useFakeTimers();
    const h = fakeHarness();
    h.last().open();
    expect(h.client.sendWorkspaces()).toBe(false);
    h.last().message(WELCOME);
    expect(h.client.sendWorkspaces()).toBe(true);
    h.client.close();
    expect(h.lastStatus()).toBe("closed");
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("createClient (fake server over real ws)", () => {
  it("sends ready first; reports online only after welcome", async () => {
    server = await createFakeServer({ welcome: null });
    const statuses: ClientStatus[] = [];
    client = createClient(baseOpts(server.url, { onStatus: (s) => statuses.push(s) }));

    await waitFor(() => server!.frames.length === 1);
    const ready = server.frames[0] as Extract<Frame, { type: "ready" }>;
    expect(ready.type).toBe("ready");
    expect(ready.kind).toBe("vscode");
    expect(ready.instance).toBe("6f1c-uuid");
    expect(ready.protocol).toBe(1);
    expect(ready.workspaces).toEqual(["/work/app"]);
    expect(ready.capabilities.tools).toEqual(["read_file", "list_dir"]);
    expect(ready.capabilities.transcriptDelta).toBe(true);
    expect(statuses).not.toContain("online");

    server.send(WELCOME);
    await waitFor(() => statuses.includes("online"));
  });

  it("ready.trusted reflects the trusted callback (false by default)", async () => {
    server = await createFakeServer({ welcome: null });
    client = createClient(baseOpts(server.url, { trusted: () => true }));
    await waitFor(() => server!.frames.length === 1);
    expect((server.frames[0] as Extract<Frame, { type: "ready" }>).trusted).toBe(true);
    client.close();
    await server.close();
    client = undefined;
    server = undefined;

    server = await createFakeServer({ welcome: null });
    client = createClient(baseOpts(server.url));
    await waitFor(() => server!.frames.length === 1);
    expect((server.frames[0] as Extract<Frame, { type: "ready" }>).trusted).toBe(false);
  });

  it("welcome -> online; sendWorkspaces reaches the server", async () => {
    server = await createFakeServer();
    const statuses: ClientStatus[] = [];
    client = createClient(baseOpts(server.url, { onStatus: (s) => statuses.push(s) }));
    await waitFor(() => statuses.includes("online"));

    expect(client.sendWorkspaces()).toBe(true);
    await waitFor(() => server!.frames.some((f) => f.type === "workspaces"));
    const ws = server.frames.find((f) => f.type === "workspaces") as Extract<Frame, { type: "workspaces" }>;
    expect(ws.workspaces).toEqual(["/work/app"]);
    expect(ws.allowAnyCwd).toBe(false);
  });

  it("calls onWelcome with the features before reporting online", async () => {
    server = await createFakeServer({ welcome: { serverVersion: "0.5.4-beta.2", features: ["chat"] } });
    const order: string[] = [];
    const welcomes: Array<{ serverVersion: string; features?: string[] }> = [];
    client = createClient(
      baseOpts(server.url, {
        onWelcome: (f) => {
          order.push("welcome");
          welcomes.push({ serverVersion: f.serverVersion, features: f.features });
        },
        onStatus: (s) => order.push(s),
      }),
    );
    await waitFor(() => order.includes("online"));
    expect(order.indexOf("welcome")).toBeLessThan(order.indexOf("online"));
    expect(welcomes).toEqual([{ serverVersion: "0.5.4-beta.2", features: ["chat"] }]);
  });

  it("encodes token, name, kind and instance into the handshake query", async () => {
    server = await createFakeServer({ welcome: null });
    const token = "a b&c=d/é";
    client = createClient(baseOpts(server.url, { token }));
    await waitFor(() => server!.queries.length === 1);
    const q = server.queries[0]!;
    expect(q.get("token")).toBe(token);
    expect(q.get("name")).toBe("my-pc");
    expect(q.get("kind")).toBe("vscode");
    expect(q.get("instance")).toBe("6f1c-uuid");
  });

  it("ignores undecodable and unknown frames; keeps delivering valid ones", async () => {
    server = await createFakeServer();
    const received: Frame[] = [];
    const statuses: ClientStatus[] = [];
    client = createClient(
      baseOpts(server.url, {
        onFrame: (f) => received.push(f),
        onStatus: (s) => statuses.push(s),
      }),
    );
    await waitFor(() => statuses.includes("online"));

    server.send("not json");
    server.send("[1,2]");
    server.send('{"type":"run_ack"');
    server.send({ type: "no_such_frame" });
    server.send({ type: "run_ack", runId: "r1", ok: true });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ type: "run_ack", runId: "r1", ok: true });
    expect(statuses[statuses.length - 1]).toBe("online");
  });

  it("reconnects after the connection drops and re-sends ready", async () => {
    server = await createFakeServer();
    const statuses: ClientStatus[] = [];
    client = createClient(baseOpts(server.url, { onStatus: (s) => statuses.push(s) }));
    await waitFor(() => statuses.filter((s) => s === "online").length === 1);

    server.dropAll();
    await waitFor(() => statuses.filter((s) => s === "online").length === 2, 5000);
    expect(server.frames.filter((f) => f.type === "ready")).toHaveLength(2);
  });
});
