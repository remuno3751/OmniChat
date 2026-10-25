import { describe, expect, it } from "vitest";
import { createFrameCoalescer } from "../src/webview/chat/messages";
import type { FrameApi } from "../src/webview/chat/messages";

/** A frame API whose callbacks run only when the test calls `frame()`. */
function fakeFrames() {
  let next = 1;
  const queued = new Map<number, () => void>();
  const cancelled: number[] = [];
  const api: FrameApi = {
    request(cb) {
      const h = next++;
      queued.set(h, cb);
      return h;
    },
    cancel(h) {
      cancelled.push(h);
      queued.delete(h);
    },
  };
  return {
    api,
    cancelled,
    pending: () => queued.size,
    frame() {
      const cbs = [...queued.values()];
      queued.clear();
      for (const cb of cbs) cb();
    },
  };
}

describe("createFrameCoalescer", () => {
  it("paints at most once per frame however many requests arrive", () => {
    const f = fakeFrames();
    let paints = 0;
    const c = createFrameCoalescer(() => paints++, f.api);
    c.request();
    c.request();
    c.request();
    expect(f.pending()).toBe(1);
    expect(paints).toBe(0);
    f.frame();
    expect(paints).toBe(1);
    expect(f.pending()).toBe(0);
  });

  it("schedules a new frame for requests made after a paint", () => {
    const f = fakeFrames();
    let paints = 0;
    const c = createFrameCoalescer(() => paints++, f.api);
    c.request();
    f.frame();
    c.request();
    f.frame();
    expect(paints).toBe(2);
  });

  it("flush cancels the pending frame and paints synchronously", () => {
    const f = fakeFrames();
    let paints = 0;
    const c = createFrameCoalescer(() => paints++, f.api);
    c.request();
    c.flush();
    expect(paints).toBe(1);
    expect(f.cancelled).toHaveLength(1);
    expect(f.pending()).toBe(0);
    f.frame();
    expect(paints).toBe(1);
  });

  it("flush without a pending frame still paints once", () => {
    const f = fakeFrames();
    let paints = 0;
    const c = createFrameCoalescer(() => paints++, f.api);
    c.flush();
    expect(paints).toBe(1);
    expect(f.cancelled).toHaveLength(0);
  });

  it("the paint callback sees the latest state at frame time", () => {
    const f = fakeFrames();
    let text = "";
    const seen: string[] = [];
    const c = createFrameCoalescer(() => seen.push(text), f.api);
    text = "a";
    c.request();
    text = "ab";
    c.request();
    text = "abc";
    c.request();
    f.frame();
    expect(seen).toEqual(["abc"]);
  });
});
