import { describe, expect, it } from "vitest";
import { trafficHttpSummarySchema } from "../src/load.js";
import {
  measuredTransportAttemptCountsSchema,
  transportAttemptCountsSchema,
} from "../src/traffic-transport-counts.js";

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
    expect(measuredTransportAttemptCountsSchema.safeParse(unknownCounts).success).toBe(false);
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
  it("accepts unavailable HTTP outcomes without suggesting measured failure rate or latency", () => {
    const http = {
      failedRequests: null,
      acceptedResponses: null,
      soldOutResponses: null,
      transportFailures: null,
      unexpectedResponses: null,
      failureRate: null,
    };
    expect(trafficHttpSummarySchema.parse(http)).toEqual(http);
    expect(trafficHttpSummarySchema.safeParse({ ...http, failureRate: 0 }).success).toBe(false);
    expect(trafficHttpSummarySchema.safeParse({ ...http, p95LatencyMs: 0 }).success).toBe(false);
  });
});
