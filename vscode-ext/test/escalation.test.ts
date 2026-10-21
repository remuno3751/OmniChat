import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "../src/conn/client";
import { createEscalation, TOOL_APPROVAL_TIMEOUT_MS, type Escalation, type GateResult } from "../src/conn/escalation";
import { createRunManager, type RunManager } from "../src/conn/runs";
import type { ApprovalFrame, ApprovalReplyFrame, Frame, ToolCallFrame, ToolResult } from "../src/protocol/frames";
import type { Host } from "../src/host/types";
import type { ToolRegistry } from "../src/tools/index";
import { createFakeServer, type FakeServer } from "./fake-server";

// Approval gate (spec docs/design/VSCODE-BRIDGE.md §2.4, §4.2): unit tests on createEscalation,
// then run-level tests through createRunManager and the fake server (timeout pause, cancel).
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

/** A tool_call that the server approved in manual mode. `.env` is a protected (secret) path. */
function call(over: Partial<ToolCallFrame> = {}): ToolCallFrame {
  return {
    type: "tool_call", runId: "r1", callId: "c1", tool: "read_file", args: { path: "src/a.ts" }, timeoutMs: 5000,
    approval: { by: "mode:manual", protectedOk: false }, ...over,
  } as ToolCallFrame;
}
const protectedCall = (callId: string, over: Partial<ToolCallFrame> = {}): ToolCallFrame =>
  call({ callId, args: { path: ".env" }, ...over });
const signal = () => new AbortController();
type Approval = ApprovalFrame & { rule?: string; command?: string };

/** Starts a gate and waits one macrotask, so the protection check finishes and the approval is sent. */
async function start(esc: Escalation, c: ToolCallFrame, sig: AbortSignal = signal().signal): Promise<{ done: Promise<GateResult> }> {
  const done = esc.gate(c, sig);
  await sleep(0);
  return { done };
}

/** Timers that only fire when a test says so. */
function manualTimers() {
  let next = 1;
  const live = new Map<number, () => void>();
  return {
    setTimeout(fn: () => void): unknown {
      const id = next++;
      live.set(id, fn);
      return id;
    },
    clearTimeout(h: unknown): void {
      live.delete(h as number);
    },
    fireAll(): void {
      for (const [id, fn] of [...live]) {
        live.delete(id);
        fn();
      }
    },
    count: () => live.size,
  };
}

function harness(extra: Partial<Parameters<typeof createEscalation>[0]> = {}) {
  const sent: Frame[] = [];
  let connected = true;
  let n = 0;
  const timers = manualTimers();
  const waiting: string[] = [];
  const esc = createEscalation({
    send: (f) => {
      sent.push(f);
      return connected;
    },
    getRoots: () => [ROOT],
    getCwd: () => ROOT,
    newId: () => `a${++n}`,
    timers,
    onWaiting: (callId, w) => waiting.push(`${callId}:${w ? "pause" : "resume"}`),
    ...extra,
  });
  return {
    esc,
    sent,
    timers,
    waiting,
    disconnect: () => {
      connected = false;
    },
    approvals: (): Approval[] => sent.filter((f): f is Approval => f.type === "approval"),
  };
}

const reply = (approvalId: string, decision: ApprovalReplyFrame["decision"]): ApprovalReplyFrame => ({
  type: "approval_reply", approvalId, decision,
});

describe("escalation: when a gate asks", () => {
  it("allows an unprotected call without sending an approval", async () => {
    const h = harness();
    expect(await h.esc.gate(call(), signal().signal)).toEqual({ allow: true });
    expect(h.approvals()).toEqual([]);
    expect(h.waiting).toEqual([]);
  });

  it("allows a protected call the server approved (protectedOk) without asking", async () => {
    const h = harness();
    const result = await h.esc.gate(protectedCall("c1", { approval: { by: "user", protectedOk: true } }), signal().signal);
    expect(result).toEqual({ allow: true });
    expect(h.approvals()).toEqual([]);
  });

  it("asks for a protected call and allows it when the user allows once", async () => {
    const h = harness();
    const { done: pending } = await start(h.esc, protectedCall("c1"));
    expect(h.approvals()).toHaveLength(1);
    expect(h.esc.pendingCount()).toBe(1);
    h.esc.handleReply(reply("a1", "allowed-once"));
    expect(await pending).toEqual({ allow: true });
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("sends an approval frame with the call, rule, reason and path", async () => {
    const h = harness();
    await start(h.esc, protectedCall("c1"));
    const [frame] = h.approvals();
    expect(frame).toMatchObject({
      type: "approval", requestId: "r1", approvalId: "a1", callId: "c1", tool: "read_file", path: ".env",
    });
    expect(frame.rule).toEqual(expect.any(String));
    expect(frame.reason).toEqual(expect.any(String));
    expect(frame).not.toHaveProperty("command");
  });

  it("includes the command for a protected run_command", async () => {
    const h = harness();
    await start(h.esc, call({ tool: "run_command", callId: "c9", args: { command: "git push --force origin main" } }));
    expect(h.approvals()[0]).toMatchObject({ tool: "run_command", command: "git push --force origin main" });
  });

  it("denies when the user rejects", async () => {
    const h = harness();
    const { done: pending } = await start(h.esc, protectedCall("c1"));
    h.esc.handleReply(reply("a1", "rejected"));
    expect(await pending).toEqual({ allow: false, error: { code: "denied", message: "rejected by the user" } });
  });

  it("treats an unknown decision as a rejection", async () => {
    const h = harness();
    const { done: pending } = await start(h.esc, protectedCall("c1"));
    h.esc.handleReply({ type: "approval_reply", approvalId: "a1", decision: "allowed-always" } as unknown as ApprovalReplyFrame);
    expect((await pending).allow).toBe(false);
  });

  it("has no always-allow path: no extra field on the frame, no allow-always decision", async () => {
    const h = harness();
    await start(h.esc, protectedCall("c1"));
    const keys = Object.keys(h.approvals()[0]).join(" ");
    expect(keys).not.toMatch(/always/i);
  });

  it("returns false from handleReply for an unknown approval", async () => {
    const h = harness();
    expect(h.esc.handleReply(reply("nope", "allowed-once"))).toBe(false);
  });

  it("fails closed when the protection check throws", async () => {
    const h = harness({ checkProtected: () => Promise.reject(new Error("boom")) });
    const { done: pending } = await start(h.esc, call());
    await sleep(0);
    expect(h.approvals()).toHaveLength(1);
    h.esc.handleReply(reply("a1", "rejected"));
    expect((await pending).allow).toBe(false);
  });
});

describe("escalation: when a wait ends without an answer", () => {
  it("cancelAll ends every pending approval as cancelled and reports each settlement", async () => {
    const counts: number[] = [];
    const h = harness({ onPendingChange: (n) => counts.push(n) });
    const { done: a } = await start(h.esc, protectedCall("c1"));
    const { done: b } = await start(h.esc, protectedCall("c2"));
    h.esc.cancelAll();
    const expected: GateResult = { allow: false, error: { code: "cancelled", message: "cancelled" } };
    expect(await a).toEqual(expected);
    expect(await b).toEqual(expected);
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("an abort of the call signal cancels the wait", async () => {
    const h = harness();
    const ac = signal();
    const { done: pending } = await start(h.esc, protectedCall("c1"), ac.signal);
    ac.abort();
    expect(await pending).toEqual({ allow: false, error: { code: "cancelled", message: "cancelled" } });
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("a disconnect while sending cancels the wait", async () => {
    const h = harness();
    h.disconnect();
    const result = await h.esc.gate(protectedCall("c1"), signal().signal);
    expect(result).toEqual({ allow: false, error: { code: "cancelled", message: "not connected" } });
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("expires after the approval limit as denied", async () => {
    const h = harness();
    const { done: pending } = await start(h.esc, protectedCall("c1"));
    expect(h.timers.count()).toBe(1);
    h.timers.fireAll();
    expect(await pending).toEqual({ allow: false, error: { code: "denied", message: "approval timed out" } });
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("uses the 120 s approval limit by default", async () => {
    expect(TOOL_APPROVAL_TIMEOUT_MS).toBe(120_000);
  });
});

describe("escalation: call timer hook and concurrency", () => {
  it("pauses the call's timer while waiting and resumes after the answer", async () => {
    const h = harness();
    const { done: pending } = await start(h.esc, protectedCall("c7"));
    expect(h.waiting).toEqual(["c7:pause"]);
    h.esc.handleReply(reply("a1", "allowed-once"));
    await pending;
    expect(h.waiting).toEqual(["c7:pause", "c7:resume"]);
  });

  it("answers two concurrent approvals out of order", async () => {
    const h = harness();
    const { done: first } = await start(h.esc, protectedCall("c1"));
    const { done: second } = await start(h.esc, protectedCall("c2"));
    expect(h.approvals().map((f) => f.approvalId)).toEqual(["a1", "a2"]);
    expect(h.esc.pendingCount()).toBe(2);

    h.esc.handleReply(reply("a2", "allowed-once"));
    expect(await second).toEqual({ allow: true });
    expect(h.esc.pendingCount()).toBe(1);

    h.esc.handleReply(reply("a1", "rejected"));
    expect((await first).allow).toBe(false);
    expect(h.esc.pendingCount()).toBe(0);
  });

  it("reports the pending count as approvals open and settle", async () => {
    const events: string[] = [];
    const h = harness({ onPendingChange: (n) => events.push(`count:${n}`) });
    const { done: pending } = await start(h.esc, protectedCall("c1"));
    h.esc.handleReply(reply("a1", "allowed-once"));
    await pending;
    expect(events).toEqual(["count:1", "count:0"]);
  });
});

// Run-level: the gate inside createRunManager, through the fake server.
let server: FakeServer | undefined, client: Client | undefined, runs: RunManager | undefined;
afterEach(async () => {
  runs?.dispose();
  client?.close();
  await server?.close();
  runs = client = server = undefined;
});

async function setup(registry: ToolRegistry): Promise<FakeServer> {
  server = await createFakeServer();
  let online = false;
  client = createClient({
    url: server.url, token: "tok", name: "my-pc", instance: "inst", version: "0.2.0",
    tools: ["read_file"], workspaces: () => [ROOT],
    onFrame: (f) => runs?.handleFrame(f),
    onStatus: (s) => { if (s === "online") online = true; },
  });
  runs = createRunManager({ client, registry, host: {} as Host, getRoots: () => [ROOT] });
  await waitFor(() => online);
  return server;
}

const runFrame = (runId: string) => ({
  type: "run", runId, conversationId: "conv", cwd: ROOT, approvalMode: "manual", checkpoint: false, roots: [ROOT],
});
const sent = (types: string[]) => server!.frames.filter((f) => types.includes(f.type));

describe("escalation: run-level behaviour", () => {
  it("the approval wait is not counted toward the call timeout", async () => {
    let executed = 0;
    await setup({ register() {}, execute: async () => { executed += 1; return OK; } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send(protectedCall("c1", { timeoutMs: 200 }));
    await waitFor(() => sent(["approval"]).length === 1);

    await sleep(350); // longer than timeoutMs; the call must not time out while it waits
    expect(sent(["tool_result"])).toEqual([]);

    const approval = sent(["approval"])[0] as ApprovalFrame;
    server!.send(reply(approval.approvalId, "allowed-once"));
    await waitFor(() => sent(["tool_result"]).length === 1);
    expect(sent(["tool_result"])[0]).toMatchObject({ callId: "c1", ok: true });
    expect(executed).toBe(1);
  });

  it("a rejected approval returns denied and never executes the tool", async () => {
    let executed = 0;
    await setup({ register() {}, execute: async () => { executed += 1; return OK; } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send(protectedCall("c1"));
    await waitFor(() => sent(["approval"]).length === 1);
    const approval = sent(["approval"])[0] as ApprovalFrame;
    server!.send(reply(approval.approvalId, "rejected"));
    await waitFor(() => sent(["tool_result"]).length === 1);
    expect(sent(["tool_result"])[0]).toMatchObject({ callId: "c1", ok: false, error: { code: "denied" } });
    expect(executed).toBe(0);
  });

  it("cancel during an approval ends the call as cancelled and drops the late answer", async () => {
    let executed = 0;
    await setup({ register() {}, execute: async () => { executed += 1; return OK; } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send(protectedCall("c1"));
    await waitFor(() => sent(["approval"]).length === 1);
    const approval = sent(["approval"])[0] as ApprovalFrame;

    server!.send({ type: "cancel", runId: "r1" });
    await waitFor(() => sent(["done"]).length === 1);
    server!.send(reply(approval.approvalId, "allowed-once"));
    await sleep(20);

    expect(sent(["tool_result"])).toHaveLength(1);
    expect(sent(["tool_result"])[0]).toMatchObject({ callId: "c1", ok: false, error: { code: "cancelled" } });
    expect(sent(["done"])[0]).toMatchObject({ ok: false, error: "cancelled" });
    expect(executed).toBe(0);
  });

  it("a VS Code panel answer (approval_pending / approval_decision) never resolves the gate", async () => {
    let executed = 0;
    await setup({ register() {}, execute: async () => { executed += 1; return OK; } });
    server!.send(runFrame("r1"));
    await waitFor(() => sent(["run_ack"]).length === 1);
    server!.send(protectedCall("c1"));
    await waitFor(() => sent(["approval"]).length === 1);
    const approval = sent(["approval"])[0] as ApprovalFrame;

    // The server shows its own card with the same id; the extension's gate still waits.
    server!.send({ type: "approval_pending", runId: "r1", approvalId: approval.approvalId, tool: "read_file", summary: ".env", protected: true, reasons: [] });
    server!.send({ type: "approval_settled", approvalId: approval.approvalId, decision: "once", decidedBy: "user" });
    await sleep(60);
    expect(sent(["tool_result"])).toEqual([]);
    expect(executed).toBe(0);

    // Only the server's approval_reply resolves it.
    server!.send(reply(approval.approvalId, "allowed-once"));
    await waitFor(() => sent(["tool_result"]).length === 1);
    expect(sent(["tool_result"])[0]).toMatchObject({ callId: "c1", ok: true });
    expect(executed).toBe(1);
  });
});
