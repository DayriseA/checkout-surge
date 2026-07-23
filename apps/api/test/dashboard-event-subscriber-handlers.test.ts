import type { DashboardEvent } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { createDashboardEventSubscriberHandlers } from "../src/realtime/dashboard-event-subscriber-handlers.js";

describe("dashboard Redis subscriber boundary", () => {
  it("keeps legacy delivery while passing each validated event only as a projection dirty signal", () => {
    const publish = vi.fn();
    const markDirty = vi.fn();
    const handlers = createDashboardEventSubscriberHandlers({
      fanout: { publish },
      projectionPublications: { markDirty },
      logger: createSilentLogger("api"),
    });
    const event = metricEvent();

    handlers.onEvent(event);

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event);
    expect(markDirty).toHaveBeenCalledOnce();
    expect(markDirty).toHaveBeenCalledWith(event);
  });

  it("contains subscriber callback errors and reports invalid Redis payload metadata", () => {
    const logger = createSilentLogger("api");
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const handlers = createDashboardEventSubscriberHandlers({
      fanout: { publish: vi.fn() },
      projectionPublications: { markDirty: vi.fn() },
      logger,
    });
    const failure = new Error("subscriber callback failed");

    handlers.onHandlerError?.(failure);
    handlers.onInvalidMessage?.(failure, '{"bad":true}');

    expect(error).toHaveBeenCalledWith({ err: failure }, "Dashboard event fan-out failed.");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "redis_subscriber_parse",
        messageLength: 12,
      }),
      "Ignored invalid dashboard realtime event from Redis Pub/Sub.",
    );
  });
});

function metricEvent(): DashboardEvent {
  return {
    type: "dashboard.metric.observed",
    runId: "55555555-5555-4555-8555-555555555555",
    correlationId: "redis-boundary",
    metricName: "traffic.latency",
    value: 12,
    unit: "ms",
    occurredAt: "2026-07-23T12:00:00.000Z",
    observedAt: "2026-07-23T12:00:00.000Z",
  };
}
