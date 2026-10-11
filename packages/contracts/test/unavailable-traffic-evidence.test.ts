import { describe, expect, it } from "vitest";
import { trafficHttpSummarySchema } from "../src/load.js";
import { transportAttemptCountsSchema } from "../src/traffic-transport-counts.js";

const unknownCounts = {
  plannedRequests: 100,
  startedRequests: null,
  completedRequests: null,
  interruptedRequests: null,
  unstartedRequests: null,
};

describe("unavailable traffic evidence", () => {
  it("accepts unknown observed counts while retaining the configured plan", () => {
    expect(transportAttemptCountsSchema.parse(unknownCounts)).toEqual(unknownCounts);
  });
  it("enforces all unknown or all known counts and the known reconciliation equations", () => {
    expect(
      transportAttemptCountsSchema.safeParse({ ...unknownCounts, startedRequests: 0 }).success,
    ).toBe(false);
    expect(
      transportAttemptCountsSchema.safeParse({
        plannedRequests: 100,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 100,
      }).success,
    ).toBe(true);
    expect(
      transportAttemptCountsSchema.safeParse({
        plannedRequests: 100,
        startedRequests: 0,
        completedRequests: 0,
        interruptedRequests: 0,
        unstartedRequests: 0,
      }).success,
    ).toBe(false);
  });
  it("accepts independently unavailable HTTP counters with retained measured rate and latency", () => {
    const http = {
      failedRequests: null,
      acceptedResponses: null,
      soldOutResponses: null,
      transportFailures: null,
      unexpectedResponses: null,
      failureRate: null,
    };
    expect(trafficHttpSummarySchema.parse(http)).toEqual(http);
    expect(trafficHttpSummarySchema.safeParse({ ...http, failureRate: 0 }).success).toBe(true);
    expect(trafficHttpSummarySchema.safeParse({ ...http, p95LatencyMs: 0 }).success).toBe(true);
  });

  it("retains optional wall latency cohorts without inventing empty-cohort zeros", () => {
    const http = {
      failedRequests: 0,
      acceptedResponses: 2,
      soldOutResponses: 0,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    };
    expect(trafficHttpSummarySchema.parse(http)).not.toHaveProperty("buyerWallLatencySummary");
    const measured = {
      ...http,
      buyerWallLatencySummary: {
        accepted: { sampleCount: 2, averageMs: 0, p95Ms: 0 },
        soldOut: null,
      },
    };
    expect(trafficHttpSummarySchema.parse(measured)).toEqual(measured);
    expect(
      trafficHttpSummarySchema.safeParse({
        ...http,
        buyerWallLatencySummary: {
          accepted: { sampleCount: 0, averageMs: 0, p95Ms: 0 },
          soldOut: null,
        },
      }).success,
    ).toBe(false);
  });
});
