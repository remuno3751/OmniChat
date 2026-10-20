import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { NdjsonParser, buildCommand, runDsh, type DshEvent } from "./dsh.js";

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-dsh.mjs");
const base = { appDir: "X:\\app", profile: "headless", cwd: os.tmpdir(), command: process.execPath, commandArgs: [fake] };

test("parser handles partial lines, CRLF, junk and multibyte splits", () => {
  const p = new NdjsonParser();
  const bytes = Buffer.from('{"type":"text","text":"日本語"}\r\nnoise\n{"type":"a"}\n{"type":"b"', "utf8");
  const cut = bytes.indexOf(Buffer.from("本")) + 1; // split inside a multibyte char
  const out = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut))];
  assert.deepEqual(out.map((e) => e.type), ["text", "a"]);
  assert.equal(out[0].text, "日本語");
  assert.deepEqual(p.push(Buffer.from("}\n")).map((e) => e.type), ["b"]);
  assert.deepEqual(p.push("[1,2]\n123\n"), []);
  assert.deepEqual(p.push('{"type":"tail"}'), []);
  assert.deepEqual(p.end().map((e) => e.type), ["tail"]);
});

test("buildCommand default and options", () => {
  const c = buildCommand({ appDir: "C:\\a", profile: "headless", patch: "o.yml", sessionId: "s1", cwd: ".", prompt: "" });
  assert.ok(c.command.endsWith("DeepSeek Harness.exe"));
  assert.equal(c.args[0], "--expose-internals");
  assert.ok(c.args[1].endsWith("cli.js"));
  assert.deepEqual(c.args.slice(2), ["--profile", "headless", "--patch", "o.yml", "--json", "--session-id", "s1", "-"]);
});

async function collect(run: ReturnType<typeof runDsh>): Promise<DshEvent[]> {
  const evs: DshEvent[] = [];
  for await (const e of run) evs.push(e);
  return evs;
}

test("fake dsh: success, session id passthrough, junk lines ignored", async () => {
  const run = runDsh({ ...base, prompt: "hello BADLINES 日本", sessionId: "session-xyz" });
  const evs = await collect(run);
  const res = await run.done;
  assert.equal(res.code, 0);
  assert.equal(evs[0].sessionId, "session-xyz");
  assert.ok(evs.some((e) => e.type === "text" && e.text === "echo:hello BADLINES 日本"));
  assert.ok(evs.every((e) => typeof e.type === "string"));
});

test("fake dsh: failure exposes stderr tail and exit code", async () => {
  const run = runDsh({ ...base, prompt: "FAIL" });
  await collect(run);
  const res = await run.done;
  assert.equal(res.code, 1);
  assert.match(res.stderrTail, /boom/);
});

test("fake dsh: cancel kills the process", async () => {
  const run = runDsh({ ...base, prompt: "SLOW" });
  for await (const e of run) {
    if (e.type === "text") run.cancel();
  }
  const res = await run.done;
  assert.equal(res.cancelled, true);
  assert.notEqual(res.code, 0);
});

test("spawn failure yields done with code -1", async () => {
  const run = runDsh({ ...base, command: path.join(os.tmpdir(), "no-such-binary-xyz"), prompt: "x" });
  await collect(run);
  const res = await run.done;
  assert.equal(res.code, -1);
  assert.ok(res.stderrTail.length > 0);
});
