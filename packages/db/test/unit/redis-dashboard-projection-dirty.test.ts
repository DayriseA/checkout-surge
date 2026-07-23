import { describe, expect, it, vi } from "vitest";
import {
  type CheckoutSurgeRedis,
  createRedisDashboardProjectionDirtySubscriber,
  dashboardProjectionDirtyRedisChannel,
  parseDashboardProjectionDirtyMessage,
  serializeDashboardProjectionDirtySignal,
} from "../../src/index.js";

const scope = {
  runId: "11111111-1111-4111-8111-111111111111",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
};

describe("dashboard projection dirty transport", () => {
  it("round-trips ordinary cadence and exact-scope immediate signals without adding state", () => {
    const ordinary = {
      type: "dashboard.projection.dirty" as const,
      correlationId: "corr-ordinary",
    };
    const exact = {
      type: "dashboard.projection.dirty" as const,
      correlationId: "corr-exact",
      scope,
    };

    expect(
      parseDashboardProjectionDirtyMessage(serializeDashboardProjectionDirtySignal(ordinary)),
    ).toEqual(ordinary);
    expect(
      parseDashboardProjectionDirtyMessage(serializeDashboardProjectionDirtySignal(exact)),
    ).toEqual(exact);
  });

  it.each([
    {
      type: "dashboard.projection.dirty",
      correlationId: "corr-dead-flag",
      immediate: true,
    },
    {
      type: "dashboard.projection.dirty",
      correlationId: "corr-partial-scope",
      scope: { runId: scope.runId },
    },
    {
      type: "dashboard.projection.dirty",
      correlationId: "corr-invalid-scope",
      scope: { ...scope, runId: "not-a-uuid" },
    },
    {
      type: "dashboard.projection.dirty",
      correlationId: "corr-extra",
      extra: true,
    },
  ])("rejects ambiguous or invalid signal shape %#", (value) => {
    expect(() => parseDashboardProjectionDirtyMessage(JSON.stringify(value))).toThrow();
  });

  it("isolates invalid messages and handler errors across idempotent start and close", async () => {
    const messageHandlers = new Set<(channel: string, message: string) => void>();
    const subscribe = vi.fn().mockResolvedValue(undefined);
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    const redis = {
      on: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
        if (event === "message") messageHandlers.add(handler);
      }),
      off: vi.fn((event: string, handler: (channel: string, message: string) => void) => {
        if (event === "message") messageHandlers.delete(handler);
      }),
      subscribe,
      unsubscribe,
    } as unknown as CheckoutSurgeRedis;
    const handlerFailure = new Error("handler failed");
    const onDirty = vi.fn().mockRejectedValue(handlerFailure);
    const onHandlerError = vi.fn();
    const onInvalidMessage = vi.fn();
    const subscriber = createRedisDashboardProjectionDirtySubscriber(redis, {
      onDirty,
      onHandlerError,
      onInvalidMessage,
    });

    await subscriber.start();
    await subscriber.start();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(messageHandlers).toHaveLength(1);

    for (const handler of messageHandlers) {
      handler(dashboardProjectionDirtyRedisChannel, '{"bad":true}');
      handler(
        dashboardProjectionDirtyRedisChannel,
        serializeDashboardProjectionDirtySignal({
          type: "dashboard.projection.dirty",
          correlationId: "corr-handler",
        }),
      );
    }
    await vi.waitFor(() => expect(onHandlerError).toHaveBeenCalledWith(handlerFailure));
    expect(onInvalidMessage).toHaveBeenCalledOnce();
    expect(onDirty).toHaveBeenCalledOnce();

    await subscriber.close();
    await subscriber.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(messageHandlers).toHaveLength(0);
  });
});
