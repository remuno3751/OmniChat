import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "../src/conn/client";
import { createRunManager, type RunManager, type RunManagerOptions } from "../src/conn/runs";
import type { Frame, ToolCallFrame, ToolResult } from "../src/protocol/frames";
import type { Host } from "../src/host/types";
import type { ToolRegistry } from "../src/tools/index";
import { createFakeServer, type FakeServer } from "./fake-server";

// Hook ordering for beforeRun (checkpoint before run_ack) and afterRun (changes before done).
const ROOT = "/work/app";
const OK: ToolResult = { ok: true, result: {}, truncated: false, durationMs: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(5);
  }
}
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: p, open };
}

const checkpointFrame = (runId: string): Frame => ({
  type: "checkpoint", requestId: runId, checkpointId: "cp1", ref: "refs/omnichat/checkpoints/cp1", createdAt: 1, dirty: false,
});

let server: FakeServer | undefined, client: Client | undefined, runs: RunManager | undefined;
afterEach(async () => {
  runs?.dispose();
  client?.close();
  await server?.close();
  runs = client = server = undefined;
});

async function setup(registry: ToolRegistry, extra: Partial<RunManagerOptions>): Promise<FakeServer> {
  server = await createFakeServer();
  let online = false;
  client = createClient({
    url: server.url, token: "tok", name: "my-pc", instance: "inst", version: "0.2.0",
    tools: ["read_file"], workspaces: () => [ROOT],
    onFrame: (f) => runs?.handleFrame(f),
    onStatus: (s) => { if (s === "online") online = true; },
  });
  runs = createRunManager({ client, registry, host: {} as Host, getRoots: () => [ROOT], ...extra });
  await waitFor(() => online);
  return server;
}

const registry: ToolRegistry = { register() {}, execute: async () => OK };
const runFrame = (runId: string) => ({
  type: "run", runId, conversationId: "conv", cwd: ROOT, approvalMode: "manual", checkpoint: true, roots: [ROOT],
});
const callFrame = (runId: string, callId: string): ToolCallFrame =>
  ({ type: "tool_call", runId, callId, tool: "read_file", args: {}, timeoutMs: 5000, approval: { by: "mode:manual", protectedOk: false } }) as ToolCallFrame;
/** Types of the S -> E-visible frames, in the order the extension sent them. */
const sent = (types: string[]) => server!.frames.filter((f) => types.includes(f.type));
const kinds = (frames: Frame[]) => frames.map((f) => f.type);

describe("run hooks: frame ordering", () => {
  it("checkpoint goes before run_ack; changes goes before done, and done carries the warning", async () => {
    await setup(registry, {
      beforeRun: async () => { await sleep(10); return [checkpointFrame("r1")]; },
      afterRun: async (info) => ({
        frames: [{ type: "changes", requestId: info.runId, changes: [], truncated: false }],
        warning: "not a git repository",
      }),
    });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["done"]).length === 0 && server!.frames.some((f) => f.type === "run_ack"));
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => sent(["done"]).length === 1);

    expect(kinds(sent(["checkpoint", "run_ack", "changes", "done"]))).toEqual(["checkpoint", "run_ack", "changes", "done"]);
    expect(sent(["done"])[0]).toMatchObject({ runId: "r1", ok: true, warning: "not a git repository" });
    expect(sent(["run_ack"])[0]).toMatchObject({ ok: true });
  });

  it("a refused run (busy) takes no checkpoint and runs no afterRun", async () => {
    let begun = 0;
    let closed = 0;
    await setup(registry, {
      beforeRun: async () => { begun++; return [checkpointFrame("r1")]; },
      afterRun: async () => { closed++; return { frames: [] }; },
    });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send(runFrame("r2"));
    await waitFor(() => sent(["run_ack"]).length === 2);
    expect(sent(["run_ack"])[1]).toMatchObject({ runId: "r2", ok: false, error: "busy" });
    expect(begun).toBe(1);
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => sent(["done"]).length === 1);
    expect(closed).toBe(1);
  });

  it("tool calls that arrive while beforeRun is pending wait for run_ack", async () => {
    const g = gate();
    await setup(registry, { beforeRun: async () => { await g.wait; return []; } });
    server!.send(runFrame("r1"));
    server!.send(callFrame("r1", "c0"));
    await sleep(20);
    expect(sent(["tool_result"])).toHaveLength(0);
    g.open();
    await waitFor(() => sent(["tool_result"]).length === 1);
    expect(kinds(sent(["run_ack", "tool_result"]))).toEqual(["run_ack", "tool_result"]);
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => sent(["done"]).length === 1);
  });

  it("cancel during beforeRun: checkpoint and run_ack still go out first, then changes and done cancelled", async () => {
    const g = gate();
    await setup(registry, {
      beforeRun: async (run) => { await g.wait; return [checkpointFrame(run.runId)]; },
      afterRun: async (info) => ({ frames: [{ type: "changes", requestId: info.runId, changes: [], truncated: false }] }),
    });
    server!.send(runFrame("r1"));
    server!.send({ type: "cancel", runId: "r1" });
    await sleep(10);
    g.open();
    await waitFor(() => sent(["done"]).length === 1);
    expect(kinds(sent(["checkpoint", "run_ack", "changes", "done"]))).toEqual(["checkpoint", "run_ack", "changes", "done"]);
    expect(sent(["done"])[0]).toMatchObject({ ok: false, error: "cancelled" });
  });

  it("the run stays busy until done is sent, including while afterRun is pending", async () => {
    const g = gate();
    await setup(registry, { afterRun: async () => { await g.wait; return { frames: [] }; } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send({ type: "run_end", runId: "r1" });
    await sleep(10);
    server!.send(runFrame("r2"));
    await waitFor(() => sent(["run_ack"]).length === 2);
    expect(sent(["run_ack"])[1]).toMatchObject({ runId: "r2", ok: false, error: "busy" });
    expect(sent(["done"])).toHaveLength(0);
    g.open();
    await waitFor(() => sent(["done"]).length === 1);
    expect(runs!.activeRunId()).toBeNull();
  });

  it("a throwing afterRun still ends the run with done", async () => {
    await setup(registry, { afterRun: async () => { throw new Error("boom"); } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send({ type: "run_end", runId: "r1" });
    await waitFor(() => sent(["done"]).length === 1);
    expect(sent(["done"])[0]).toMatchObject({ runId: "r1", ok: true });
    expect(sent(["done"])[0]).not.toHaveProperty("warning");
  });
});
