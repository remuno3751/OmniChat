import { afterEach, describe, expect, it } from "vitest";
import { createServerApprovals, toApprovalInput } from "../src/conn/server-approvals";
import { createSession, type Session } from "../src/session";
import type { ApprovalPendingFrame, Frame, ToolCallFrame } from "../src/protocol/frames";
import type { ApprovalInput } from "../src/ui/approvalModel";
import type { Host } from "../src/host/types";
import { createFakeServer, type FakeServer } from "./fake-server";

// Server-originated approvals (spec docs/design/VSCODE-BRIDGE.md §4.4): approval_pending opens a
// VS Code card, the answer goes back as approval_decision, and approval_settled / cancel / done /
// disconnect close it. None of this resolves an extension-originated gate (see escalation.test.ts).
const pendingFrame = (approvalId: string, over: Partial<ApprovalPendingFrame> = {}): ApprovalPendingFrame => ({
  type: "approval_pending", runId: "r1", approvalId, tool: "run_command", summary: "npm publish",
  protected: true, reasons: ["C-git: push"], ...over,
});

function unit() {
  const sent: Frame[] = [];
  const shown: ApprovalInput[] = [];
  const dismissed: string[] = [];
  const counts: number[] = [];
  const approvals = createServerApprovals({
    send: (f) => {
      sent.push(f);
      return true;
    },
    show: (i) => shown.push(i),
    dismiss: (id) => dismissed.push(id),
    onCount: (n) => counts.push(n),
  });
  return { approvals, sent, shown, dismissed, counts };
}

describe("server approvals: panel and answer", () => {
  it("shows a card for approval_pending and reports the count", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    expect(u.shown).toHaveLength(1);
    expect(u.shown[0]).toMatchObject({ approvalId: "s1", requestId: "r1", tool: "run_command", protected: true });
    expect(u.counts).toEqual([1]);
    expect(u.approvals.pendingCount()).toBe(1);
  });

  it("ignores a repeated approvalId", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    u.approvals.pending(pendingFrame("s1"));
    expect(u.shown).toHaveLength(1);
    expect(u.counts).toEqual([1]);
  });

  it("the panel's allow sends approval_decision once, then closes the card", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    expect(u.approvals.answer("s1", "allowed-once")).toBe(true);
    expect(u.sent).toEqual([{ type: "approval_decision", approvalId: "s1", decision: "once" }]);
    expect(u.dismissed).toEqual(["s1"]);
    expect(u.counts).toEqual([1, 0]);
  });

  it("the panel's reject sends decision deny", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    u.approvals.answer("s1", "rejected");
    expect(u.sent).toEqual([{ type: "approval_decision", approvalId: "s1", decision: "deny" }]);
  });

  it("the first answer wins: a second answer sends nothing", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    expect(u.approvals.answer("s1", "allowed-once")).toBe(true);
    expect(u.approvals.answer("s1", "rejected")).toBe(false);
    expect(u.sent).toHaveLength(1);
  });

  it("approval_settled closes the card without sending anything", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    u.approvals.settled("s1");
    expect(u.dismissed).toEqual(["s1"]);
    expect(u.sent).toEqual([]);
    expect(u.approvals.answer("s1", "allowed-once")).toBe(false);
  });

  it("cancelAll (cancel, done, disconnect) closes every card", () => {
    const u = unit();
    u.approvals.pending(pendingFrame("s1"));
    u.approvals.pending(pendingFrame("s2"));
    u.approvals.cancelAll();
    expect(u.dismissed.sort()).toEqual(["s1", "s2"]);
    expect(u.counts).toEqual([1, 2, 1, 0]);
  });

  it("maps the frame to the card view: summary stands in for the path, reasons for the reason", () => {
    const view = toApprovalInput(pendingFrame("s1", { reasons: [] }));
    expect(view).toMatchObject({ approvalId: "s1", path: "npm publish", reason: "npm publish", protected: true });
  });
});

// Session-level: the same frames over the real client and fake server.
const ROOT = "/work/app";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

let server: FakeServer | undefined, session: Session | undefined;
afterEach(async () => {
  session?.stop();
  await server?.close();
  session = server = undefined;
});

async function connect(panel: {
  shown: ApprovalInput[]; dismissed: string[]; counts: number[];
}): Promise<FakeServer> {
  server = await createFakeServer();
  let online = false;
  const host = { roots: [ROOT], openDocuments: [], realpath: async (p: string) => p } as unknown as Host;
  session = createSession({
    host,
    version: "0.2.0",
    instance: "inst",
    isTrusted: () => true,
    shell: () => undefined,
    log: () => {},
    onStatus: (s) => { if (s === "online") online = true; },
    approvals: {
      show: (i) => panel.shown.push(i),
      dismiss: (id) => panel.dismissed.push(id),
      pendingChanged: (n) => panel.counts.push(n),
    },
  });
  session.start({ serverUrl: server.url.replace(/^ws/, "http").replace(/\/bridge$/, ""), token: "tok", name: "my-pc" });
  await waitFor(() => online);
  return server;
}

const sentOf = (type: string): Frame[] => server!.frames.filter((f) => f.type === type);
const runFrame = {
  type: "run", runId: "r1", conversationId: "conv", cwd: ROOT, approvalMode: "manual", checkpoint: false, roots: [ROOT],
};

describe("server approvals: session wiring", () => {
  it("approval_pending opens the panel; the answer goes out as approval_decision", async () => {
    const panel = { shown: [] as ApprovalInput[], dismissed: [] as string[], counts: [] as number[] };
    await connect(panel);
    server!.send(pendingFrame("s1"));
    await waitFor(() => panel.shown.length === 1);
    expect(panel.counts).toEqual([1]);

    session!.answerApproval({ type: "approval_reply", approvalId: "s1", decision: "allowed-once" });
    await waitFor(() => sentOf("approval_decision").length === 1);
    expect(sentOf("approval_decision")[0]).toMatchObject({ approvalId: "s1", decision: "once" });
    expect(panel.dismissed).toEqual(["s1"]);
    expect(panel.counts).toEqual([1, 0]);
  });

  it("approval_settled from the server closes the card", async () => {
    const panel = { shown: [] as ApprovalInput[], dismissed: [] as string[], counts: [] as number[] };
    await connect(panel);
    server!.send(pendingFrame("s1"));
    await waitFor(() => panel.shown.length === 1);
    server!.send({ type: "approval_settled", approvalId: "s1", decision: "deny", decidedBy: "user" });
    await waitFor(() => panel.dismissed.length === 1);
    expect(sentOf("approval_decision")).toEqual([]);
  });

  it("a server cancel closes open cards", async () => {
    const panel = { shown: [] as ApprovalInput[], dismissed: [] as string[], counts: [] as number[] };
    await connect(panel);
    server!.send(runFrame);
    server!.send(pendingFrame("s1"));
    await waitFor(() => panel.shown.length === 1);
    server!.send({ type: "cancel", runId: "r1" });
    await waitFor(() => panel.dismissed.length === 1);
    expect(panel.counts.at(-1)).toBe(0);
  });

  it("stopping the session (disconnect) closes open cards", async () => {
    const panel = { shown: [] as ApprovalInput[], dismissed: [] as string[], counts: [] as number[] };
    await connect(panel);
    server!.send(pendingFrame("s1"));
    await waitFor(() => panel.shown.length === 1);
    session!.stop();
    expect(panel.dismissed).toEqual(["s1"]);
    expect(panel.counts.at(-1)).toBe(0);
  });

  it("the status count combines an extension-originated wait with server cards", async () => {
    const panel = { shown: [] as ApprovalInput[], dismissed: [] as string[], counts: [] as number[] };
    await connect(panel);
    server!.send(runFrame);
    const gated: ToolCallFrame = {
      type: "tool_call", runId: "r1", callId: "c1", tool: "read_file", args: { path: ".env" }, timeoutMs: 5000,
      approval: { by: "mode:manual", protectedOk: false },
    } as ToolCallFrame;
    server!.send(gated);
    await waitFor(() => sentOf("approval").length === 1);
    expect(panel.counts.at(-1)).toBe(1);

    server!.send(pendingFrame("s1"));
    await waitFor(() => panel.shown.length === 1);
    expect(panel.counts.at(-1)).toBe(2);
  });
});
