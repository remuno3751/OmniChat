import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/protocol/codec";
import type { DeviceItem } from "../src/protocol/chat-frames";
import type { Frame } from "../src/protocol/frames";

const roundTrip = (frame: Frame): void => {
  expect(decode(encode(frame))).toEqual(frame);
};

const DEVICE: DeviceItem = { name: "work-pc", kind: "vscode", online: true, self: true, workspaces: ["/work/app"] };

describe("v0.5.5-beta.2 frames: extension -> server", () => {
  const frames: Frame[] = [
    { type: "devices_request", requestId: "d1" },
    { type: "compact_request", requestId: "k1", conversationId: "c1" },
    {
      type: "prompt",
      requestId: "p1",
      cwd: "/work/app",
      text: "read this",
      attachments: [{ name: "notes.txt", mime: "text/plain", data: "aGk=" }],
    },
  ];
  it.each(frames.map((f, i) => [`${f.type} #${i}`, f] as const))("round-trips %s", (_t, frame) => roundTrip(frame));
});

describe("v0.5.5-beta.2 frames: server -> extension", () => {
  const valid: Frame[] = [
    { type: "devices", requestId: "d1", items: [] },
    { type: "devices", requestId: "d1", items: [DEVICE] },
    {
      type: "compacted",
      requestId: "k1",
      conversationId: "c1",
      ok: true,
      before: 90_000,
      after: 4_000,
    },
    {
      type: "models",
      requestId: "m1",
      items: [{ ref: "p::m", label: "Model", provider: "P", contextLength: 128_000, vision: "yes" }],
    },
  ];
  it.each(valid.map((f, i) => [`${f.type} #${i}`, f] as const))("round-trips %s", (_t, frame) => roundTrip(frame));

  it("ignores unknown fields on the new frames", () => {
    expect(decode('{"type":"compacted","requestId":"k1","conversationId":"c1","ok":true,"before":5,"after":2,"x":1}')).not.toBeNull();
  });

  const bad: [string, string][] = [
    ["devices without requestId", '{"type":"devices","items":[]}'],
    ["devices with items not an array", '{"type":"devices","requestId":"d1","items":{}}'],
    ["device with an unknown kind", '{"type":"devices","requestId":"d1","items":[{"name":"x","kind":"tv","online":true,"self":false,"workspaces":[]}]}'],
    ["device with a non-boolean online", '{"type":"devices","requestId":"d1","items":[{"name":"x","kind":"dsh","online":"yes","self":false,"workspaces":[]}]}'],
    ["device with a non-string workspace", '{"type":"devices","requestId":"d1","items":[{"name":"x","kind":"dsh","online":true,"self":false,"workspaces":[1]}]}'],
    ["devices over 50 items", JSON.stringify({ type: "devices", requestId: "d1", items: Array(51).fill(DEVICE) })],
    ["compacted with ok false", '{"type":"compacted","requestId":"k1","conversationId":"c1","ok":false,"before":1,"after":1}'],
    ["compacted without before", '{"type":"compacted","requestId":"k1","conversationId":"c1","ok":true,"after":1}'],
    ["compacted without conversationId", '{"type":"compacted","requestId":"k1","ok":true,"before":1,"after":1}'],
    ["model with an unknown vision value", '{"type":"models","requestId":"m1","items":[{"ref":"a::b","label":"B","provider":"P","vision":"maybe"}]}'],
    ["model with a text contextLength", '{"type":"models","requestId":"m1","items":[{"ref":"a::b","label":"B","provider":"P","contextLength":"big"}]}'],
  ];
  it.each(bad)("drops a malformed frame: %s", (_name, text) => {
    expect(decode(text)).toBeNull();
  });
});
