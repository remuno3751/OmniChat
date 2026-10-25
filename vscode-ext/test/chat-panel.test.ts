import { describe, expect, it } from "vitest";
import { createChatPanel } from "../src/ui/chatPanel";

/** A fake VS Code: one WebviewPanel per createWebviewPanel call, with the listeners the panel uses. */
function fakeVscode() {
  const panels: Array<ReturnType<typeof fakePanel>> = [];
  const fakePanel = () => {
    const posted: unknown[] = [];
    let onMsg: ((m: unknown) => void) | undefined;
    let onDispose: (() => void) | undefined;
    let reveals = 0;
    const p = {
      webview: {
        cspSource: "csp",
        html: "",
        asWebviewUri: (u: { toString(): string }) => u,
        postMessage: (m: unknown) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn: (m: unknown) => void) => ((onMsg = fn), { dispose() {} }),
      },
      reveal: () => void reveals++,
      onDidDispose: (fn: () => void) => ((onDispose = fn), { dispose() {} }),
      dispose: () => onDispose?.(),
      receive: (m: unknown) => onMsg?.(m),
      posted,
      reveals: () => reveals,
    };
    return p;
  };
  const vscode = {
    window: {
      createWebviewPanel: () => {
        const p = fakePanel();
        panels.push(p);
        return p;
      },
    },
    ViewColumn: { Beside: 2 },
    Uri: { joinPath: (_b: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") }) },
  };
  return { vscode: vscode as never, panels };
}

function setup() {
  const { vscode, panels } = fakeVscode();
  const ready: number[] = [];
  const messages: unknown[] = [];
  const panel = createChatPanel({
    vscode,
    extensionUri: {} as never,
    title: "OmniChat VS: Chat",
    script: "chat.js",
    styles: [],
    getTheme: () => "frontier" as never,
    getDecorations: () => "auto" as never,
    onReady: () => ready.push(1),
    onMessage: (m) => messages.push(m),
  });
  return { panel, panels, ready, messages };
}

describe("editor chat panel", () => {
  it("opens one panel and reveals it on a second open", () => {
    const t = setup();
    expect(t.panel.isOpen()).toBe(false);
    t.panel.open();
    t.panel.open();
    expect(t.panels).toHaveLength(1);
    expect(t.panels[0]?.reveals()).toBe(1);
    expect(t.panel.isOpen()).toBe(true);
  });

  it("drops posts until the page says ready, then delivers them", () => {
    const t = setup();
    t.panel.open();
    t.panel.post({ type: "state" });
    expect(t.panels[0]?.posted).toEqual([]);
    t.panels[0]?.receive({ type: "ready" });
    expect(t.ready).toEqual([1]);
    t.panel.post({ type: "state" });
    expect(t.panels[0]?.posted).toEqual([{ type: "state" }]);
  });

  it("hands every other message from the page to onMessage", () => {
    const t = setup();
    t.panel.open();
    t.panels[0]?.receive({ type: "send", text: "hi" });
    expect(t.messages).toEqual([{ type: "send", text: "hi" }]);
  });

  it("forgets the panel when it is closed, so the next open creates a new one", () => {
    const t = setup();
    t.panel.open();
    t.panels[0]?.dispose();
    expect(t.panel.isOpen()).toBe(false);
    t.panel.open();
    expect(t.panels).toHaveLength(2);
  });
});
