import { describe, expect, it } from "vitest";
import { invalidDashboardEventMetadata } from "../src/realtime/invalid-dashboard-event-metadata.js";

describe("invalid dashboard event metadata", () => {
  it("extracts bounded identifiers without retaining the raw invalid payload", () => {
    const longMetricName = `unknown.${"x".repeat(200)}`;
    const message = JSON.stringify({
      type: "dashboard.metric.observed",
      metricName: longMetricName,
      eventName: "unknown.business.event",
      runId: "run-invalid",
      correlationId: "corr-invalid",
      payload: "sensitive-unbounded-value",
    });

    const metadata = invalidDashboardEventMetadata(message, new Error("must not be logged"));

    expect(metadata).toEqual({
      stage: "redis_subscriber_parse",
      messageLength: message.length,
      errorName: "Error",
      eventType: "dashboard.metric.observed",
      metricName: longMetricName.slice(0, 128),
      businessEventName: "unknown.business.event",
      runId: "run-invalid",
      correlationId: "corr-invalid",
    });
    expect(metadata).not.toHaveProperty("payload");
  });

  it("isolates malformed JSON with only bounded structural metadata", () => {
    expect(invalidDashboardEventMetadata("{not-json")).toEqual({
      stage: "redis_subscriber_parse",
      messageLength: 9,
    });
  });
});
