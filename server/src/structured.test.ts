import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, api, sleep, type TestServer } from "./test-server.js";
import { startFake, type Fake } from "./test-fake.js";
import { connect, newConv, randomUUID, type Client } from "./test-chat-util.js";
import {
  sanitizeResponseFormat, resolveResponseFormat, toWireResponseFormat, sanitizeExtraBody, paramsProblem,
  validateAgainstSchema, checkJson, applyExtraBody, MAX_EXTRA_BODY_BYTES,
} from "./structured.js";
import { sanitizeParams, mergeParams, toBodyParams } from "./sampling.js";

/* ---------------- pure helpers ---------------- */

test("sanitizeResponseFormat: forms, names and rejects", () => {
  assert.deepEqual(sanitizeResponseFormat(null), null);
  assert.deepEqual(sanitizeResponseFormat({ type: "json_object" }), { type: "json_object" });
  const s = sanitizeResponseFormat({ type: "json_schema", name: "  Person ", schema: { type: "object" }, extra: 1 });
  assert.deepEqual(s, { type: "json_schema", name: "Person", schema: { type: "object" } });
  assert.equal(sanitizeResponseFormat({ type: "json_schema" }), undefined, "schema is required");
  assert.equal(sanitizeResponseFormat({ type: "text" }), undefined);
  assert.equal(sanitizeResponseFormat("json_object"), undefined);
  const big = { type: "json_schema", schema: { description: "x".repeat(70_000) } };
  assert.equal(sanitizeResponseFormat(big), undefined, "schemas above 64 KB are refused");
});

test("resolveResponseFormat: one-shot > conversation > none", () => {
  const conv = { type: "json_object" } as const;
  assert.deepEqual(resolveResponseFormat({ type: "json_schema", schema: {} }, conv), { type: "json_schema", schema: {} });
  assert.deepEqual(resolveResponseFormat(undefined, conv), { type: "json_object" });
  assert.deepEqual(resolveResponseFormat(null, conv), { type: "json_object" });
  assert.equal(resolveResponseFormat(undefined, null), null);
});

test("toWireResponseFormat: OpenAI shapes", () => {
  assert.deepEqual(toWireResponseFormat({ type: "json_object" }), { type: "json_object" });
  assert.deepEqual(toWireResponseFormat({ type: "json_schema", name: "a b/c", schema: { type: "object" } }), {
    type: "json_schema", json_schema: { name: "a_b_c", schema: { type: "object" }, strict: true },
  });
  assert.equal((toWireResponseFormat({ type: "json_schema", schema: {} }) as any).json_schema.name, "response");
});

test("extraBody: forbidden keys dropped, size capped, applied last", () => {
  const e = sanitizeExtraBody({ model: "x", messages: [], stream: true, tools: [], stream_options: {}, response_format: {}, __proto__: 1, custom: { a: 1 } });
  assert.deepEqual(e, { custom: { a: 1 } });
  assert.equal(sanitizeExtraBody({ model: "only-forbidden" }), null);
  assert.equal(sanitizeExtraBody([1]), null);
  assert.equal(sanitizeExtraBody({ big: "x".repeat(MAX_EXTRA_BODY_BYTES + 10) }), null);
  const body: Record<string, unknown> = { model: "m", stream: true };
  applyExtraBody(body, { model: "evil", stream: false, top_k: 3, custom: true });
  assert.deepEqual(body, { model: "m", stream: true, top_k: 3, custom: true });
  assert.match(paramsProblem({ extraBody: "nope" }) ?? "", /extraBody/);
  assert.match(paramsProblem({ logprobs: 21 }) ?? "", /logprobs/);
  assert.equal(paramsProblem({ logprobs: 20, grammar: "root ::= \"a\"" }), null);
});

test("sanitizeParams keeps logprobs/grammar/extraBody and mergeParams merges extraBody per key", () => {
  const p = sanitizeParams({ logprobs: 5, grammar: "root ::= x", extraBody: { a: 1 }, temperature: 0.2 });
  assert.deepEqual(p, { logprobs: 5, grammar: "root ::= x", extraBody: { a: 1 }, temperature: 0.2 });
  assert.equal(sanitizeParams({ logprobs: 99 }), null);
  const m = mergeParams({ extraBody: { a: 1, b: 1 } }, { extraBody: { b: 2, c: 3 } }, { temperature: 0.1 });
  assert.deepEqual(m.extraBody, { a: 1, b: 1, c: 3 }, "higher layers win per key");
  assert.deepEqual(toBodyParams({ logprobs: 4, grammar: "g", extraBody: { z: 1 } }), { logprobs: true, top_logprobs: 4, grammar: "g" });
});

test("validateAgainstSchema and checkJson", () => {
  const schema = {
    type: "object", required: ["name", "age"], properties: {
      name: { type: "string", minLength: 1 }, age: { type: "integer", minimum: 0 }, tags: { type: "array", items: { type: "string" } },
      kind: { enum: ["a", "b"] },
    },
  };
  assert.equal(validateAgainstSchema({ name: "x", age: 3 }, schema), null);
  assert.match(validateAgainstSchema({ name: "x" }, schema) ?? "", /required property "age"/);
  assert.match(validateAgainstSchema({ name: "x", age: 1.5 }, schema) ?? "", /expected integer/);
  assert.match(validateAgainstSchema({ name: "x", age: -1 }, schema) ?? "", /minimum/);
  assert.match(validateAgainstSchema({ name: "x", age: 1, tags: [1] }, schema) ?? "", /expected string/);
  assert.match(validateAgainstSchema({ name: "x", age: 1, kind: "c" }, schema) ?? "", /enum/);
  assert.match(validateAgainstSchema([1], schema) ?? "", /expected object/);

  const rf = { type: "json_schema" as const, schema };
  assert.deepEqual(checkJson('{"name":"a","age":2}', rf), { valid: true });
  assert.equal(checkJson('{"name":"a"', rf).valid, false);
  assert.match(checkJson('{"name":"a"', rf).error ?? "", /invalid JSON/);
  assert.equal(checkJson("[1]", { type: "json_object" }).valid, false);
  assert.equal(checkJson('{"x":1}', { type: "json_object" }).valid, true);
});

/* ---------------- integration: chat with response format, logprobs, extraBody ---------------- */

let s: TestServer;
let fake: Fake;
let token: string;
let provId: string;
let cl: Client;

before(async () => {
  s = await startServer({ ALLOW_REGISTRATION: "1" });
  fake = await startFake({ echo: false, text: ['{"name":"Ada","age":36}'] });
  token = (await api(s.base, "POST", "/auth/register", { username: "structured", password: "password123" })).json.token;
  provId = randomUUID();
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: fake.base, model: "fake-model" }, token);
  cl = await connect({ s, token } as any, token);
});
after(() => { cl?.ws.close(); fake?.close(); s?.stop(); });

const ctx = () => ({ s, token, provId, be: null as any, call: (m: string, p: string, b?: unknown) => api(s.base, m, p, b, token), stop() {} }) as any;
const conv = (body: Record<string, unknown> = {}) => newConv(ctx(), { ...body });
const lastBody = () => fake.bodies[fake.bodies.length - 1];

async function reply(conversationId: string, extra: Record<string, unknown> = {}) {
  const userMessageId = randomUUID(), assistantMessageId = randomUUID();
  cl.send({ type: "send", conversationId, content: "who?", userMessageId, assistantMessageId, ...extra });
  const m = await cl.waitMsg(assistantMessageId);
  return { assistantMessageId, m };
}

test("conversation responseFormat is sent and the reply is validated", async () => {
  await api(s.base, "PUT", `/providers/${provId}`, { name: "Fake", kind: "openai-compatible", baseUrl: fake.base, model: "fake-model" }, token);
  const c = await conv({ responseFormat: { type: "json_schema", name: "person", schema: { type: "object", required: ["name", "age"] } } });
  const r = await reply(c);
  assert.deepEqual(lastBody().response_format, {
    type: "json_schema", json_schema: { name: "person", schema: { type: "object", required: ["name", "age"] }, strict: true },
  });
  const got = await cl.waitMsg(r.assistantMessageId, (m) => !!m.metrics);
  assert.equal(got.status, "done");
  assert.equal(got.metrics?.jsonValid, true);
  assert.equal(got.metrics?.jsonError, undefined);
});

test("one-shot responseFormat wins over the conversation and invalid JSON is recorded", async () => {
  const c = await conv({ responseFormat: { type: "json_object" } });
  fake.cfg.text = ["Sure! here is it"];
  const r = await reply(c, { responseFormat: { type: "json_schema", schema: { type: "array" } } });
  assert.equal(lastBody().response_format.type, "json_schema", "one-shot used");
  const m = await cl.waitMsg(r.assistantMessageId, (x) => !!x.metrics);
  assert.equal(m.metrics?.jsonValid, false);
  assert.match(m.metrics?.jsonError ?? "", /invalid JSON/);
  fake.cfg.text = ['{"name":"Ada","age":36}'];
  const r2 = await reply(c);
  assert.deepEqual(lastBody().response_format, { type: "json_object" }, "conversation used when there is no one-shot");
  assert.equal((await cl.waitMsg(r2.assistantMessageId, (x) => !!x.metrics)).metrics?.jsonValid, true);
  fake.cfg.text = ['{"name":"Ada","age":36}'];
});

test("schema mismatch is recorded as invalid", async () => {
  const c = await conv();
  fake.cfg.text = ['{"name":"Ada"}'];
  const r = await reply(c, { responseFormat: { type: "json_schema", schema: { type: "object", required: ["name", "age"] } } });
  const m = await cl.waitMsg(r.assistantMessageId, (x) => !!x.metrics);
  assert.equal(m.metrics?.jsonValid, false);
  assert.match(m.metrics?.jsonError ?? "", /age/);
  fake.cfg.text = ['{"name":"Ada","age":36}'];
});

test("invalid responseFormat on send is refused with an error frame and nothing is stored", async () => {
  const c = await conv();
  const id = randomUUID();
  const before = fake.bodies.length;
  cl.send({ type: "send", conversationId: c, content: "x", userMessageId: randomUUID(), assistantMessageId: id, responseFormat: { type: "xml" } });
  await cl.waitFrame((f) => f.type === "error" && /responseFormat/.test(f.message));
  await sleep(50);
  assert.equal(fake.bodies.length, before, "no backend request");
  assert.equal(cl.msg(id), undefined);
});

test("PUT conversation validates responseFormat", async () => {
  const c = await conv();
  const bad = await api(s.base, "PUT", `/conversations/${c}`, { responseFormat: { type: "json_schema" } }, token);
  assert.equal(bad.status, 400);
  const ok = await api(s.base, "PUT", `/conversations/${c}`, { responseFormat: null }, token);
  assert.equal(ok.status, 200);
});

test("logprobs are requested, stored in the debug record and not in the message", async () => {
  fake.cfg.logprobs = [{ token: "{", logprob: -0.1, top_logprobs: [] }, { token: "x", logprob: -2, top_logprobs: [] }];
  await api(s.base, "PUT", "/settings", { params: { logprobs: 2 } }, token);
  const c = await conv();
  const r = await reply(c);
  assert.equal(lastBody().logprobs, true);
  assert.equal(lastBody().top_logprobs, 2);
  await cl.waitMsg(r.assistantMessageId, (x) => !!x.metrics);
  const d = (await api(s.base, "GET", `/messages/${r.assistantMessageId}/debug`, undefined, token)).json;
  assert.equal(d.response.logprobs.content.length, 2);
  assert.equal(d.response.logprobs.content[1].logprob, -2);
  assert.ok(!JSON.stringify(cl.msg(r.assistantMessageId)).includes("top_logprobs"));
  await api(s.base, "PUT", "/settings", { params: null }, token);
  fake.cfg.logprobs = null;
});

test("grammar and extraBody reach the body; extraBody never overrides owned fields", async () => {
  await api(s.base, "PUT", "/settings", { params: { grammar: 'root ::= "a"', extraBody: { model: "evil", stream: false, custom_flag: 7 } } }, token);
  const c = await conv();
  await reply(c);
  const b = lastBody();
  assert.equal(b.grammar, 'root ::= "a"');
  assert.equal(b.custom_flag, 7);
  assert.equal(b.model, "fake-model");
  assert.equal(b.stream, true);
  // invalid extraBody is refused by the PUT endpoints
  assert.equal((await api(s.base, "PUT", "/settings", { params: { extraBody: "x" } }, token)).status, 400);
  await api(s.base, "PUT", "/settings", { params: null }, token);
});

test("regenerate also accepts a one-shot responseFormat", async () => {
  const c = await conv();
  const r = await reply(c);
  const id = randomUUID();
  cl.send({ type: "regenerate", conversationId: c, messageId: r.assistantMessageId, assistantMessageId: id, responseFormat: { type: "json_object" } });
  await cl.waitMsg(id);
  assert.deepEqual(lastBody().response_format, { type: "json_object" });
});
