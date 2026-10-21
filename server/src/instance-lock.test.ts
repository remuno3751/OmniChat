import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { otherServer, parseLock, writeLock, removeLock, lockPath } from "./instance-lock.js";

const dir = () => mkdtempSync(join(tmpdir(), "oc-lock-"));

test("parseLock accepts 'pid port' only", () => {
  assert.deepEqual(parseLock("123 8787\n"), { pid: 123, port: 8787 });
  assert.equal(parseLock(""), null);
  assert.equal(parseLock("abc"), null);
  assert.equal(parseLock("1 99999"), null);
});

test("a free directory, our own pid and a dead pid never block", async () => {
  const d = dir();
  assert.equal(await otherServer(d), null);
  writeLock(d, 8787);
  assert.equal(await otherServer(d), null, "own pid");
  writeFileSync(lockPath(d), "2147483646 8787\n");
  assert.equal(await otherServer(d, process.pid, async () => true), null, "dead pid");
});

test("a live pid whose port answers blocks; a silent port does not", async () => {
  const d = dir();
  writeFileSync(lockPath(d), `${process.ppid} 8787\n`); // the parent (test runner) is alive and is not us
  const old = new Date(Date.now() - 120_000);
  utimesSync(lockPath(d), old, old);
  assert.deepEqual(await otherServer(d, process.pid, async () => true), { pid: process.ppid, port: 8787 });
  assert.equal(await otherServer(d, process.pid, async () => false), null);
});

test("a fresh lock of a live pid blocks even before its port answers (still booting)", async () => {
  const d = dir();
  writeFileSync(lockPath(d), `${process.ppid} 8787\n`);
  assert.deepEqual(await otherServer(d, process.pid, async () => false), { pid: process.ppid, port: 8787 });
});

test("removeLock only removes our own lock", () => {
  const d = dir();
  writeFileSync(lockPath(d), "42 8787\n");
  removeLock(d, 7);
  assert.ok(existsSync(lockPath(d)));
  removeLock(d, 42);
  assert.ok(!existsSync(lockPath(d)));
});
