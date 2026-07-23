import type { DashboardProjectionDirtySignal } from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { createDashboardProjectionDirtySubscriberHandlers } from "../src/realtime/dashboard-projection-dirty-subscriber-handlers.js";

describe("dashboard Redis subscriber boundary", () => {
  it("passes each validated dirty signal to projection publication", () => {
    const markDirty = vi.fn();
    const handlers = createDashboardProjectionDirtySubscriberHandlers({
      projectionPublications: { markDirty },
      logger: createSilentLogger("api"),
    });
    const signal = dirtySignal();

    handlers.onDirty(signal);

    expect(markDirty).toHaveBeenCalledOnce();
    expect(markDirty).toHaveBeenCalledWith(signal);
  });

  it("contains subscriber callback errors and reports invalid Redis payload metadata", () => {
    const logger = createSilentLogger("api");
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const handlers = createDashboardProjectionDirtySubscriberHandlers({
      projectionPublications: { markDirty: vi.fn() },
      logger,
    });
    const failure = new Error("subscriber callback failed");

    handlers.onHandlerError?.(failure);
    handlers.onInvalidMessage?.(failure, '{"bad":true}');

    expect(error).toHaveBeenCalledWith(
      { err: failure },
      "Dashboard projection dirty handler failed.",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "redis_subscriber_parse",
        messageLength: 12,
      }),
      "Ignored invalid dashboard projection dirty signal from Redis Pub/Sub.",
    );
  });
});

function dirtySignal(): DashboardProjectionDirtySignal {
  return {
    type: "dashboard.projection.dirty",
    correlationId: "redis-boundary",
  };
}
