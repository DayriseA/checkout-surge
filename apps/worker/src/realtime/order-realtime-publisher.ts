import {
  type DashboardEvent,
  dashboardEventSchema,
  type OrderConsistencyLagDashboardEvent,
  type OrderStatusDashboardEvent,
} from "@checkout-surge/contracts";

type OrderRealtimeEvent = OrderStatusDashboardEvent | OrderConsistencyLagDashboardEvent;
type EventType = "order.status.updated" | "order.consistency_lag";

export interface OrderRealtimePublisherCounters {
  queueDepth: number;
  highWaterMark: number;
  inFlight: number;
  maxInFlight: number;
  largestBatch: number;
  enqueued: Record<EventType, number>;
  published: Record<EventType, number>;
  dropped: Record<EventType, number>;
  invalid: Record<EventType | "unknown", number>;
  failed: Record<EventType, number>;
}

export interface BoundedOrderRealtimePublisher {
  enqueue(events: readonly OrderRealtimeEvent[]): void;
  stats(): OrderRealtimePublisherCounters;
  close(): Promise<void>;
}

export function createBoundedOrderRealtimePublisher(options: {
  publish(event: DashboardEvent): Promise<unknown>;
  maxQueuedEvents?: number;
  maxBatchEvents?: number;
  onInvalid?(error: unknown, event: unknown, stats: OrderRealtimePublisherCounters): void;
  onDrop?(
    events: readonly OrderRealtimeEvent[],
    reason: "closed" | "queue_overflow" | "group_exceeds_batch",
    stats: OrderRealtimePublisherCounters,
  ): void;
  onPublishError?(
    error: unknown,
    event: OrderRealtimeEvent,
    stats: OrderRealtimePublisherCounters,
  ): void;
  onStats?(stats: OrderRealtimePublisherCounters): void;
}): BoundedOrderRealtimePublisher {
  const maxQueuedEvents = positiveInteger(options.maxQueuedEvents ?? 1_024, "maxQueuedEvents");
  const maxBatchEvents = positiveInteger(options.maxBatchEvents ?? 64, "maxBatchEvents");
  const queue: OrderRealtimeEvent[][] = [];
  let queueDepth = 0;
  let highWaterMark = 0;
  let draining: Promise<void> | null = null;
  let closed = false;
  const counter = () => ({ "order.status.updated": 0, "order.consistency_lag": 0 });
  const counters: OrderRealtimePublisherCounters = {
    queueDepth: 0,
    highWaterMark: 0,
    inFlight: 0,
    maxInFlight: 0,
    largestBatch: 0,
    enqueued: counter(),
    published: counter(),
    dropped: counter(),
    invalid: { ...counter(), unknown: 0 },
    failed: counter(),
  };

  const observe = () => {
    counters.queueDepth = queueDepth;
    counters.highWaterMark = highWaterMark;
    try {
      options.onStats?.(cloneCounters(counters));
    } catch {
      /* observability is best effort */
    }
  };

  const startDrain = () => {
    draining ??= drain().finally(() => {
      draining = null;
      if (queue.length > 0) startDrain();
    });
  };

  const drain = async () => {
    while (queue.length > 0) {
      const batch: OrderRealtimeEvent[] = [];
      while (queue.length > 0 && batch.length + (queue[0]?.length ?? 0) <= maxBatchEvents) {
        batch.push(...(queue.shift() ?? []));
      }
      if (batch.length === 0) throw new Error("Order realtime queue contained an oversized group.");
      queueDepth -= batch.length;
      counters.largestBatch = Math.max(counters.largestBatch, batch.length);
      observe();
      for (const event of batch) {
        try {
          counters.inFlight = 1;
          counters.maxInFlight = 1;
          observe();
          await options.publish(event);
          counters.published[eventType(event)] += 1;
        } catch (error) {
          counters.failed[eventType(event)] += 1;
          try {
            options.onPublishError?.(error, event, cloneCounters(counters));
          } catch {
            /* best effort */
          }
        } finally {
          counters.inFlight = 0;
        }
        observe();
      }
    }
  };

  return {
    enqueue(events) {
      if (events.length === 0) return;
      const parsed: OrderRealtimeEvent[] = [];
      for (const candidate of events) {
        const result = dashboardEventSchema.safeParse(candidate);
        if (!result.success || !isOrderRealtimeEvent(result.data)) {
          const type = eventType(candidate);
          counters.invalid[type] += 1;
          try {
            options.onInvalid?.(
              result.success ? new Error("Unsupported realtime event type.") : result.error,
              candidate,
              cloneCounters(counters),
            );
          } catch {
            /* best effort */
          }
          observe();
          return;
        }
        parsed.push(result.data);
      }
      const dropReason = closed
        ? "closed"
        : parsed.length > maxBatchEvents
          ? "group_exceeds_batch"
          : queueDepth + parsed.length > maxQueuedEvents
            ? "queue_overflow"
            : null;
      if (dropReason) {
        for (const event of parsed) counters.dropped[eventType(event)] += 1;
        try {
          options.onDrop?.(parsed, dropReason, cloneCounters(counters));
        } catch {
          /* best effort */
        }
        observe();
        return;
      }
      queue.push(parsed);
      queueDepth += parsed.length;
      highWaterMark = Math.max(highWaterMark, queueDepth);
      for (const event of parsed) counters.enqueued[eventType(event)] += 1;
      observe();
      startDrain();
    },
    stats: () => cloneCounters(counters),
    async close() {
      closed = true;
      while (draining || queue.length > 0) {
        startDrain();
        await draining;
      }
    },
  };
}

function isOrderRealtimeEvent(event: DashboardEvent): event is OrderRealtimeEvent {
  return (
    event.type === "order.status.updated" ||
    (event.type === "dashboard.metric.observed" && event.metricName === "order.consistency_lag")
  );
}

function eventType(event: OrderRealtimeEvent): EventType;
function eventType(event: unknown): EventType | "unknown";
function eventType(event: unknown): EventType | "unknown" {
  if (typeof event === "object" && event !== null && "type" in event) {
    const type = (event as { type?: unknown }).type;
    if (type === "order.status.updated") return type;
    if (
      type === "dashboard.metric.observed" &&
      "metricName" in event &&
      (event as { metricName?: unknown }).metricName === "order.consistency_lag"
    ) {
      return "order.consistency_lag";
    }
  }
  return "unknown";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function cloneCounters(value: OrderRealtimePublisherCounters): OrderRealtimePublisherCounters {
  return {
    ...value,
    enqueued: { ...value.enqueued },
    published: { ...value.published },
    dropped: { ...value.dropped },
    invalid: { ...value.invalid },
    failed: { ...value.failed },
  };
}
