import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createActivityFeed, eventsForFrame } from "../src/ui/activityFeed";
import {
  LABEL_MAX_CHARS,
  MAX_STEPS,
  describeCall,
  maskSecrets,
  reduce,
  type ActivityEvent,
  type ActivityState,
} from "../src/ui/activityModel";
import { formatStatus } from "../src/ui/status";
import type { Frame } from "../src/protocol/frames";

const start: ActivityEvent = { type: "runStart", runId: "r1", cwd: "/work/app", mode: "manual" };
const call = (callId: string, tool: string, args: unknown): ActivityEvent => ({ type: "toolCall", callId, tool, args });
const ok = (callId: string, durationMs = 5): ActivityEvent => ({ type: "toolResult", callId, ok: true, summary: "", durationMs });
const fail = (callId: string, summary: string): ActivityEvent => ({ type: "toolResult", callId, ok: false, summary, durationMs: 0 });

function run(events: ActivityEvent[]): ActivityState {
  let state: ActivityState | null = null;
  for (const e of events) state = reduce(state, e);
  if (state === null) throw new Error("no run");
  return state;
}

describe("reduce: ordering, progress and errors", () => {
  it("ignores events before a run starts", () => {
    expect(reduce(null, call("c1", "read_file", { path: "a" }))).toBeNull();
  });

  it("keeps arrival order and counts progress", () => {
    const state = run([start, call("c1", "read_file", { path: "src/a.ts" }), call("c2", "run_command", { command: "npm test" }), ok("c2"), ok("c1", 3)]);
    expect(state.steps.map((s) => s.callId)).toEqual(["c1", "c2"]);
    expect(state.steps.map((s) => s.status)).toEqual(["ok", "ok"]);
    expect(state.steps[0].durationMs).toBe(3);
    expect(state.progress).toEqual({ done: 2, total: 2 });
    expect(state.status).toBe("running");
    expect(state.mode).toBe("manual");
  });

  it("marks failed calls and keeps a masked, cut note", () => {
    const state = run([start, call("c1", "grep", { pattern: "x" }), fail("c1", "not_found:\n Authorization: Bearer abc123 missing")]);
    expect(state.steps[0].status).toBe("error");
    expect(state.steps[0].note).toBe("not_found: Authorization: *** missing");
    expect(state.progress.done).toBe(1);
  });

  it("ignores unknown call ids and duplicate results", () => {
    const before = run([start, call("c1", "list_dir", { path: "." }), ok("c1")]);
    expect(reduce(before, ok("zz"))).toBe(before);
    expect(reduce(before, fail("c1", "late"))).toBe(before);
    expect(reduce(before, call("c1", "list_dir", {}))).toBe(before);
  });

  it("closes open calls and sets the run status when the run ends", () => {
    const done = run([start, call("c1", "glob", { pattern: "*.ts" }), ok("c1"), { type: "runDone", ok: true }]);
    expect(done.status).toBe("done");
    const cancelled = run([start, call("c1", "run_command", { command: "sleep 9" }), { type: "runDone", ok: false, error: "cancelled" }]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0].status).toBe("error");
    expect(cancelled.progress).toEqual({ done: 1, total: 1 });
    expect(run([start, { type: "runDone", ok: false, error: "boom" }]).status).toBe("error");
  });

  it("ignores events after the run ended", () => {
    const ended = run([start, { type: "runDone", ok: true }]);
    expect(reduce(ended, call("c9", "read_file", { path: "a" }))).toBe(ended);
    expect(reduce(ended, { type: "runDone", ok: false, error: "x" })).toBe(ended);
  });

  it("shows a pending approval until the next result", () => {
    const waiting = run([start, call("c1", "write_file", { path: "a.ts" }), { type: "approvalPending", approvalId: "a1" }]);
    expect(waiting.awaitingApproval).toBe("a1");
    expect(reduce(waiting, ok("c1"))?.awaitingApproval).toBeNull();
  });

  it("starts over when a new run begins", () => {
    const first = run([start, call("c1", "list_dir", { path: "." })]);
    const second = reduce(first, { type: "runStart", runId: "r2", cwd: "/other" });
    expect(second?.runId).toBe("r2");
    expect(second?.steps).toEqual([]);
    expect(second?.progress).toEqual({ done: 0, total: 0 });
  });

  it("keeps the last 200 steps but counts every call", () => {
    const events: ActivityEvent[] = [start];
    for (let i = 0; i < 250; i += 1) events.push(call(`c${i}`, "read_file", { path: `f${i}.ts` }), ok(`c${i}`));
    const state = run(events);
    expect(MAX_STEPS).toBe(200);
    expect(state.steps).toHaveLength(200);
    expect(state.steps[0].callId).toBe("c50");
    expect(state.steps[199].callId).toBe("c249");
    expect(state.progress).toEqual({ done: 250, total: 250 });
  });
});

describe("describeCall: labels", () => {
  it("gives a short verb label per tool", () => {
    expect(describeCall("read_file", { path: "src/a.ts" })).toBe("read src/a.ts");
    expect(describeCall("list_dir", {})).toBe("list .");
    expect(describeCall("glob", { pattern: "**/*.ts" })).toBe("glob **/*.ts");
    expect(describeCall("grep", { pattern: "TODO", path: "src" })).toBe("grep TODO in src");
    expect(describeCall("edit_file", { path: "x.ts", oldString: "a", newString: "b" })).toBe("edit x.ts");
    expect(describeCall("write_file", { path: "x.ts", content: "" })).toBe("write x.ts");
    expect(describeCall("run_command", { command: "npm test" })).toBe("run npm test");
    expect(describeCall("git_status", {})).toBe("git status");
    expect(describeCall("git_commit", { message: "fix" })).toBe("git commit fix");
    expect(describeCall("mystery_tool", { path: "p" })).toBe("mystery_tool p");
    expect(describeCall("read_file", null)).toBe("read");
  });

  it("collapses whitespace and cuts long labels to the limit with an ellipsis", () => {
    expect(describeCall("run_command", { command: "npm\n   test" })).toBe("run npm test");
    const label = describeCall("read_file", { path: "d/".repeat(200) });
    expect(Array.from(label)).toHaveLength(LABEL_MAX_CHARS);
    expect(label.endsWith("…")).toBe(true);
  });

  it("masks secret-like values", () => {
    expect(maskSecrets("curl --token=abc123 https://x")).toBe("curl --token=*** https://x");
    expect(maskSecrets("tool --password hunter2")).toBe("tool --password ***");
    expect(maskSecrets("curl -H Authorization: Bearer xyz")).toBe("curl -H Authorization: ***");
    expect(maskSecrets("GITHUB_TOKEN=ghp_1 npm run")).toBe("GITHUB_TOKEN=*** npm run");
    expect(maskSecrets("git commit -m 'fix token handling'")).toBe("git commit -m 'fix token handling'");
    expect(describeCall("run_command", { command: "deploy --api-key=k1" })).toBe("run deploy --api-key=***");
  });
});

describe("feed: frame adapter", () => {
  const runFrame: Frame = { type: "run", runId: "r1", conversationId: "c1", cwd: "/work/app", approvalMode: "manual", checkpoint: true, roots: ["/work/app"] };
  const ack: Frame = { type: "run_ack", runId: "r1", ok: true };
  const toolCall: Frame = { type: "tool_call", runId: "r1", callId: "c1", tool: "read_file", args: { path: "src/a.ts" }, timeoutMs: 60000 };
  const result: Frame = { type: "tool_result", runId: "r1", callId: "c1", ok: true, result: {}, truncated: false, durationMs: 12 };
  const done: Frame = { type: "done", runId: "r1", ok: true };

  it("starts a run only once the run is acknowledged", () => {
    const seen: (ActivityState | null)[] = [];
    const feed = createActivityFeed((s) => seen.push(s));
    feed.handle(runFrame);
    expect(seen).toHaveLength(0);
    feed.handle(ack);
    expect(feed.state()?.cwd).toBe("/work/app");
    expect(feed.state()?.mode).toBe("manual");
    expect(seen).toHaveLength(1);
  });

  it("does not replace the run on screen when the new run is rejected as busy", () => {
    const feed = createActivityFeed(() => {});
    feed.handle(runFrame);
    feed.handle(ack);
    feed.handle(toolCall);
    const before = feed.state();
    feed.handle({ ...runFrame, runId: "r2" });
    feed.handle({ type: "run_ack", runId: "r2", ok: false, error: "busy" });
    expect(feed.state()).toBe(before);
  });

  it("maps a full run: tool_call, tool_result, done", () => {
    const feed = createActivityFeed(() => {});
    [runFrame, ack, toolCall, result, done].forEach((f) => feed.handle(f));
    const state = feed.state();
    expect(state?.status).toBe("done");
    expect(state?.steps).toEqual([expect.objectContaining({ callId: "c1", label: "read src/a.ts", status: "ok", durationMs: 12 })]);
    expect(state?.progress).toEqual({ done: 1, total: 1 });
  });

  it("maps a cancelled done and a failed tool_result with its code", () => {
    const feed = createActivityFeed(() => {});
    [runFrame, ack, toolCall, { type: "tool_result", runId: "r1", callId: "c1", ok: false, error: { code: "not_found", message: "no file" } } as Frame].forEach((f) => feed.handle(f));
    expect(feed.state()?.steps[0].note).toBe("not_found: no file");
    feed.handle({ type: "done", runId: "r1", ok: false, error: "cancelled" });
    expect(feed.state()?.status).toBe("cancelled");
  });

  it("ends a running run as an error when the connection drops", () => {
    const feed = createActivityFeed(() => {});
    [runFrame, ack, toolCall].forEach((f) => feed.handle(f));
    feed.interrupt("disconnected");
    expect(feed.state()?.status).toBe("error");
    expect(feed.state()?.steps[0].status).toBe("error");
  });

  it("does not notify for frames it does not map", () => {
    let calls = 0;
    const feed = createActivityFeed(() => {
      calls += 1;
    });
    feed.handle({ type: "welcome", protocol: 1, serverVersion: "0.6.0", minExtensionVersion: "0.1.0" });
    feed.handle({ type: "tool_result", runId: "r9", callId: "zz", ok: true, result: {}, truncated: false, durationMs: 1 });
    expect(calls).toBe(0);
    expect(eventsForFrame({ type: "welcome", protocol: 1, serverVersion: "0", minExtensionVersion: "0" })).toEqual([]);
  });
});

describe("formatStatus", () => {
  it("shows running with a spinner only while online", () => {
    expect(formatStatus("online", true).text).toBe("$(loading~spin) OmniChat: running");
    expect(formatStatus("offline", true).text).toBe("$(debug-disconnect) OmniChat: offline");
  });

  it("keeps the connection text and tooltip when not running", () => {
    expect(formatStatus("online", false)).toEqual({
      text: "$(plug) OmniChat: online",
      tooltip: "OmniChat: online. Click to open OmniChat.",
    });
    expect(formatStatus("unauthorized", false, "bad token").tooltip).toBe("OmniChat: unauthorized (bad token)");
    expect(formatStatus("unpaired", false).text).toBe("$(key) OmniChat: not paired");
  });
});

describe("webview activity.js and activity.css", () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../media/webview/${name}`, import.meta.url)), "utf8");

  it("renders with textContent only and uses the VS Code API", () => {
    const src = read("activity.js");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(src).toContain("acquireVsCodeApi");
    expect(src).toContain('msg.type === "state"');
  });

  it("has no continuous motion and no backdrop blur", () => {
    for (const name of ["activity.js", "activity.css"]) {
      expect(read(name)).not.toMatch(/infinite|backdrop-filter/);
    }
  });
});
