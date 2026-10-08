import type { LoadExecutionPlan } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { deriveRunFailureDiagnostic } from "../../src/services/run-failure-diagnostic.js";

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
const answered = { plannedRequests: 30000, interruptedRequests: 0 };

describe("run failure diagnostic", () => {
  it("explains a delivery failure from the recorded VU warning", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, answered),
    ).toEqual({
      cause: "virtual_user_limit",
      maxVus: 4000,
    });
  });
  it.each([
    null,
    "admin_reset",
    "inventory_initialization_failed",
  ] as const)("does not turn a warning into a traffic failure for %s", (reason) => {
    expect(deriveRunFailureDiagnostic(reason, diagnostics, answered)).toBeNull();
  });
  it.each([
    null,
    { executionPlan, stderrLines: [] },
    { executionPlan, stderrLines: ["Insufficient VUs, reached 4000"] },
    { executionPlan, stderrLines: [warning.replace("4000", "5000")] },
    { executionPlan, stderrLines: ["An unrecognized failure"] },
  ])("does not guess from missing, truncated, or unrecognized evidence", (input) => {
    expect(deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", input, answered)).toEqual(
      {
        cause: "unidentified",
      },
    );
  });
  it("explains a delivery failure from requests the server left unanswered", () => {
    const quiet = { executionPlan, stderrLines: [] };
    const unanswered = { plannedRequests: 30000, interruptedRequests: 1501 };
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", quiet, unanswered),
    ).toEqual({ cause: "interrupted_requests" });
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", diagnostics, unanswered),
    ).toEqual({ cause: "virtual_user_limit", maxVus: 4000 });
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", quiet, {
        plannedRequests: 30000,
        interruptedRequests: 1500,
      }),
    ).toEqual({ cause: "unidentified" });
    expect(
      deriveRunFailureDiagnostic("traffic_delivery_major_shortfall", quiet, {
        plannedRequests: 30000,
        interruptedRequests: null,
      }),
    ).toEqual({ cause: "unidentified" });
  });
  it("does not substitute a delivery warning for a transport failure", () => {
    expect(
      deriveRunFailureDiagnostic("traffic_transport_major_loss", diagnostics, answered),
    ).toEqual({
      cause: "unidentified",
    });
  });
});
