// selftest step 6 (PLAN 2.9, T12): the mapped-model check is only meaningful when the sonnet pin differs from the main
// model; with equal values a pass proves nothing and is reported as vacuous.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as selftest from "../src/selftest.mjs";

const call = (over) => selftest.mappedModelStep({ sub: { id: "t" }, subRes: { isError: false }, sonnet: "role-sonnet", model: "role-exec", mu: ["role-sonnet"], ...over });

test("selftest step 6 passes only when the subagent ran on a sonnet pin that differs from the main model", () => {
  const s = call({});
  assert.deepEqual([s.n, s.ok, !!s.vacuous], [6, true, false]);
  assert.equal(call({ mu: ["role-exec"] }).ok, false); // ran on the wrong model
  assert.equal(call({ sub: undefined }).ok, false);   // the model never made the call
  assert.equal(call({ subRes: { isError: true } }).ok, false);
});
test("selftest step 6 is reported vacuous, not passed, when the sonnet pin equals WA_MAIN_MODEL", () => {
  const s = call({ sonnet: "role-exec", mu: ["role-exec"] });
  assert.equal(s.ok, false);
  assert.equal(s.vacuous, true);
  assert.match(s.detail, /vacuous/i);
  assert.match(selftest.formatStep(s), /^VACUOUS 6 /);
  assert.match(selftest.formatStep({ n: 1, name: "x", ok: true, detail: "" }), /^PASS 1 /);
  assert.match(selftest.formatStep({ n: 2, name: "x", ok: false, detail: "" }), /^FAIL 2 /);
});
