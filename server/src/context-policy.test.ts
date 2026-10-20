import test from "node:test";
import assert from "node:assert/strict";
import { effectiveOverflow } from "./context-policy.js";

test("chat override wins, otherwise the user default (compress when never set)", () => {
  const uid = "policy-user-" + Date.now();
  assert.equal(effectiveOverflow(uid, { context_overflow: null }), "summarize");
  assert.equal(effectiveOverflow(uid, { context_overflow: "stop" }), "stop");
  assert.equal(effectiveOverflow(uid, { contextOverflow: "truncate" }), "truncate");
  assert.equal(effectiveOverflow(uid, { context_overflow: "bogus" }), "summarize");
});
