import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewProvider } from "../src/ui/viewProvider";

function fakeVscode() {
  const Uri = { joinPath: (_b: unknown, ...p: string[]) => ({ toString: () => p.join("/") }) };
  return { Uri } as never;
}
function fakeView() {
  let htmlWrites = 0;
  const webview = {
    cspSource: "csp",
    options: {},
    asWebviewUri: (u: { toString(): string }) => u,
    onDidReceiveMessage: () => ({ dispose() {} }),
    postMessage: () => Promise.resolve(true),
    set html(_v: string) { htmlWrites++; },
  };
  const view = { webview, visible: true, onDidDispose: () => ({ dispose() {} }), show() {} };
  return { view: view as never, writes: () => htmlWrites };
}
const opts = (extra = {}) => ({
  vscode: fakeVscode(), extensionUri: {} as never, title: "t", script: "s.js", styles: [],
  getTheme: () => "frontier" as never, getDecorations: () => "auto" as never,
  onReady: () => {}, onMessage: () => {}, ...extra,
});

describe("view provider load handling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes the HTML at once by default and rebuilds a view that never says ready", () => {
    const h = createViewProvider("v", opts());
    const f = fakeView();
    h.provider.resolveWebviewView(f.view, {} as never, {} as never);
    expect(f.writes()).toBe(1);
    vi.advanceTimersByTime(6000);
    expect(f.writes()).toBe(2);
    vi.advanceTimersByTime(6000);
    expect(f.writes()).toBe(3);
    vi.advanceTimersByTime(60000);
    expect(f.writes()).toBe(3); // bounded
  });

  it("defers the first write when asked", () => {
    const h = createViewProvider("v", opts({ deferHtmlMs: 700 }));
    const f = fakeView();
    h.provider.resolveWebviewView(f.view, {} as never, {} as never);
    expect(f.writes()).toBe(0);
    vi.advanceTimersByTime(700);
    expect(f.writes()).toBe(1);
  });
});
