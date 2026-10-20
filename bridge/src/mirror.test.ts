import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { Mirror, decodeFrames, findSessionLog } from "./mirror.js";
import { appendFrame, asst, header, rec, sessionFile, tmpDir, userMsg } from "./testutil.js";

const CWD = path.resolve(tmpDir(), "ws");

function mk(home: string, extra: Record<string, unknown> = {}) {
  const warns: string[] = [];
  const m = new Mirror({ dshHome: home, cwd: CWD, warn: (w) => warns.push(w), ...extra });
  return { m, warns };
}

test("extraction: keys, statuses, tool markdown, system messages ignored, title", () => {
  const home = tmpDir();
  const f = sessionFile(home, "--slug--", "session-a");
  appendFrame(f, [
    header("session-a", CWD),
    rec(0, 1001, "agent/inbox/spliced", { inserted: [{ source: { kind: "user" } }] }),
    rec(1, 1002, "turn/start", { turn: 1 }),
    userMsg(2, 1003, "hello"),
    userMsg(3, 1004, "<system-reminder>skills</system-reminder>", "system"),
    rec(4, 1005, "session/title", { title: "first" }),
  ]);
  const { m } = mk(home);
  let full = m.full()!;
  assert.equal(full.full, true);
  assert.equal(full.sessions.length, 1);
  assert.deepEqual(full.sessions[0].messages.map((x) => [x.key, x.role, x.text, x.status]), [["u:1:0", "user", "hello", "done"]]);
  assert.equal(full.sessions[0].title, "first");
  assert.equal(full.sessions[0].cwd, CWD);
  assert.equal(m.poll(), null); // unchanged

  // multi-step turn, still streaming
  appendFrame(f, [
    rec(5, 1100, "step/start", { turn: 1, step: 1 }),
    asst(6, 1101, 1, 1, [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Looking. " }, { type: "tool-call", id: "c1", name: "glob" }]),
    rec(7, 1102, "tool/call", { turn: 1, step: 1, callId: "c1", name: "glob", arguments: '{"pattern": "*", "path": "."}' }),
    rec(8, 1103, "tool/result", { turn: 1, step: 1, message: { content: [{ type: "text", text: "a.txt" }], toolCallId: "c1" } }),
  ]);
  let d = m.poll()!;
  assert.equal(d.full, false);
  assert.equal(d.sessions[0].messages.length, 1, "only the changed message");
  const a = d.sessions[0].messages[0];
  assert.equal(a.key, "a:1");
  assert.equal(a.status, "streaming");
  assert.equal(a.createdAt, 1101);
  assert.equal(a.text, 'Looking. \n\n> 🔧 glob {"pattern":"*","path":"."}\n\n');

  appendFrame(f, [
    rec(9, 1200, "tool/call", { turn: 1, step: 2, callId: "c2", name: "read", arguments: "{}" }),
    rec(10, 1201, "tool/result", { turn: 1, step: 2, message: { content: [{ type: "text", text: "Error: ENOENT no such file" }], toolCallId: "c2" } }),
    asst(11, 1202, 1, 2, [{ type: "text", text: "Done." }]),
    rec(12, 1203, "turn/end", { turn: 1, reason: { kind: "completed" } }),
  ]);
  d = m.poll()!;
  const a2 = d.sessions[0].messages.find((x) => x.key === "a:1")!;
  assert.equal(a2.status, "done");
  assert.ok(a2.text.endsWith("\n\n> 🔧 read {}\n\n> ⚠️ read failed: Error: ENOENT no such file\n\nDone."));
  assert.equal(a2.createdAt, 1101);

  // second turn with two human messages, error ending; title change
  appendFrame(f, [
    rec(13, 1300, "turn/start", { turn: 2 }),
    userMsg(14, 1301, "again"),
    userMsg(15, 1302, "and also"),
    asst(16, 1303, 2, 1, [{ type: "text", text: "oops" }]),
    rec(17, 1304, "turn/end", { turn: 2, reason: { kind: "error", error: { message: "boom" } } }),
    rec(18, 1305, "session/title", { title: "second" }),
  ]);
  d = m.poll()!;
  assert.equal(d.sessions[0].title, "second");
  const keys = d.sessions[0].messages.map((x) => [x.key, x.status]);
  assert.deepEqual(keys, [["u:2:0", "done"], ["u:2:1", "done"], ["a:2", "error"]]);

  // reconnect -> full again, all messages in order
  full = m.full()!;
  assert.deepEqual(full.sessions[0].messages.map((x) => x.key), ["u:1:0", "a:1", "u:2:0", "u:2:1", "a:2"]);
  assert.equal(m.poll(), null);
});

test("partial trailing frame is retried; offset only advances over whole frames", () => {
  const home = tmpDir();
  const f = sessionFile(home, "s", "session-p");
  appendFrame(f, [header("session-p", CWD), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, "q")]);
  const { m, warns } = mk(home);
  assert.equal(m.full()!.sessions[0].messages.length, 1);

  const frame = zlib.zstdCompressSync(Buffer.from(JSON.stringify(asst(3, 3, 1, 1, [{ type: "text", text: "partial answer" }])) + "\n"));
  fs.appendFileSync(f, frame.subarray(0, frame.length - 5)); // truncated frame
  assert.equal(m.poll(), null);
  assert.equal(m.disabled, false);
  fs.appendFileSync(f, frame.subarray(frame.length - 5));
  const d = m.poll()!;
  assert.equal(d.sessions[0].messages[0].text, "partial answer");
  assert.equal(warns.length, 0);
});

test("decodeFrames: multi-frame split, partial tail untouched", () => {
  const a = zlib.zstdCompressSync(Buffer.from("one\n"));
  const b = zlib.zstdCompressSync(Buffer.from("two\n"));
  const buf = Buffer.concat([a, b, b.subarray(0, 6)]);
  const r = decodeFrames(buf);
  assert.equal(r.text, "one\ntwo\n");
  assert.equal(r.consumed, a.length + b.length);
});

test("cwd filter, --mirror-all, sessions without human message, cap and 30 newest", () => {
  const home = tmpDir();
  const other = path.resolve(tmpDir(), "other");
  appendFrame(sessionFile(home, "x", "session-mine"), [header("session-mine", CWD), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, "mine")]);
  appendFrame(sessionFile(home, "y", "session-other"), [header("session-other", other), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, "theirs")]);
  appendFrame(sessionFile(home, "x", "session-empty"), [header("session-empty", CWD)]);
  assert.deepEqual(mk(home).m.full()!.sessions.map((s) => s.sessionId), ["session-mine"]);
  assert.deepEqual(mk(home, { mirrorAll: true }).m.full()!.sessions.map((s) => s.sessionId).sort(), ["session-mine", "session-other"]);

  const home2 = tmpDir();
  for (let i = 0; i < 35; i++) {
    const f = sessionFile(home2, "x", `session-n${i}`);
    appendFrame(f, [header(`session-n${i}`, CWD), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, `m${i}`)]);
    const t = new Date(Date.now() - (100 - i) * 1000);
    fs.utimesSync(f, t, t);
  }
  const full = mk(home2).m.full()!;
  assert.equal(full.sessions.length, 30);
  assert.ok(full.sessions.every((s) => Number(s.sessionId.slice(9)) >= 5), "the 30 newest by mtime");

  const home3 = tmpDir();
  const f3 = sessionFile(home3, "x", "session-big");
  const recs: unknown[] = [header("session-big", CWD)];
  for (let i = 1; i <= 310; i++) recs.push(rec(i * 2, i, "turn/start", { turn: i }), userMsg(i * 2 + 1, i, `msg ${i}`));
  appendFrame(f3, recs);
  const big = mk(home3).m.full()!.sessions[0].messages;
  assert.equal(big.length, 300);
  assert.equal(big[299].text, "msg 310");
});

test("new session files are picked up; unknown format disables mirroring with ONE warning", () => {
  const home = tmpDir();
  const { m, warns } = mk(home);
  assert.deepEqual(m.full()!.sessions, []);
  appendFrame(sessionFile(home, "x", "session-new"), [header("session-new", CWD), rec(1, 1, "turn/start", { turn: 1 }), userMsg(2, 2, "hi")]);
  assert.equal(m.poll()!.sessions[0].sessionId, "session-new");

  fs.mkdirSync(path.dirname(sessionFile(home, "x", "session-bad")), { recursive: true });
  fs.writeFileSync(sessionFile(home, "x", "session-bad"), "this is not zstd at all");
  assert.equal(m.poll(), null);
  assert.equal(m.disabled, true);
  assert.equal(m.poll(), null);
  assert.equal(m.full(), null);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /mirroring disabled/);
});

test("findSessionLog", () => {
  const home = tmpDir();
  const f = sessionFile(home, "--a--", "session-z");
  appendFrame(f, [header("session-z", CWD)]);
  assert.equal(findSessionLog(home, "session-z"), f);
  assert.equal(findSessionLog(home, "session-none"), null);
  assert.equal(findSessionLog(home, "../x"), null);
});
