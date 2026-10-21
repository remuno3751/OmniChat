import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol/codec";
import type { Frame } from "../src/protocol/frames";

const roundTrip = (frame: Frame): void => {
  expect(decode(encode(frame))).toEqual(frame);
};

describe("chat frames: extension -> server", () => {
  const frames: Frame[] = [
    { type: "prompt", requestId: "p1", cwd: "/work/app", text: "hi" },
    {
      type: "prompt",
      requestId: "p2",
      cwd: "/work/app",
      text: "hi",
      conversationId: "c1",
      model: "prov::mod",
      approvalMode: "full",
      confirmFull: true,
    },
    { type: "models_request", requestId: "m1" },
    { type: "conversations_request", requestId: "l1", cwd: "/work/app" },
    { type: "conversation_request", requestId: "v1", conversationId: "c1" },
    { type: "set_approval_mode", requestId: "a1", conversationId: "c1", mode: "auto" },
    { type: "stop", requestId: "s1", conversationId: "c1" },
  ];
  it.each(frames.map((f, i) => [`${f.type} #${i}`, f] as const))("round-trips %s", (_t, frame) => roundTrip(frame));
});

describe("chat frames: server -> extension", () => {
  const frames: Frame[] = [
    { type: "prompt_ack", requestId: "p1", ok: true, conversationId: "c1" },
    { type: "prompt_ack", requestId: "p1", ok: false, error: "busy", message: "a run is active" },
    {
      type: "models",
      requestId: "m1",
      items: [{ ref: "p::m", label: "Model", provider: "P" }],
      defaultRef: "p::m",
    },
    { type: "models", requestId: "m1", items: [] },
    {
      type: "conversations",
      requestId: "l1",
      items: [{ id: "c1", title: "t", updatedAt: 1760000000000, approvalMode: "manual", cwd: "/work/app" }],
    },
    {
      type: "transcript",
      conversationId: "c1",
      runId: "r1",
      reset: true,
      items: [
        { kind: "user", id: "m1", text: "hi" },
        { kind: "assistant", id: "m2", text: "yo", reasoning: "hm", status: "streaming" },
        {
          kind: "tool",
          id: "k1",
          tool: "edit_file",
          summary: "src/a.ts",
          status: "done",
          decidedBy: "user",
          durationMs: 12,
        },
        { kind: "status", text: "checkpoint" },
      ],
    },
    { type: "approval_mode", conversationId: "c1", mode: "full", ok: true },
    { type: "approval_mode", conversationId: "c1", ok: false, error: "confirm_required" },
  ];
  it.each(frames.map((f, i) => [`${f.type} #${i}`, f] as const))("round-trips %s", (_t, frame) => roundTrip(frame));

  it("ignores unknown fields", () => {
    const f = decode('{"type":"models","requestId":"m1","items":[],"future":{"x":1}}');
    expect(f).toMatchObject({ type: "models", requestId: "m1" });
  });

  const bad: [string, string][] = [
    ["ack without conversationId", '{"type":"prompt_ack","requestId":"p1","ok":true}'],
    ["failed ack without error", '{"type":"prompt_ack","requestId":"p1","ok":false}'],
    ["model without label", '{"type":"models","requestId":"m1","items":[{"ref":"a"}]}'],
    ["models without items", '{"type":"models","requestId":"m1"}'],
    [
      "bad updatedAt",
      '{"type":"conversations","requestId":"l1","items":[{"id":"c","title":"t","updatedAt":"x","approvalMode":"manual","cwd":""}]}',
    ],
    [
      "bad mode",
      '{"type":"conversations","requestId":"l1","items":[{"id":"c","title":"t","updatedAt":1,"approvalMode":"yolo","cwd":""}]}',
    ],
    [
      "bad assistant status",
      '{"type":"transcript","conversationId":"c1","items":[{"kind":"assistant","id":"a","text":"x","status":"weird"}]}',
    ],
    [
      "bad tool status",
      '{"type":"transcript","conversationId":"c1","items":[{"kind":"tool","id":"a","tool":"t","summary":"s","status":"nope"}]}',
    ],
    ["unknown item kind", '{"type":"transcript","conversationId":"c1","items":[{"kind":"mystery","id":"a"}]}'],
    ["transcript without conversation", '{"type":"transcript","items":[]}'],
    ["mode ack without mode", '{"type":"approval_mode","conversationId":"c1","ok":true}'],
    ["mode failure without error", '{"type":"approval_mode","conversationId":"c1","ok":false}'],
  ];
  it.each(bad)("rejects %s", (_name, text) => {
    expect(decode(text)).toBeNull();
  });
});
