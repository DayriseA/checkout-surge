import { describe, expect, it } from "vitest";
import {
  classifyTrafficDelivery,
  normalizePersistedTrafficHttpSummary,
  normalizeTrafficDeliverySummary,
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

  it("classifies fully started attempts as complete delivery even with interrupted responses", () => {
    expect(classifyTrafficDelivery({ plannedRequests: 1_000, unstartedRequests: 0 })).toBe(
      "complete",
    );
  });

  it("guards zero plans instead of treating zero delivery as complete", () => {
    expect(classifyTrafficDelivery({ plannedRequests: 0, unstartedRequests: 0 })).toBeNull();
    expect(() =>
      normalizeTrafficDeliverySummary({
        plannedRequests: 0,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 0,
        droppedIterations: 0,
        notes: [],
      }),
    ).toThrow(/zero planned requests/i);
  });

  it("overrides a contradictory producer status and enriches missing fields", () => {
    expect(
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        startedRequests: 94,
        completedRequests: 90,
        interruptedRequests: 4,
        unstartedRequests: 6,
        droppedIterations: 0,
        trafficDeliveryStatus: "complete",
        notes: [],
      }),
    ).toEqual({
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 90,
      interruptedRequests: 4,
      unstartedRequests: 6,
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      trafficDeliveryStatus: "failed",
      notes: [],
    });
  });

  it("rejects inconsistent transport counts instead of repairing them", () => {
    expect(() =>
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        startedRequests: 100,
        completedRequests: 90,
        interruptedRequests: 0,
        unstartedRequests: 0,
        droppedIterations: 7,
        completedIterations: 90,
        notes: ["interrupted traffic mislabeled"],
      }),
    ).toThrow();
    expect(() =>
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        startedRequests: 97,
        completedRequests: 97,
        interruptedRequests: 0,
        unstartedRequests: 0,
        droppedIterations: 0,
        notes: [],
      }),
    ).toThrow();
  });

  it("normalizes legacy delivery rows with emitted-era names at the read boundary", () => {
    expect(
      normalizeTrafficDeliverySummary({
        plannedRequests: 100,
        emittedRequests: 94,
        droppedIterations: 0,
        unstartedIterations: 6,
        requestShortfall: 6,
        trafficDeliveryStatus: "complete",
        notes: [],
      }),
    ).toEqual({
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 94,
      interruptedRequests: 0,
      unstartedRequests: 6,
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      trafficDeliveryStatus: "failed",
      notes: [],
    });
  });

  it("normalizes legacy HTTP summaries with emitted-era names at the read boundary", () => {
    expect(
      normalizePersistedTrafficHttpSummary({
        plannedRequests: 100,
        emittedRequests: 94,
        completedRequests: 90,
        failedRequests: 0,
        acceptedResponses: 30,
        soldOutResponses: 60,
        unexpectedResponses: 0,
        failureRate: 0,
      }),
    ).toEqual({
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 90,
      interruptedRequests: 4,
      unstartedRequests: 6,
      failedRequests: 0,
      acceptedResponses: 30,
      soldOutResponses: 60,
      unexpectedResponses: 0,
      failureRate: 0,
    });
  });

  it("keeps canonical HTTP summaries untouched at the read boundary", () => {
    const canonical = {
      plannedRequests: 1_000,
      startedRequests: 1_000,
      completedRequests: 750,
      interruptedRequests: 250,
      unstartedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 250,
      soldOutResponses: 500,
      unexpectedResponses: 0,
      failureRate: 0,
    };
    expect(normalizePersistedTrafficHttpSummary(canonical)).toEqual(canonical);
  });
});
