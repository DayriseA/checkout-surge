import assert from "node:assert/strict";
import { test } from "node:test";
import { isCapacityRefusal } from "./capacity-refusal.mjs";

// Shaped as the deploy script's Machines API client throws them.
function apiError(status, body) {
  return Object.assign(new Error(`POST /machines/8d40d9fee36ee8 failed with ${status}: ${body}`), {
    status,
  });
}

test("a full host's refusal of a Machine update is a capacity refusal", () => {
  const error = apiError(
    409,
    '{"error":"could not reserve resource for machine: insufficient memory available to fulfill request on the current host"}',
  );

  assert.equal(isCapacityRefusal(error), true);
});

test("other refusals are not capacity refusals", () => {
  assert.equal(isCapacityRefusal(apiError(409, '{"error":"lease currently held"}')), false);
  assert.equal(
    isCapacityRefusal(apiError(500, '{"error":"insufficient memory available"}')),
    false,
  );
  assert.equal(isCapacityRefusal(new Error("fetch failed")), false);
});
