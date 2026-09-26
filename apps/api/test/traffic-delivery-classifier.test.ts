import { emptyRequestArrivalSummary } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyTrafficDelivery,
  classifyTrafficDeliverySummary,
  parsePersistedTrafficDeliverySummary,
} from "../src/services/traffic-delivery-classifier.js";

describe("traffic delivery classifier", () => {
  it.each([
    { unstartedRequests: 0, expected: "complete" },
    { unstartedRequests: 1, expected: "warning" },
    { unstartedRequests: 5, expected: "degraded" },
    { unstartedRequests: 6, expected: "failed" },
  ] as const)("classifies 100 planned with $unstartedRequests unstarted as $expected", ({
    unstartedRequests,
    expected,
  }) => {
    expect(classifyTrafficDelivery({ plannedRequests: 100, unstartedRequests })).toBe(expected);
  });

  it("guards zero plans instead of treating zero delivery as complete", () => {
    expect(classifyTrafficDelivery({ plannedRequests: 0, unstartedRequests: 0 })).toBeNull();
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
