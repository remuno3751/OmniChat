import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, connect, newConv, say, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { composeSystemPrompt } from "./prompts.js";
import { mergeParams, toBodyParams, sanitizeParams } from "./sampling.js";

let c: Ctx;
let cl: Client;
before(async () => { c = await setup(); cl = await connect(c); });
after(() => { cl?.ws.close(); c?.stop(); });

const lastBody = () => c.be.bodies[c.be.bodies.length - 1];

test("composeSystemPrompt unit matrix", () => {
  assert.equal(composeSystemPrompt(null), null);
  assert.equal(composeSystemPrompt("  ", { text: " ", mode: "replace" }), null);
  assert.equal(composeSystemPrompt("G", { text: "P" }, { text: "C" }), "G\n\nP\n\nC");
  assert.equal(composeSystemPrompt("G", { text: "P", mode: "replace" }, { text: "C" }), "P\n\nC");
  assert.equal(composeSystemPrompt("G", { text: "P" }, { text: "C", mode: "replace" }), "C");
  assert.equal(composeSystemPrompt("G", { text: "P", mode: "replace" }, { text: "C", mode: "replace" }), "C");
  assert.equal(composeSystemPrompt(null, { text: "P" }, { text: "C" }), "P\n\nC");
  assert.equal(composeSystemPrompt("G", { text: "", mode: "replace" }, { text: "C" }), "G\n\nC", "empty replace piece is skipped");
  assert.equal(composeSystemPrompt("G", { text: "P", mode: "replace" }, { text: " " }), "P");
});

test("sampling helpers", () => {
  assert.deepEqual(mergeParams({ temperature: 1, topK: null }, { temperature: 2, topK: 5 }, null, { seed: 1 }), { temperature: 1, topK: 5, seed: 1 });
  assert.deepEqual(toBodyParams({ topP: 0.5, minP: 0.1, repeatPenalty: 1.1, maxTokens: 9, stop: ["a"], seed: null }),
    { top_p: 0.5, min_p: 0.1, repeat_penalty: 1.1, max_tokens: 9, stop: ["a"] });
  assert.equal(sanitizeParams({ temperature: "hot" }), null);
});

test("system prompt hierarchy end-to-end (append/replace matrix)", async () => {
  const pid = randomUUID();
  const cases: Array<{ g: string | null; p: string | null; pm: string; cp: string | null; cm: string; want: string | null }> = [
    { g: null, p: null, pm: "append", cp: null, cm: "append", want: null },
    { g: "G", p: null, pm: "append", cp: null, cm: "append", want: "G" },
    { g: "G", p: "P", pm: "append", cp: "C", cm: "append", want: "G\n\nP\n\nC" },
    { g: "G", p: "P", pm: "replace", cp: "C", cm: "append", want: "P\n\nC" },
    { g: "G", p: "P", pm: "append", cp: "C", cm: "replace", want: "C" },
    { g: "G", p: "P", pm: "replace", cp: null, cm: "append", want: "P" },
    { g: null, p: "P", pm: "append", cp: "  ", cm: "replace", want: "P" },
  ];
  await c.call("PUT", `/projects/${pid}`, { name: "H" });
  for (const k of cases) {
    await c.call("PUT", "/settings", { systemPrompt: k.g });
    await c.call("PUT", `/projects/${pid}`, { systemPrompt: k.p, systemMode: k.pm });
    const conv = await newConv(c, { projectId: pid, systemPrompt: k.cp, systemMode: k.cm });
    await say(c, cl, conv, "hello");
    const msgs = lastBody().messages;
    if (k.want === null) {
      assert.deepEqual(msgs.map((m: any) => m.role), ["user"], JSON.stringify(k));
    } else {
      assert.deepEqual(msgs[0], { role: "system", content: k.want }, JSON.stringify(k));
      assert.equal(msgs.length, 2);
    }
  }
  await c.call("PUT", "/settings", { systemPrompt: null });
});

test("deleted project no longer contributes", async () => {
  const pid = randomUUID();
  await c.call("PUT", `/projects/${pid}`, { systemPrompt: "PROJ", params: { seed: 99 } });
  const conv = await newConv(c, { projectId: pid });
  await say(c, cl, conv, "one");
  assert.equal(lastBody().messages[0].content, "PROJ");
  assert.equal(lastBody().seed, 99);
  await c.call("DELETE", `/projects/${pid}`);
  await say(c, cl, conv, "two");
  assert.equal(lastBody().messages[0].role, "user");
  assert.equal(lastBody().seed, undefined);
});

test("sampling params merge: one-shot > conversation > project > global", async () => {
  const pid = randomUUID();
  await c.call("PUT", "/settings", { params: { temperature: 0.1, topK: 5, maxTokens: 100, repeatPenalty: 1.3 } });
  await c.call("PUT", `/projects/${pid}`, { params: { temperature: 0.2, minP: 0.3, maxTokens: 200 } });
  const conv = await newConv(c, { projectId: pid, params: { temperature: 0.3, seed: 7, stop: ["END"] } });
  await say(c, cl, conv, "a");
  assert.deepEqual(
    { t: lastBody().temperature, k: lastBody().top_k, m: lastBody().min_p, mt: lastBody().max_tokens, rp: lastBody().repeat_penalty, s: lastBody().seed, st: lastBody().stop },
    { t: 0.3, k: 5, m: 0.3, mt: 200, rp: 1.3, s: 7, st: ["END"] },
  );
  await say(c, cl, conv, "b", { params: { temperature: 0.9, maxTokens: 5, topP: 0.5 } });
  assert.equal(lastBody().temperature, 0.9);
  assert.equal(lastBody().max_tokens, 5);
  assert.equal(lastBody().top_p, 0.5);
  assert.equal(lastBody().seed, 7);
  assert.equal(lastBody().top_k, 5);
  // nothing configured -> no sampling fields at all
  await c.call("PUT", "/settings", { params: null });
  const plain = await newConv(c);
  await say(c, cl, plain, "c");
  for (const k of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "seed", "stop", "max_tokens", "reasoning_effort"]) {
    assert.equal(lastBody()[k], undefined, k);
  }
});

test("history only has done/stopped non-empty messages on the path", async () => {
  const conv = await newConv(c);
  await say(c, cl, conv, "first");
  await say(c, cl, conv, "second");
  assert.deepEqual(lastBody().messages.map((m: any) => m.content), ["first", "R:first-end", "second"]);
});
