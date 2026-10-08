import { emptyRequestArrivalSummary } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyTrafficDelivery,
  classifyTrafficDeliverySummary,
  parsePersistedTrafficDeliverySummary,
} from "../../src/services/traffic-delivery-classifier.js";

function plannedHundred(unstartedRequests: number, interruptedRequests: number) {
  const startedRequests = 100 - unstartedRequests;
  return {
    plannedRequests: 100,
    startedRequests,
    completedRequests: startedRequests - interruptedRequests,
    interruptedRequests,
    unstartedRequests,
  };
}

describe("traffic delivery classifier", () => {
  it.each([
    { unstartedRequests: 0, interruptedRequests: 0, expected: "complete" },
    { unstartedRequests: 1, interruptedRequests: 0, expected: "warning" },
    { unstartedRequests: 0, interruptedRequests: 1, expected: "warning" },
    { unstartedRequests: 5, interruptedRequests: 0, expected: "degraded" },
    { unstartedRequests: 0, interruptedRequests: 5, expected: "degraded" },
    { unstartedRequests: 1, interruptedRequests: 1, expected: "degraded" },
    { unstartedRequests: 6, interruptedRequests: 0, expected: "failed" },
    { unstartedRequests: 0, interruptedRequests: 6, expected: "failed" },
    { unstartedRequests: 3, interruptedRequests: 3, expected: "failed" },
  ] as const)("classifies 100 planned with $unstartedRequests unstarted and $interruptedRequests interrupted as $expected", ({
    unstartedRequests,
    interruptedRequests,
    expected,
  }) => {
    expect(classifyTrafficDelivery(plannedHundred(unstartedRequests, interruptedRequests))).toBe(
      expected,
    );
  });

  it("guards zero plans instead of treating zero delivery as complete", () => {
    expect(classifyTrafficDelivery({ plannedRequests: 0, completedRequests: 0 })).toBeNull();
  });

  it("classifies the current incoming completion evidence at the API boundary", () => {
    const summary = classifyTrafficDeliverySummary(
      {
        trafficMode: "buyer-spike",
        plannedBuyers: 100,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        requestArrivalSummary: emptyRequestArrivalSummary,
        notes: [],
      },
      {
        plannedRequests: 100,
        startedRequests: 94,
        completedRequests: 90,
        interruptedRequests: 4,
        unstartedRequests: 6,
      },
    );
    expect(summary).toEqual({
      trafficMode: "buyer-spike",
      plannedBuyers: 100,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "failed",
      notes: [],
    });
    const counts = {
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 90,
      interruptedRequests: 4,
      unstartedRequests: 6,
    };
    expect(parsePersistedTrafficDeliverySummary(summary, counts, "finalization run-1")).toEqual(
      summary,
    );

    const { completedIterations: _completedIterations, ...incompletePersistedSummary } = summary;
    expect(() =>
      parsePersistedTrafficDeliverySummary(
        incompletePersistedSummary,
        counts,
        "finalization run-1",
      ),
    ).toThrow(/finalization run-1.*trafficDeliverySummary\.completedIterations/);
  });
});
