import { describe, expect, it } from "vitest";
import { invalidDashboardDirtySignalMetadata } from "../../src/realtime/invalid-dashboard-dirty-signal-metadata.js";

describe("invalid dashboard dirty signal metadata", () => {
  it("extracts bounded identifiers without retaining the raw invalid payload", () => {
    const message = JSON.stringify({
      type: "unknown.projection.signal",
      correlationId: "corr-invalid",
      payload: "sensitive-unbounded-value",
    });

    const metadata = invalidDashboardDirtySignalMetadata(message, new Error("must not be logged"));

    expect(metadata).toEqual({
      stage: "redis_subscriber_parse",
      messageLength: message.length,
      errorName: "Error",
      signalType: "unknown.projection.signal",
      correlationId: "corr-invalid",
    });
    expect(metadata).not.toHaveProperty("payload");
  });

  it("isolates malformed JSON with only bounded structural metadata", () => {
    expect(invalidDashboardDirtySignalMetadata("{not-json")).toEqual({
      stage: "redis_subscriber_parse",
      messageLength: 9,
    });
  });
});
