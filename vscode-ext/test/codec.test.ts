import { describe, it, expect } from "vitest";
import { encode, decode, MAX_FRAME_BYTES } from "../src/protocol/codec";
import type { Frame } from "../src/protocol/frames";

const samples: Frame[] = [
  // E -> S
  {
    type: "ready",
    kind: "vscode",
    name: "my-pc",
    instance: "6f1c",
    version: "0.1.0",
    protocol: 1,
    vscodeVersion: "1.96.0",
    platform: "linux",
    shell: "bash",
    remote: null,
    cwd: "/work/app",
    workspaces: ["/work/app", "/work/lib"],
    allowAnyCwd: false,
    trusted: true,
    capabilities: {
      workspaces: true,
      fs: false,
      approval: true,
      checkpoints: true,
      transcript: false,
      tools: ["read_file", "list_dir", "git_commit"],
    },
  },
  { type: "workspaces", workspaces: ["/work/app"], allowAnyCwd: false },
  { type: "run_ack", runId: "r1", ok: true },
  { type: "run_ack", runId: "r1", ok: false, error: "busy" },
  {
    type: "checkpoint",
    requestId: "r1",
    checkpointId: "cp1",
    ref: "refs/omnichat/checkpoints/cp1",
    createdAt: 1760000000000,
    dirty: false,
  },
  { type: "checkpoint", requestId: "r1", unavailable: "not a git repository" },
  {
    type: "event",
    runId: "r1",
    event: { type: "tool_progress", callId: "c1", stream: "stdout", text: "hi" },
  },
  {
    type: "tool_result",
    runId: "r1",
    callId: "c1",
    ok: true,
    result: { content: "x" },
    truncated: false,
    durationMs: 12,
  },
  {
    type: "tool_result",
    runId: "r1",
    callId: "c1",
    ok: false,
    error: { code: "not_found", message: "missing", details: { path: "a" } },
  },
  {
    type: "approval",
    requestId: "r1",
    approvalId: "a1",
    callId: "c1",
    tool: "read_file",
    path: "/etc/hosts",
    reason: "outside workspace (symlink)",
  },
  {
    type: "changes",
    requestId: "r1",
    changes: [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@" },
    ],
    truncated: false,
  },
  { type: "done", runId: "r1", ok: true },
  { type: "done", runId: "r1", ok: false, error: "cancelled", warning: "w" },
  { type: "rewound", requestId: "q1", ok: true },
  { type: "error", code: "quota", message: "limit reached", requestId: "p1" },
  // S -> E
  {
    type: "welcome",
    protocol: 1,
    serverVersion: "0.6.0",
    minExtensionVersion: "0.1.0",
  },
  {
    type: "run",
    runId: "r1",
    conversationId: "c1",
    cwd: "/work/app",
    approvalMode: "manual",
    checkpoint: true,
    roots: ["/work/app"],
  },
  {
    type: "tool_call",
    runId: "r1",
    callId: "c1",
    tool: "read_file",
    args: { path: "src/a.ts" },
    approval: { by: "mode:manual", protectedOk: false },
    timeoutMs: 60000,
  },
  { type: "cancel", runId: "r1" },
  { type: "approval_reply", approvalId: "a1", decision: "allowed-once" },
  {
    type: "approval_pending",
    runId: "r1",
    approvalId: "a2",
    tool: "run_command",
    summary: "npm publish",
    protected: true,
    reasons: ["C-git: push"],
  },
  { type: "approval_settled", approvalId: "a2", decision: "once", decidedBy: "user" },
  { type: "approval_decision", approvalId: "a2", decision: "once" },
  { type: "run_end", runId: "r1" },
  {
    type: "rewind",
    requestId: "q1",
    ref: "refs/omnichat/checkpoints/cp1",
    cwd: "/work/app",
    removeNew: false,
  },
];

describe("tool_call approval.outsideOk", () => {
  const frame = (approval: Record<string, unknown>): string =>
    JSON.stringify({
      type: "tool_call", runId: "r1", callId: "c1", tool: "read_file", args: { path: "/etc/hosts" },
      approval, timeoutMs: 60000,
    });

  it("keeps a boolean outsideOk and accepts its absence", () => {
    const yes = decode(frame({ by: "user", protectedOk: false, outsideOk: true })) as { approval?: { outsideOk?: boolean } } | null;
    expect(yes?.approval?.outsideOk).toBe(true);
    expect(decode(frame({ by: "user", protectedOk: false, outsideOk: false }))).not.toBeNull();
    expect(decode(frame({ by: "user", protectedOk: false }))).not.toBeNull();
  });

  it("rejects a non-boolean outsideOk", () => {
    expect(decode(frame({ by: "user", protectedOk: false, outsideOk: "yes" }))).toBeNull();
    expect(decode(frame({ by: "user", protectedOk: false, outsideOk: 1 }))).toBeNull();
  });
});

describe("codec", () => {
  it("covers all 21 frame types in samples", () => {
    const types = new Set(samples.map((f) => f.type));
    expect(types.size).toBe(21);
  });

  it("accepts an error frame with a code, and optional message and requestId", () => {
    expect(decode(JSON.stringify({ type: "error", code: "timeout" }))).not.toBeNull();
    expect(decode(JSON.stringify({ type: "error", code: "busy", requestId: "p9", extra: 1 }))).not.toBeNull();
  });

  it("drops a malformed error frame", () => {
    expect(decode(JSON.stringify({ type: "error" }))).toBeNull();
    expect(decode(JSON.stringify({ type: "error", code: "" }))).toBeNull();
    expect(decode(JSON.stringify({ type: "error", code: "x", message: 5 }))).toBeNull();
    expect(decode(JSON.stringify({ type: "error", code: "x", requestId: {} }))).toBeNull();
  });

  it.each(samples.map((f) => [f.type, f] as const))(
    "round-trips %s frame",
    (_type, frame) => {
      const text = encode(frame);
      expect(decode(text)).toEqual(frame);
    },
  );

  it("ignores unknown fields", () => {
    const text = JSON.stringify({
      type: "cancel",
      runId: "r1",
      futureField: { x: 1 },
    });
    const frame = decode(text);
    expect(frame).not.toBeNull();
    expect(frame).toMatchObject({ type: "cancel", runId: "r1" });
  });

  it("returns null for unknown type", () => {
    expect(decode(JSON.stringify({ type: "bogus", runId: "r1" }))).toBeNull();
  });

  it("returns null when type is missing or not a string", () => {
    expect(decode(JSON.stringify({ runId: "r1" }))).toBeNull();
    expect(decode(JSON.stringify({ type: 42 }))).toBeNull();
    expect(decode(JSON.stringify({ type: null }))).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(decode("[]")).toBeNull();
    expect(decode("null")).toBeNull();
    expect(decode('"cancel"')).toBeNull();
  });

  it("returns null for bad JSON without throwing", () => {
    expect(() => decode("{not json")).not.toThrow();
    expect(decode("{not json")).toBeNull();
    expect(decode("")).toBeNull();
  });

  it("accepts a frame exactly at the 8 MB limit", () => {
    const prefix = '{"type":"cancel","runId":"r1","pad":"';
    const suffix = '"}';
    const pad = "a".repeat(MAX_FRAME_BYTES - prefix.length - suffix.length);
    const text = prefix + pad + suffix;
    expect(Buffer.byteLength(text, "utf8")).toBe(MAX_FRAME_BYTES);
    expect(decode(text)).not.toBeNull();
  });

  it("rejects a frame over 8 MB", () => {
    const prefix = '{"type":"cancel","runId":"r1","pad":"';
    const suffix = '"}';
    const pad = "a".repeat(MAX_FRAME_BYTES - prefix.length - suffix.length + 1);
    expect(decode(prefix + pad + suffix)).toBeNull();
  });

  it("measures the limit in UTF-8 bytes, not characters", () => {
    // "あ" is 3 bytes in UTF-8: fewer than 8 MB of characters can still exceed 8 MB of bytes.
    const chars = Math.ceil(MAX_FRAME_BYTES / 3) + 10;
    const text = '{"type":"cancel","runId":"r1","pad":"' + "あ".repeat(chars) + '"}';
    expect(text.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(decode(text)).toBeNull();
  });
});

describe("v0.5.5 frames", () => {
  it("decodes context and context_request (they were dropped as unknown before)", () => {
    expect(decode(JSON.stringify({ type: "context", requestId: "c1", total: 5, limit: 0, fits: true, estimated: true }))).not.toBeNull();
    expect(decode(JSON.stringify({ type: "context_request", requestId: "c1", conversationId: "x" }))).not.toBeNull();
  });
});
