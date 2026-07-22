import { describe, expect, it } from "vitest";
import {
  classifyTrafficDelivery,
  classifyTrafficDeliverySummary,
  parsePersistedTrafficDeliverySummary,
  parsePersistedTrafficHttpSummary,
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
      classifyTrafficDeliverySummary({
        plannedRequests: 0,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 1,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        notes: [],
      }),
    ).toThrow();
  });

  it("classifies the current incoming completion evidence at the API boundary", () => {
    const summary = classifyTrafficDeliverySummary({
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 90,
      interruptedRequests: 4,
      unstartedRequests: 6,
      trafficMode: "buyer-spike",
      plannedBuyers: 100,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      notes: [],
    });
    expect(summary).toEqual({
      plannedRequests: 100,
      startedRequests: 94,
      completedRequests: 90,
      interruptedRequests: 4,
      unstartedRequests: 6,
      trafficMode: "buyer-spike",
      plannedBuyers: 100,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      trafficDeliveryStatus: "failed",
      notes: [],
    });
    expect(parsePersistedTrafficDeliverySummary(summary, "finalization run-1")).toEqual(summary);

    const { completedIterations: _completedIterations, ...incompletePersistedSummary } = summary;
    expect(() =>
      parsePersistedTrafficDeliverySummary(incompletePersistedSummary, "finalization run-1"),
    ).toThrow(/finalization run-1.*trafficDeliverySummary\.completedIterations/);
  });

  it("rejects inconsistent transport counts instead of repairing them", () => {
    expect(() =>
      classifyTrafficDeliverySummary({
        plannedRequests: 100,
        startedRequests: 100,
        completedRequests: 90,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 100,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 7,
        completedIterations: 90,
        notes: ["interrupted traffic mislabeled"],
      }),
    ).toThrow();
    expect(() =>
      classifyTrafficDeliverySummary({
        plannedRequests: 100,
        startedRequests: 97,
        completedRequests: 97,
        interruptedRequests: 0,
        unstartedRequests: 0,
        trafficMode: "buyer-spike",
        plannedBuyers: 100,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        notes: [],
      }),
    ).toThrow();
  });

  it("rejects emitted-era delivery rows with persisted row context", () => {
    expect(() =>
      parsePersistedTrafficDeliverySummary(
        {
          plannedRequests: 100,
          emittedRequests: 94,
          droppedIterations: 0,
          unstartedIterations: 6,
          requestShortfall: 6,
          trafficDeliveryStatus: "complete",
          notes: [],
        },
        "run summary row summary-1",
      ),
    ).toThrow(/run summary row summary-1.*trafficDeliverySummary/);
  });

  it("rejects emitted-era HTTP summaries with persisted row context", () => {
    expect(() =>
      parsePersistedTrafficHttpSummary(
        {
          plannedRequests: 100,
          emittedRequests: 94,
          completedRequests: 90,
          failedRequests: 0,
          acceptedResponses: 30,
          soldOutResponses: 60,
          unexpectedResponses: 0,
          failureRate: 0,
        },
        "demo run finalization run-1",
      ),
    ).toThrow(/demo run finalization run-1.*httpSummary/);
  });

  it("accepts canonical HTTP summaries at the persisted boundary", () => {
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
    expect(parsePersistedTrafficHttpSummary(canonical, "summary row summary-1")).toEqual(canonical);
  });
});
