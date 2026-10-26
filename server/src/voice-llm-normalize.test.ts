import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLlm } from "./voice-routes.js";

test("normalizeLlm: endpoints as objects, roles as an object of {endpoint, model}", () => {
  const v = normalizeLlm({ endpoints: [{ name: "a", model: "m1" }, { id: "b" }, { name: "a" }, 5], roles: { fast: { endpoint: "a", model: "m1" }, deep: "m2" }, usage: { fast: { requests: 3 } } });
  assert.deepEqual(v.endpoints, [{ id: "a", name: "a", model: "m1" }, { id: "b", name: "b", model: "" }]);
  assert.deepEqual(v.roles, { fast: { endpoint: "a", model: "m1" }, deep: { endpoint: "", model: "m2" } });
  assert.deepEqual(v.usage, { fast: { requests: 3 } });
});

test("normalizeLlm: endpoints as a map or names, roles as a list, and garbage", () => {
  const v = normalizeLlm({ endpoints: { x: { model: "m" }, y: {} }, roles: [{ role: "fast", endpoint: "x", model: "m" }, { name: "deep", model: "z" }, 3] });
  assert.deepEqual(v.endpoints.map((e) => e.id), ["x", "y"]);
  assert.equal(v.roles.fast.model, "m");
  assert.equal(v.roles.deep.model, "z");
  assert.deepEqual(normalizeLlm(null), { endpoints: [], roles: {}, usage: {} });
  assert.deepEqual(normalizeLlm({ endpoints: ["s1", "s2"] }).endpoints.map((e) => e.name), ["s1", "s2"]);
});
