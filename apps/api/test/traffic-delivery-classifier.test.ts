import { describe, expect, it } from "vitest";
import {
  classifyTrafficDelivery,
  normalizeTrafficDeliverySummary,
} from "../src/services/traffic-delivery-classifier.js";

describe("traffic delivery classifier", () => {
  it.each([
    { emittedRequests: 100, expected: "complete" },
    { emittedRequests: 99, expected: "warning" },
    { emittedRequests: 95, expected: "degraded" },
    { emittedRequests: 94, expected: "failed" },
    { emittedRequests: 101, expected: "complete" },
  ] as const)("classifies 100/$emittedRequests as $expected", ({ emittedRequests, expected }) => {
    expect(classifyTrafficDelivery({ plannedRequests: 100, emittedRequests })).toBe(expected);
  });

  it("guards zero plans instead of treating zero delivery as complete", () => {
    expect(classifyTrafficDelivery({ plannedRequests: 0, emittedRequests: 0 })).toBeNull();
    expect(() =>
      normalizeTrafficDeliverySummary({
        plannedRequests: 0,
        emittedRequests: 0,
        droppedIterations: 0,
        notes: [],
      }),
    ).toThrow(/zero planned requests/i);
  });

  it("overrides a contradictory legacy producer status and enriches missing fields", () => {
    expect(
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        emittedRequests: 94,
        droppedIterations: 0,
        requestShortfall: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      }),
    ).toEqual({
      plannedRequests: 100,
      emittedRequests: 94,
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      unstartedIterations: null,
      requestShortfall: 6,
      trafficDeliveryStatus: "failed",
      notes: [],
    });
  });

  it("keeps complete request delivery complete despite dropped and unstarted diagnostics", () => {
    expect(
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        emittedRequests: 100,
        droppedIterations: 7,
        completedIterations: 90,
        unstartedIterations: 3,
        requestShortfall: 42,
        trafficDeliveryStatus: "failed",
        notes: ["diagnostic-only iteration evidence"],
      }),
    ).toMatchObject({
      droppedIterations: 7,
      unstartedIterations: 3,
      requestShortfall: 0,
      trafficDeliveryStatus: "complete",
    });
  });
});
