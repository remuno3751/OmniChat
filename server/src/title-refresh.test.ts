import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, connect, newConv, say, sleep, randomUUID, type Ctx, type Client } from "./test-chat-util.js";
import { startLlm, type Llm } from "./test-tools-util.js";

let c: Ctx;
let cl: Client;
let llm: Llm;
let provId: string;

const call = (method: string, path: string, body?: unknown, tok?: string) => c.call(method, path, body, tok);
const convRow = async (id: string) => ((await call("GET", "/sync?since=0")).json.conversations as any[]).find((x) => x.id === id);
const convWith = (body: Record<string, unknown> = {}) => newConv(c, { providerId: provId, model: "llm-1", ...body });
const FIRST_SYSTEM = "Write a title of 3-6 words for this conversation. Reply with the title only.";
const REFRESH_SYSTEM = "会話全体の内容を反映した、3〜6語の題名を付ける。ユーザーが使っている言語で。現在の題名が内容に合っているなら、そのまま返す。題名だけを返す";

async function waitTitle(id: string, title: string) {
  for (let i = 0; i < 100; i++) {
    if ((await convRow(id))?.title === title) return;
    await sleep(50);
  }
  assert.equal((await convRow(id))?.title, title, `title did not become "${title}"`);
}

/** conversation upserts that arrived after the last frame carrying this assistant message */
function convUpsertsAfterReply(asstId: string, cid: string) {
  const idx = cl.frames.findLastIndex((f: any) => (f.messages ?? []).some((m: any) => m.id === asstId));
  return cl.frames.slice(idx + 1).filter((f: any) => f.type === "upsert" && (f.conversations ?? []).some((x: any) => x.id === cid)).length;
}

before(async () => {
  c = await setup({ AUTO_TITLE_DEFAULT: "0", OMNICHAT_SEARCH_STATUS_TTL_MS: "0" });
  llm = await startLlm();
  provId = randomUUID();
  await call("PUT", `/providers/${provId}`, { name: "LLM", kind: "openai-compatible", baseUrl: llm.base, model: "llm-1" });
  cl = await connect(c);
});

after(() => { cl?.ws.close(); c?.stop(); llm?.close(); });

test("auto title: n=1 writes the first title; titleEvery defaults to 6", async () => {
  assert.equal((await call("GET", "/settings")).json.titleEvery, 6);
  await call("PUT", "/settings", { autoTitle: true });
  llm.titleReply = "First Title";
  const cv = await convWith({});
  await say(c, cl, cv, "How do I make cats happy?");
  await waitTitle(cv, "First Title");
  assert.equal(llm.titleBodies.at(-1).messages[0].content, FIRST_SYSTEM);
});

test("auto title refresh: titleEvery=2 refreshes at n=2 with the current title and branch in the prompt", async () => {
  await call("PUT", "/settings", { autoTitle: true, titleEvery: 2 });
  llm.titleReply = "Cat Happiness";
  const cv = await convWith({});
  await say(c, cl, cv, "How do I make cats happy?");
  await waitTitle(cv, "Cat Happiness");
  const before = llm.titleBodies.length;
  llm.titleReply = "Cat Care Routines";
  await say(c, cl, cv, "And what about feeding?");
  await waitTitle(cv, "Cat Care Routines");
  assert.equal(llm.titleBodies.length - before, 1);
  const tb = llm.titleBodies.at(-1);
  assert.equal(tb.messages[0].content, REFRESH_SYSTEM);
  assert.match(tb.messages[1].content, /Current title: Cat Happiness/);
  assert.match(tb.messages[1].content, /First user message:\nHow do I make cats happy\?/);
  assert.match(tb.messages[1].content, /User: And what about feeding\?/);
});

test("auto title: a manual rename is never overwritten by a refresh", async () => {
  await call("PUT", "/settings", { autoTitle: true, titleEvery: 2 });
  llm.titleReply = "Auto Name";
  const cv = await convWith({});
  await say(c, cl, cv, "first question");
  await waitTitle(cv, "Auto Name");
  await call("PUT", `/conversations/${cv}`, { title: "My own name" });
  const n = llm.titleBodies.length;
  llm.titleReply = "Should not apply";
  await say(c, cl, cv, "second question");
  await sleep(300);
  assert.equal(llm.titleBodies.length, n, "no title request for a renamed chat");
  assert.equal((await convRow(cv)).title, "My own name");
});

test("auto title: titleEvery=0 keeps only the first title", async () => {
  await call("PUT", "/settings", { autoTitle: true, titleEvery: 0 });
  llm.titleReply = "Only Once";
  const cv = await convWith({});
  await say(c, cl, cv, "q1");
  await waitTitle(cv, "Only Once");
  const n = llm.titleBodies.length;
  llm.titleReply = "Changed";
  await say(c, cl, cv, "q2");
  await say(c, cl, cv, "q3");
  await sleep(300);
  assert.equal(llm.titleBodies.length, n);
  assert.equal((await convRow(cv)).title, "Only Once");
});

test("auto title refresh: an unchanged title does not write the conversation row", async () => {
  // baseline: with titleEvery=0 no refresh runs, so the second reply's row writes are the reply's own
  await call("PUT", "/settings", { autoTitle: true, titleEvery: 0 });
  llm.titleReply = "Baseline Title";
  const base = await convWith({});
  await say(c, cl, base, "baseline q1");
  await waitTitle(base, "Baseline Title");
  const b2 = await say(c, cl, base, "baseline q2");
  await sleep(300);
  const baseline = convUpsertsAfterReply(b2.assistantMessageId, base);

  // titleEvery=2: the refresh at n=2 returns the same title and must leave the row alone
  await call("PUT", "/settings", { autoTitle: true, titleEvery: 2 });
  llm.titleReply = "Steady Title";
  const cv = await convWith({});
  await say(c, cl, cv, "steady question");
  await waitTitle(cv, "Steady Title");
  const before = llm.titleBodies.length;
  const t2 = await say(c, cl, cv, "steady follow-up");
  await sleep(400);
  assert.equal(llm.titleBodies.length - before, 1, "refresh was requested");
  assert.equal(convUpsertsAfterReply(t2.assistantMessageId, cv), baseline, "same title: no extra conversation write");
  assert.equal((await convRow(cv)).title, "Steady Title");
});

test("titleEvery: integer 0..50 only, anything else is a 400", async () => {
  for (const v of [51, -1, 1.5, "3", null]) {
    assert.equal((await call("PUT", "/settings", { titleEvery: v })).status, 400, String(v));
  }
  for (const v of [0, 50]) assert.equal((await call("PUT", "/settings", { titleEvery: v })).status, 200, String(v));
  assert.equal((await call("GET", "/settings")).json.titleEvery, 50);
  await call("PUT", "/settings", { titleEvery: 6 });
});
