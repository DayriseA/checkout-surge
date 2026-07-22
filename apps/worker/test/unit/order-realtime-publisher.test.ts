import type {
  OrderConsistencyLagDashboardEvent,
  OrderStatusDashboardEvent,
} from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { createBoundedOrderRealtimePublisher } from "../../src/realtime/order-realtime-publisher.js";

const processing = statusEvent(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "order.processing",
  "queued",
  "processing",
);
const confirmed = statusEvent(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "order.confirmed",
  "processing",
  "confirmed",
);
const lag: OrderConsistencyLagDashboardEvent = {
  type: "dashboard.metric.observed",
  eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  confirmedTransitionEventId: confirmed.eventId,
  correlationId: confirmed.correlationId,
  occurredAt: confirmed.occurredAt,
  metricName: "order.consistency_lag",
  value: 10,
  unit: "ms",
  observedAt: confirmed.occurredAt,
  orderId: confirmed.orderId,
  publicOrderId: confirmed.publicOrderId,
  saleOfferId: confirmed.saleOfferId,
  startedAt: "2026-06-20T00:00:00.000Z",
  confirmedAt: confirmed.occurredAt,
};

describe("bounded order realtime publisher", () => {
  it("keeps publication single-flight, accepts confirmation pairs atomically, and drops whole overflow groups", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const publish = vi.fn(
      async (event: OrderStatusDashboardEvent | OrderConsistencyLagDashboardEvent) => {
        void event;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await blocked;
        inFlight -= 1;
      },
    );
    const onDrop = vi.fn();
    const publisher = createBoundedOrderRealtimePublisher({
      publish,
      maxQueuedEvents: 2,
      maxBatchEvents: 2,
      onDrop,
    });

    publisher.enqueue([processing]);
    publisher.enqueue([confirmed, lag]);
    publisher.enqueue([processing]);
    expect(publisher.stats().queueDepth).toBe(2);
    expect(onDrop).toHaveBeenCalledWith(
      [processing],
      "queue_overflow",
      expect.objectContaining({ queueDepth: 2, highWaterMark: 2 }),
    );
    release();
    await publisher.close();

    expect(maxInFlight).toBe(1);
    expect(publish.mock.calls.map(([event]) => event.eventId)).toEqual([
      processing.eventId,
      confirmed.eventId,
      lag.eventId,
    ]);
    expect(publisher.stats().dropped["order.status.updated"]).toBe(1);
    expect(publisher.stats().highWaterMark).toBe(2);
    expect(publisher.stats().largestBatch).toBe(2);
    expect(publisher.stats().maxInFlight).toBe(1);
  });

  it("drops a whole enqueue group that exceeds the batch bound", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const onDrop = vi.fn();
    const publisher = createBoundedOrderRealtimePublisher({
      publish,
      maxQueuedEvents: 4,
      maxBatchEvents: 2,
      onDrop,
    });

    publisher.enqueue([processing, confirmed, lag]);
    publisher.enqueue([confirmed, lag]);
    await publisher.close();

    expect(onDrop).toHaveBeenCalledWith(
      [processing, confirmed, lag],
      "group_exceeds_batch",
      expect.objectContaining({ queueDepth: 0, highWaterMark: 0 }),
    );
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publisher.stats()).toMatchObject({
      queueDepth: 0,
      highWaterMark: 2,
      largestBatch: 2,
      maxInFlight: 1,
    });
  });

  it("counts invalid and rejected publications and continues draining", async () => {
    const onPublishError = vi.fn();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValue(undefined);
    const publisher = createBoundedOrderRealtimePublisher({ publish, onPublishError });
    publisher.enqueue([{ ...processing, attemptNumber: 0 } as OrderStatusDashboardEvent]);
    publisher.enqueue([processing]);
    publisher.enqueue([confirmed]);
    await publisher.close();

    expect(publisher.stats().invalid["order.status.updated"]).toBe(1);
    expect(publisher.stats().failed["order.status.updated"]).toBe(1);
    expect(publisher.stats().published["order.status.updated"]).toBe(1);
    expect(onPublishError).toHaveBeenCalledOnce();
  });
});

function statusEvent(
  eventId: string,
  eventName: OrderStatusDashboardEvent["eventName"],
  previousStatus: OrderStatusDashboardEvent["previousStatus"],
  status: OrderStatusDashboardEvent["status"],
): OrderStatusDashboardEvent {
  return {
    type: "order.status.updated",
    eventId,
    correlationId: "corr-live",
    occurredAt: "2026-06-20T00:00:00.010Z",
    orderId: "11111111-1111-4111-8111-111111111111",
    publicOrderId: "ord-live",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    eventName,
    previousStatus,
    status,
    attemptNumber: 1,
    attemptsMade: 0,
  };
}
