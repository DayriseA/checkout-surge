import type { LoadExecutionPlan } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { deriveRunFailureDiagnostic as derive } from "../../src/services/run-failure-diagnostic.js";

const executionPlan: LoadExecutionPlan = {
  trafficMode: "constant-arrival-rate",
  ratePerSecond: 2000,
  durationSeconds: 15,
  preAllocatedVus: 3000,
  maxVus: 4000,
  startDelaySeconds: 6,
  plannedEmittedAttempts: 30000,
};
const warning =
  'time="2026-09-22T15:42:13Z" level=warning msg="Insufficient VUs, reached 4000 active VUs and cannot initialize more" executor=constant-arrival-rate scenario=checkout';
const diagnostics = { executionPlan, stderrLines: [warning] };
const quiet = { executionPlan, stderrLines: [] };
/** 2,557 of 30,000 requests (8.52 %) never sent; every sent request answered. */
const unsent = {
  plannedRequests: 30000,
  startedRequests: 27443,
  unstartedRequests: 2557,
  interruptedRequests: 0,
};
/** All but 2 requests sent; 3,410 (11.4 %) still waiting when the generator stopped. */
const lateAnswers = {
  plannedRequests: 30000,
  startedRequests: 29998,
  unstartedRequests: 2,
  interruptedRequests: 3410,
};
/** Every request sent and completed; transport loss is graded against the 10,000 started. */
const allCompleted = {
  plannedRequests: 10000,
  startedRequests: 10000,
  unstartedRequests: 0,
  interruptedRequests: 0,
};

/** A normal generator exit without request timeouts unless a test says otherwise. */
function deriveRunFailureDiagnostic(
  reason: Parameters<typeof derive>[0],
  diagnostics: Parameters<typeof derive>[1],
  counts: Parameters<typeof derive>[2],
  trafficStatus: Parameters<typeof derive>[4] = "succeeded",
  http: Parameters<typeof derive>[3] = { requestTimeouts: 0 },
) {
  return derive(reason, diagnostics, counts, http, trafficStatus);
}

describe("run failure diagnostic", () => {
  it("explains a delivery failure from the recorded VU warning when unsent requests fail it", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, unsent),
    ).toEqual({ cause: "virtual_user_limit", maxVus: 4000 });
  });
  it.each([
    null,
    "admin_reset",
    "inventory_initialization_failed",
  ] as const)("does not turn a warning into a traffic failure for %s", (reason) => {
    expect(deriveRunFailureDiagnostic(reason, diagnostics, unsent)).toBeNull();
  });
  it.each([
    null,
    quiet,
    { executionPlan, stderrLines: ["Insufficient VUs, reached 4000"] },
    { executionPlan, stderrLines: [warning.replace("4000", "5000")] },
    { executionPlan, stderrLines: ["An unrecognized failure"] },
  ])("does not guess from missing, truncated, or unrecognized evidence", (input) => {
    expect(deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", input, unsent)).toEqual({
      cause: "unidentified",
    });
  });
  it("explains late answers even when the generator also reported its VU limit", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, lateAnswers),
    ).toEqual({ cause: "interrupted_requests" });
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", quiet, lateAnswers),
    ).toEqual({ cause: "interrupted_requests" });
  });
  it("does not read late answers into counts left by a generator that did not exit normally", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", quiet, lateAnswers, "failed"),
    ).toEqual({ cause: "unidentified" });
  });
  it("names no cause whose own requests stay within the failure tier", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, {
        plannedRequests: 30000,
        startedRequests: 28500,
        unstartedRequests: 1500,
        interruptedRequests: 1500,
      }),
    ).toEqual({ cause: "unidentified" });
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, {
        plannedRequests: 30000,
        startedRequests: null,
        unstartedRequests: null,
        interruptedRequests: null,
      }),
    ).toEqual({ cause: "unidentified" });
  });
  it("explains transport loss by request timeouts when they alone exceed the failure tier", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_transport_major_loss", quiet, allCompleted, "succeeded", {
        requestTimeouts: 631,
      }),
    ).toEqual({ cause: "request_timeouts" });
  });
  it.each([
    ["within the failure tier", { requestTimeouts: 500 }, "succeeded"],
    ["recorded before the timeout counter", {}, "succeeded"],
    ["with an unknown timeout counter", { requestTimeouts: null }, "succeeded"],
    ["after an abnormal generator exit", { requestTimeouts: 631 }, "failed"],
  ] as const)("leaves transport loss unidentified with timeouts %s", (_case, http, status) => {
    expect(
      deriveRunFailureDiagnostic("traffic_transport_major_loss", quiet, allCompleted, status, http),
    ).toEqual({ cause: "unidentified" });
  });
  it("does not substitute a delivery warning for a transport failure", () => {
    expect(deriveRunFailureDiagnostic("traffic_transport_major_loss", diagnostics, unsent)).toEqual(
      { cause: "unidentified" },
    );
  });
});
