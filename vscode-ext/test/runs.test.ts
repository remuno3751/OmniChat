import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "../src/conn/client";
import { createRunManager, type RunManager, type RunManagerOptions } from "../src/conn/runs";
import type { Frame, ToolCallFrame, ToolName, ToolResult } from "../src/protocol/frames";
import type { Host } from "../src/host/types";
import type { ToolContext, ToolRegistry } from "../src/tools/index";
import { createFakeServer, type FakeServer } from "./fake-server";

const ROOT = "/work/app";
const OK: ToolResult = { ok: true, result: {}, truncated: false, durationMs: 1 };

function fakeRegistry(behavior: (call: ToolCallFrame, ctx: ToolContext) => Promise<ToolResult>): ToolRegistry & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    register() {},
    execute(call, ctx) {
      executed.push(call.callId);
      return behavior(call as ToolCallFrame, ctx);
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  return { promise: new Promise<T>((r) => (resolve = r)), resolve };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

let server: FakeServer | undefined, client: Client | undefined, runs: RunManager | undefined;

afterEach(async () => {
  runs?.dispose();
  client?.close();
  await server?.close();
  runs = client = server = undefined;
});

/** Real client against the fake server; server frames are routed into the run manager. */
async function setup(registry: ToolRegistry, extra: Partial<RunManagerOptions> = {}): Promise<FakeServer> {
  server = await createFakeServer();
  let online = false;
  client = createClient({
    url: server.url, token: "tok", name: "my-pc", instance: "inst", version: "0.2.0",
    tools: ["read_file", "grep", "write_file", "edit_file", "run_command", "git_commit"],
    workspaces: () => [ROOT],
    onFrame: (f) => runs?.handleFrame(f),
    onStatus: (s) => { if (s === "online") online = true; },
  });
  runs = createRunManager({ client, registry, host: {} as Host, getRoots: () => [ROOT], ...extra });
  await waitFor(() => online);
  return server;
}

const runFrame = (runId: string, extra: Record<string, unknown> = {}) => ({
  type: "run", runId, conversationId: "conv", cwd: ROOT, approvalMode: "manual", checkpoint: false,
  roots: [ROOT], ...extra,
});

const callFrame = (runId: string, callId: string, tool: ToolName | string, timeoutMs = 5000, approval = true) => ({
  type: "tool_call", runId, callId, tool, args: {}, timeoutMs,
  ...(approval ? { approval: { by: "mode:manual", protectedOk: false } } : {}),
});

const framesOf = <T extends Frame["type"]>(type: T) =>
  server!.frames.filter((f): f is Extract<Frame, { type: T }> => f.type === type);
const results = () => framesOf("tool_result");
const acks = () => framesOf("run_ack");
const dones = () => framesOf("done");

describe("createRunManager (fake server, real client)", () => {
  it("refuses a second run as busy while one is active", async () => {
    await setup(fakeRegistry(() => new Promise(() => undefined)));
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(runFrame("r2"));
    await waitFor(() => acks().length === 2);
    expect(acks()[1]).toMatchObject({ runId: "r2", ok: false, error: "busy" });
    expect(runs!.activeRunId()).toBe("r1");

    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => dones().length === 1);
    expect(dones()[0]).toMatchObject({ runId: "r1", ok: true });
    expect(runs!.activeRunId()).toBeNull();
  });

  it("rejects untrusted workspaces and cwd outside the workspaces", async () => {
    await setup(fakeRegistry(async () => OK), { isTrusted: () => false });
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    expect(acks()[0]).toMatchObject({ ok: false, error: "untrusted_workspace" });
    expect(runs!.activeRunId()).toBeNull();
  });

  it("rejects a cwd outside the workspaces with cwd not allowed", async () => {
    await setup(fakeRegistry(async () => OK));
    server!.send(runFrame("r1", { cwd: "/etc", roots: ["/etc"] }));
    await waitFor(() => acks().length === 1);
    expect(acks()[0]).toMatchObject({ ok: false, error: "cwd not allowed" });
    server!.send(runFrame("r2", { cwd: "/work/app-evil", roots: ["/work/app-evil"] }));
    await waitFor(() => acks().length === 2);
    expect(acks()[1]).toMatchObject({ ok: false, error: "cwd not allowed" });
  });

  it("runs at most 4 read calls in parallel", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<ToolResult>());
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await setup(
      fakeRegistry(async (c) => {
        started.push(c.callId);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await gates[Number(c.callId.slice(1))]!.promise;
        } finally {
          inFlight--;
        }
      }),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    for (let i = 0; i < 6; i++) server!.send(callFrame("r1", `c${i}`, "read_file"));

    await waitFor(() => started.length === 4);
    await sleep(30);
    expect(started).toHaveLength(4);

    gates[0]!.resolve(OK);
    await waitFor(() => started.length === 5);
    for (const g of gates) g.resolve(OK);
    await waitFor(() => results().length === 6);
    expect(maxInFlight).toBe(4);

    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => dones().length === 1);
  });

  it("serializes write calls in arrival order and keeps reads behind a waiting write", async () => {
    const log: string[] = [];
    let writesRunning = 0;
    let maxWrites = 0;
    const writeTools = new Set(["write_file", "edit_file", "run_command", "git_commit"]);
    await setup(
      fakeRegistry(async (c) => {
        const isWrite = writeTools.has(c.tool);
        log.push(`start:${c.callId}`);
        if (isWrite) {
          writesRunning++;
          maxWrites = Math.max(maxWrites, writesRunning);
        }
        await sleep(5);
        if (isWrite) writesRunning--;
        log.push(`end:${c.callId}`);
        return OK;
      }),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    const seq = ["read_file", "write_file", "read_file", "edit_file", "run_command", "read_file", "git_commit"];
    seq.forEach((tool, i) => server!.send(callFrame("r1", `c${i}`, tool)));
    await waitFor(() => results().length === 7);

    expect(maxWrites).toBe(1);
    const writeStarts = log.filter((e) => e.startsWith("start:") && ["c1", "c3", "c4", "c6"].includes(e.slice(6)));
    expect(writeStarts).toEqual(["start:c1", "start:c3", "start:c4", "start:c6"]);
    expect(log.indexOf("end:c1")).toBeLessThan(log.indexOf("start:c2"));
    expect(log.indexOf("end:c2")).toBeLessThan(log.indexOf("start:c3"));
  });

  it("times out one call: timeout result, abort signal fired, late result dropped", async () => {
    const late: Array<(r: ToolResult) => void> = [];
    const aborted: string[] = [];
    await setup(
      fakeRegistry((c, ctx) => {
        ctx.signal.addEventListener("abort", () => aborted.push(c.callId));
        return new Promise<ToolResult>((resolve) => late.push(resolve));
      }),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(callFrame("r1", "c0", "read_file", 50));

    await waitFor(() => results().length === 1);
    expect(results()[0]).toMatchObject({ runId: "r1", callId: "c0", ok: false, error: { code: "timeout" } });
    expect(aborted).toEqual(["c0"]);

    late[0]!(OK);
    await sleep(30);
    expect(results()).toHaveLength(1);

    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => dones().length === 1);
    expect(dones()[0]).toMatchObject({ ok: true });
  });

  it("cancel: cancelled tool_results in arrival order, then done cancelled; late results ignored", async () => {
    const executed: string[] = [];
    await setup(
      fakeRegistry((c, ctx) => {
        executed.push(c.callId);
        // Abort-aware handler that still resolves afterwards; that late result must be dropped.
        return new Promise<ToolResult>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(OK)),
        );
      }),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(callFrame("r1", "c0", "read_file"));
    server!.send(callFrame("r1", "c1", "grep"));
    server!.send(callFrame("r1", "c2", "write_file")); // queued behind the two reads
    await waitFor(() => executed.length === 2);

    server!.send({ type: "cancel", runId: "r1" });
    await waitFor(() => dones().length === 1);
    await sleep(20);

    const order = server!.frames
      .filter((f) => f.type === "tool_result" || f.type === "done")
      .map((f) => (f.type === "done" ? "done" : (f as Extract<Frame, { type: "tool_result" }>).callId));
    expect(order).toEqual(["c0", "c1", "c2", "done"]);
    expect(results().every((r) => !r.ok && r.error.code === "cancelled")).toBe(true);
    expect(dones()[0]).toMatchObject({ runId: "r1", ok: false, error: "cancelled" });
    expect(executed).toEqual(["c0", "c1"]);
    expect(runs!.activeRunId()).toBeNull();
  });

  it("disconnect (dispose): aborts calls and sends nothing afterwards", async () => {
    const aborted: string[] = [];
    await setup(
      fakeRegistry((c, ctx) => {
        return new Promise<ToolResult>((resolve) =>
          ctx.signal.addEventListener("abort", () => {
            aborted.push(c.callId);
            resolve(OK);
          }),
        );
      }),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(callFrame("r1", "c0", "read_file"));
    await sleep(20);

    runs!.dispose();
    expect(aborted).toEqual(["c0"]);
    expect(runs!.activeRunId()).toBeNull();

    server!.send(runFrame("r2"));
    await sleep(50);
    expect(results()).toHaveLength(0);
    expect(dones()).toHaveLength(0);
    expect(acks()).toHaveLength(1);
  });

  it("duplicate callId gets an error result; the original call still runs once", async () => {
    await setup(fakeRegistry(async () => OK));
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(callFrame("r1", "c0", "read_file"));
    server!.send(callFrame("r1", "c0", "read_file"));
    await waitFor(() => results().length === 2);

    const dup = results().find((r) => !r.ok);
    expect(dup).toMatchObject({ callId: "c0", ok: false, error: { code: "invalid_args" } });
    expect(results().filter((r) => r.ok)).toHaveLength(1);
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => dones().length === 1);
  });

  it("unknown tool and unapproved calls get error results", async () => {
    await setup(
      fakeRegistry(async (c) =>
        c.tool === "read_file"
          ? OK
          : { ok: false, error: { code: "unsupported", message: "tool not available" } },
      ),
    );
    server!.send(runFrame("r1"));
    await waitFor(() => acks().length === 1);
    server!.send(callFrame("r1", "c0", "no_such_tool"));
    server!.send(callFrame("r1", "c1", "read_file", 5000, false));
    await waitFor(() => results().length === 2);

    expect(results().find((r) => r.callId === "c0")).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect(results().find((r) => r.callId === "c1")).toMatchObject({ ok: false, error: { code: "denied" } });
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => dones().length === 1);
  });
});
