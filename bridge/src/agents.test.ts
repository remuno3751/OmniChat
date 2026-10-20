import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentTracker, type AgentInfo } from "./agents.js";
import { appendFrame, asst, header, rec, sessionFile, tmpDir } from "./testutil.js";
import type { DshEvent } from "./dsh.js";

const CWD = "C:\\ws";

function clock(start = 1000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

function tracker(home: string, extra: { onChange?: (a: AgentInfo[]) => void } = {}) {
  const c = clock();
  const tr = new AgentTracker({ dshHome: home, now: c.now, ...extra });
  return { tr, c };
}

const call = (callId: string, tool: string, input: unknown): DshEvent => ({ type: "tool_call", callId, tool, input }) as DshEvent;
const result = (callId: string, status: string, res: unknown): DshEvent => ({ type: "tool_result", callId, status, result: res }) as DshEvent;

/** Writes a child dsh session log at <home>/sessions/<slug>/<id>/session.v4.jsonl.zstd. */
function childLog(home: string, id: string, records: unknown[]) {
  appendFrame(sessionFile(home, "--child-slug--", id), [header(id, CWD), ...records]);
}

const CHILD = "b015e004-b1ba-4fbe-9cb0-bcec3bd2f75a";
const started = (callId: string, childId = CHILD) => result(callId, "completed", `started subagent ${childId}`);

test("subagent_fork success: running -> done with summary and log", () => {
  const { tr, c } = tracker(tmpDir());
  tr.onEvent(call("F1", "subagent_fork", { description: "  Read a.txt file  ", prompt: "Read a.txt please" }));
  assert.deepEqual(tr.list(), [{ id: "F1", role: "Read a.txt file", status: "running", startedAt: 1000, endedAt: null }]);
  c.set(2500);
  tr.onEvent(result("F1", "completed", "hello from a.txt"));
  assert.deepEqual(tr.list(), [
    {
      id: "F1",
      role: "Read a.txt file",
      status: "done",
      startedAt: 1000,
      endedAt: 2500,
      summary: "hello from a.txt",
      log: "# task\nRead a.txt please\n\n# result\nhello from a.txt",
    },
  ]);
});

test("subagent_fork error: status error, summary cut to 300 chars", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("F2", "subagent_fork", { description: "boom", prompt: "p" }));
  tr.onEvent(result("F2", "error", "x".repeat(400)));
  const [a] = tr.list();
  assert.equal(a.status, "error");
  assert.equal(a.summary, "x".repeat(300));
  assert.equal(typeof a.endedAt, "number");
});

test("continuable subagent: completed turn -> summary is last text, endedAt is the turn/end time", () => {
  const home = tmpDir();
  childLog(home, CHILD, [
    rec(1, 1001, "turn/start", { turn: 1 }),
    rec(2, 1002, "user/message", { content: [{ type: "text", text: "go" }], source: { kind: "user" }, role: "user", id: "u1" }),
    asst(3, 1003, 1, 1, [{ type: "reasoning", text: "hidden" }, { type: "text", text: "part one" }, { type: "tool-call", id: "t1", name: "read" }]),
    rec(4, 1004, "tool/call", { turn: 1, step: 1, callId: "t1", name: "read", arguments: '{"path":"a.txt"}' }),
    rec(5, 1005, "tool/result", { turn: 1, step: 1, message: { content: [{ type: "text", text: "Error: ENOENT" }], toolCallId: "t1" } }),
    asst(6, 1006, 1, 2, [{ type: "text", text: "final answer" }]),
    rec(7, 4321, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ]);
  const { tr, c } = tracker(home);
  tr.onEvent(call("C2", "subagent", { description: "Bg read", prompt: "read it" }));
  tr.onEvent(started("C2"));
  assert.equal(tr.list()[0].status, "running");
  assert.equal(tr.list()[0].endedAt, null);
  c.set(9999);
  tr.finalize();
  const [a] = tr.list();
  assert.equal(a.status, "done");
  assert.equal(a.summary, "final answer");
  assert.equal(a.endedAt, 4321);
  assert.ok(a.log!.includes("part one"));
  assert.ok(a.log!.includes('> tool read {"path":"a.txt"}'));
  assert.ok(a.log!.includes("> failed: Error: ENOENT"));
  assert.ok(!a.log!.includes("hidden"), "reasoning is skipped");
});

test("continuable subagent: error turn -> error with the error message", () => {
  const home = tmpDir();
  childLog(home, CHILD, [
    rec(1, 1001, "turn/start", { turn: 1 }),
    asst(2, 1002, 1, 1, [{ type: "text", text: "partial" }]),
    rec(3, 1500, "turn/end", { turn: 1, reason: { kind: "error", error: { message: "rate limited" } } }),
  ]);
  const { tr } = tracker(home);
  tr.onEvent(call("C3", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(started("C3"));
  tr.finalize();
  const [a] = tr.list();
  assert.equal(a.status, "error");
  assert.equal(a.summary, "rate limited");
  assert.equal(a.endedAt, 1500);
});

test("continuable subagent: stopped turn (other kind) -> error with the kind", () => {
  const home = tmpDir();
  childLog(home, CHILD, [rec(1, 1001, "turn/start", { turn: 1 }), rec(2, 1500, "turn/end", { turn: 1, reason: { kind: "aborted" } })]);
  const { tr } = tracker(home);
  tr.onEvent(call("C3b", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(started("C3b"));
  tr.finalize();
  assert.equal(tr.list()[0].status, "error");
  assert.equal(tr.list()[0].summary, "aborted");
});

test("continuable subagent: no turn/end -> interrupted, endedAt = now()", () => {
  const home = tmpDir();
  childLog(home, CHILD, [rec(1, 1001, "turn/start", { turn: 1 }), asst(2, 1002, 1, 1, [{ type: "text", text: "working" }])]);
  const { tr, c } = tracker(home);
  tr.onEvent(call("C4", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(started("C4"));
  c.set(7777);
  tr.finalize();
  const [a] = tr.list();
  assert.equal(a.status, "error");
  assert.equal(a.summary, "interrupted: the dsh process exited before the sub-agent finished");
  assert.equal(a.endedAt, 7777);
});

test("continuable subagent: turn/end before the last turn/start does not count", () => {
  const home = tmpDir();
  childLog(home, CHILD, [
    rec(1, 1001, "turn/start", { turn: 1 }),
    rec(2, 1002, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    rec(3, 1003, "turn/start", { turn: 2 }),
  ]);
  const { tr } = tracker(home);
  tr.onEvent(call("C4b", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(started("C4b"));
  tr.finalize();
  assert.equal(tr.list()[0].status, "error");
  assert.match(tr.list()[0].summary!, /^interrupted/);
});

test("continuable subagent: missing log -> error 'not found'", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("C5", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(started("C5", "00000000-0000-0000-0000-000000000000"));
  tr.finalize();
  const [a] = tr.list();
  assert.equal(a.status, "error");
  assert.equal(a.summary, "sub-agent session log not found");
  assert.equal(typeof a.endedAt, "number");
});

test("continuable subagent: running at finalize without a child id -> interrupted before start", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("C6", "subagent", { description: "x", prompt: "p" }));
  tr.finalize();
  assert.equal(tr.list()[0].status, "error");
  assert.equal(tr.list()[0].summary, "interrupted before the sub-agent started");
});

test("continuable subagent: result without 'started subagent' is done with the result as summary", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("C7", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(result("C7", "completed", "all good"));
  assert.equal(tr.list()[0].status, "done");
  assert.equal(tr.list()[0].summary, "all good");
});

test("continuable subagent: error status -> error", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("C8", "subagent", { description: "x", prompt: "p" }));
  tr.onEvent(result("C8", "error", "spawn failed"));
  assert.equal(tr.list()[0].status, "error");
  assert.equal(tr.list()[0].summary, "spawn failed");
});

test("callId is the stable id; list() returns copies", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("ID-1", "subagent_fork", { description: "a", prompt: "p" }));
  tr.onEvent(call("ID-2", "subagent_fork", { description: "b", prompt: "p" }));
  tr.onEvent(result("ID-2", "completed", "r2"));
  const snap = tr.list();
  assert.deepEqual(snap.map((a) => a.id), ["ID-1", "ID-2"]);
  snap[0].status = "done";
  snap[0].role = "mutated";
  assert.equal(tr.list()[0].status, "running");
  assert.equal(tr.list()[0].role, "a");
});

test("role falls back to the tool name and is cut to 120 chars", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("R1", "subagent_fork", { prompt: "p" }));
  tr.onEvent(call("R2", "subagent", { description: "   ", prompt: "p" }));
  tr.onEvent(call("R3", "subagent_fork", { description: "d".repeat(300), prompt: "p" }));
  tr.onEvent(call("R4", "subagent_fork", null));
  const roles = tr.list().map((a) => a.role);
  assert.deepEqual(roles, ["subagent_fork", "subagent", "d".repeat(120), "subagent_fork"]);
});

test("log cap: a 200 KB Japanese child log is capped, valid UTF-8", () => {
  const home = tmpDir();
  const big = "あ".repeat(70000); // 210 KB of UTF-8
  childLog(home, CHILD, [
    rec(1, 1001, "turn/start", { turn: 1 }),
    asst(2, 1002, 1, 1, [{ type: "text", text: big }]),
    rec(3, 1003, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ]);
  const { tr } = tracker(home);
  tr.onEvent(call("L1", "subagent", { description: "big", prompt: "p" }));
  tr.onEvent(started("L1"));
  tr.finalize();
  const log = tr.list()[0].log!;
  const bytes = Buffer.byteLength(log, "utf8");
  assert.ok(bytes <= 64 * 1024 + 20, `bytes=${bytes}`);
  assert.ok(log.endsWith("\n... [truncated]"));
  const body = log.slice(0, -"\n... [truncated]".length);
  assert.ok(/^あ+$/.test(body), "only whole characters");
  assert.equal(Buffer.from(log, "utf8").toString("utf8"), log, "round-trips as valid UTF-8");
  assert.ok(!log.includes("\uFFFD"));
});

test("log cap: fork result over 64 KB is capped too", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("LF", "subagent_fork", { description: "d", prompt: "p" }));
  tr.onEvent(result("LF", "completed", "é".repeat(50000)));
  const log = tr.list()[0].log!;
  assert.ok(Buffer.byteLength(log, "utf8") <= 64 * 1024 + 20);
  assert.ok(log.endsWith("[truncated]"));
});

test("onChange: once per change, not for unrelated events, once on finalize", () => {
  const home = tmpDir();
  childLog(home, CHILD, [rec(1, 1001, "turn/start", { turn: 1 }), rec(2, 1002, "turn/end", { turn: 1, reason: { kind: "completed" } })]);
  const snaps: AgentInfo[][] = [];
  const { tr } = tracker(home, { onChange: (a) => snaps.push(a) });
  tr.onEvent(call("O1", "subagent", { description: "x", prompt: "p" }));
  assert.equal(snaps.length, 1);
  tr.onEvent(started("O1"));
  assert.equal(snaps.length, 2);
  tr.onEvent({ type: "text", text: "hi" } as DshEvent);
  tr.onEvent({ type: "tool_call", callId: "other", tool: "bash", input: {} } as DshEvent);
  assert.equal(snaps.length, 2);
  tr.finalize();
  assert.equal(snaps.length, 3);
  assert.equal(snaps[2][0].status, "done");
  tr.finalize();
  assert.equal(snaps.length, 3, "nothing running: no extra call");
});

test("no subagent tools -> list() is empty", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("N1", "bash", { command: "ls" }));
  tr.onEvent(result("N1", "completed", "x"));
  tr.finalize();
  assert.deepEqual(tr.list(), []);
});

test("unrelated tool names are ignored, results for unknown calls are ignored", () => {
  const { tr } = tracker(tmpDir());
  tr.onEvent(call("U1", "my_subagent", { description: "x", prompt: "p" }));
  tr.onEvent(call("U2", "read", { description: "x" }));
  tr.onEvent(result("U3", "completed", "orphan"));
  assert.deepEqual(tr.list(), []);
});

test("odd events never throw", () => {
  const { tr } = tracker(tmpDir());
  const odd: unknown[] = [null, undefined, 42, "str", [], {}, { type: 7 }, { type: "tool_call" }, { type: "tool_call", callId: 5, tool: "subagent" }, { type: "tool_result", callId: "x", status: {}, result: { a: 1 } }];
  for (const ev of odd) assert.doesNotThrow(() => tr.onEvent(ev as DshEvent));
  assert.doesNotThrow(() => tr.finalize());
  assert.deepEqual(tr.list(), []);
});
