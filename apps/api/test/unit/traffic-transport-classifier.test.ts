import { describe, expect, it } from "vitest";
import { classifyTrafficTransport } from "../../src/services/traffic-delivery-classifier.js";

describe("traffic transport classifier", () => {
  it.each([
    { transportFailures: 0, expected: "complete" },
    { transportFailures: 100, expected: "warning" },
    { transportFailures: 101, expected: "degraded" },
    { transportFailures: 500, expected: "degraded" },
    { transportFailures: 501, expected: "failed" },
  ] as const)("classifies 10,000 started requests with $transportFailures failures as $expected", ({
    transportFailures,
    expected,
  }) => {
    expect(classifyTrafficTransport({ startedRequests: 10_000, transportFailures })).toBe(expected);
  });

  it("does not classify transport loss without dispatched attempts", () => {
    expect(classifyTrafficTransport({ startedRequests: 0, transportFailures: 0 })).toBeNull();
  });
});
