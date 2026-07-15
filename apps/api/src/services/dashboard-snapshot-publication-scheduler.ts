import type { DashboardEvent, InventoryStatus, QueueStatus } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

export const dashboardQueueRefreshIntervalMs = 2_000;
export const soldOutPublicationWindowMs = 500;

export interface DashboardSnapshotPublicationRequest {
  saleOfferId: string;
  runId?: string;
  correlationId: string;
}

export interface DashboardQueuePublicationRequest {
  runId?: string;
  correlationId: string;
}

export interface DashboardSnapshotPublicationSchedulerPort {
  scheduleInventory(request: DashboardSnapshotPublicationRequest): void;
  scheduleQueue(request: DashboardQueuePublicationRequest): void;
}

export interface SoldOutObservationPort {
  observeSoldOut(request: DashboardSnapshotPublicationRequest): void;
}

type PendingPublication =
  | { kind: "inventory"; request: DashboardSnapshotPublicationRequest }
  | { kind: "queue"; request: DashboardQueuePublicationRequest };

export class DashboardSnapshotPublicationScheduler
  implements DashboardSnapshotPublicationSchedulerPort
{
  private readonly pending = new Map<string, PendingPublication>();
  private readonly pendingSoldOut = new Map<string, DashboardSnapshotPublicationRequest>();
  private scheduledDrain: NodeJS.Immediate | null = null;
  private delayedQueueRefresh: NodeJS.Timeout | null = null;
  private soldOutTimer: NodeJS.Timeout | null = null;
  private drainInFlight: Promise<void> | null = null;
  private latestQueueRequest: DashboardQueuePublicationRequest | null = null;
  private accepting = true;
  private abandoned = false;

  constructor(
    private readonly options: {
      readInventory(saleOfferId: string): Promise<InventoryStatus>;
      readQueue(): Promise<QueueStatus>;
      publish(event: DashboardEvent): Promise<unknown>;
      logger: CheckoutSurgeLogger;
      maxPendingScopes?: number;
      queueRefreshIntervalMs?: number;
      soldOutWindowMs?: number;
      closeTimeoutMs?: number;
    },
  ) {}

  scheduleInventory(request: DashboardSnapshotPublicationRequest): void {
    this.schedule(inventoryScopeKey(request), { kind: "inventory", request });
  }

  scheduleQueue(request: DashboardQueuePublicationRequest): void {
    // The queue projection is global. Keep only the newest publication context while dirty.
    this.latestQueueRequest = request;
    this.cancelDelayedQueueRefresh();
    this.schedule("queue", { kind: "queue", request });
  }

  observeSoldOut(request: DashboardSnapshotPublicationRequest): void {
    if (!this.accepting) return;
    const key = inventoryScopeKey(request);
    const maxPendingScopes = this.options.maxPendingScopes ?? 64;
    if (!this.pendingSoldOut.has(key) && this.pendingSoldOut.size >= maxPendingScopes) {
      const oldest = this.pendingSoldOut.keys().next().value as string | undefined;
      if (oldest) {
        this.pendingSoldOut.delete(oldest);
        this.options.logger.warn(
          { maxPendingScopes, droppedScope: oldest },
          "Sold-out dashboard observation scope limit reached; dropped the oldest scope.",
        );
      }
    }
    this.pendingSoldOut.set(key, request);
    if (!this.soldOutTimer) {
      this.soldOutTimer = setTimeout(() => {
        this.soldOutTimer = null;
        this.releaseSoldOutScopes();
      }, this.options.soldOutWindowMs ?? soldOutPublicationWindowMs);
      this.soldOutTimer.unref();
    }
  }

  clearRun(runId: string): void {
    for (const [key, request] of this.pendingSoldOut) {
      if (request.runId === runId) this.pendingSoldOut.delete(key);
    }
    for (const [key, publication] of this.pending) {
      if (publication.request.runId === runId) this.pending.delete(key);
    }
    if (this.latestQueueRequest?.runId === runId) {
      this.latestQueueRequest = null;
      this.cancelDelayedQueueRefresh();
    }
  }

  async flush(): Promise<void> {
    if (this.soldOutTimer) {
      clearTimeout(this.soldOutTimer);
      this.soldOutTimer = null;
    }
    this.releaseSoldOutScopes();
    if (this.scheduledDrain) {
      clearImmediate(this.scheduledDrain);
      this.scheduledDrain = null;
    }

    while (this.pending.size > 0 || this.drainInFlight) {
      if (!this.drainInFlight) {
        this.startDrain();
      }
      await this.drainInFlight;
    }
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.cancelDelayedQueueRefresh();
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.abandoned = true;
          this.pending.clear();
          this.pendingSoldOut.clear();
          resolve();
        }, this.options.closeTimeoutMs ?? 5_000);
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    this.pending.clear();
    this.pendingSoldOut.clear();
  }

  private releaseSoldOutScopes(): void {
    const requests = [...this.pendingSoldOut.values()];
    this.pendingSoldOut.clear();
    for (const request of requests) {
      this.schedule(inventoryScopeKey(request), { kind: "inventory", request }, true);
    }
  }

  private schedule(key: string, publication: PendingPublication, duringClose = false): void {
    if (!this.accepting && !duringClose) return;

    const maxPendingScopes = this.options.maxPendingScopes ?? 64;
    if (!this.pending.has(key) && this.pending.size >= maxPendingScopes) {
      const oldestKey = this.pending.keys().next().value as string | undefined;
      if (oldestKey) this.pending.delete(oldestKey);
      this.options.logger.warn(
        { maxPendingScopes, droppedScope: oldestKey },
        "Dashboard snapshot publication scope limit reached; coalescing dropped the oldest scope.",
      );
    }
    this.pending.set(key, publication);

    if (!this.scheduledDrain && !this.drainInFlight) {
      this.scheduledDrain = setImmediate(() => {
        this.scheduledDrain = null;
        this.startDrain();
      });
      this.scheduledDrain.unref();
    }
  }

  private startDrain(): void {
    if (this.drainInFlight || this.pending.size === 0) return;

    const batch = [...this.pending.values()];
    this.pending.clear();
    this.drainInFlight = this.publishBatch(batch).finally(() => {
      this.drainInFlight = null;
      if (this.pending.size > 0 && this.accepting) {
        this.scheduleNextDrain();
      }
    });
  }

  private scheduleNextDrain(): void {
    if (this.scheduledDrain || this.drainInFlight) return;
    this.scheduledDrain = setImmediate(() => {
      this.scheduledDrain = null;
      this.startDrain();
    });
    this.scheduledDrain.unref();
  }

  private async publishBatch(batch: readonly PendingPublication[]): Promise<void> {
    // Deliberately sequential: there is at most one inspection/publication operation in flight.
    for (const publication of batch) {
      if (this.abandoned) break;
      try {
        await this.publishSnapshot(publication);
      } catch (error) {
        const request = publication.request;
        this.options.logger.error(
          {
            err: error,
            signal: publication.kind,
            ...(publication.kind === "inventory"
              ? { saleOfferId: publication.request.saleOfferId }
              : {}),
            ...(request.runId ? { runId: request.runId } : {}),
            correlationId: request.correlationId,
          },
          "Dashboard snapshot inspection or publication failed.",
        );
        if (publication.kind === "queue") {
          this.scheduleDelayedQueueRefresh();
        }
      }
    }
  }

  private async publishSnapshot(publication: PendingPublication): Promise<void> {
    if (publication.kind === "inventory") {
      const inventory = await this.options.readInventory(publication.request.saleOfferId);
      const common = {
        type: "dashboard.metric.observed" as const,
        ...(publication.request.runId ? { runId: publication.request.runId } : {}),
        correlationId: publication.request.correlationId,
        occurredAt: latestInventoryObservationAt(inventory),
        observedAt: latestInventoryObservationAt(inventory),
        saleOfferId: inventory.saleOfferId,
      };
      await this.options.publish({
        ...common,
        metricName: "inventory.remaining",
        value: inventory.remainingStock,
        unit: "items",
      });
      await this.options.publish({
        ...common,
        metricName: "inventory.sold_out_rejection",
        value: inventory.soldOutPressure.rejectionCount,
        unit: "rejections",
        aggregation: "cumulative",
      });
      return;
    }

    const queue = await this.options.readQueue();
    try {
      await this.options.publish({
        type: "dashboard.metric.observed",
        ...(publication.request.runId ? { runId: publication.request.runId } : {}),
        correlationId: publication.request.correlationId,
        occurredAt: queue.updatedAt,
        observedAt: queue.updatedAt,
        metricName: "queue.depth",
        value: queue.depth,
        unit: "jobs",
        queueName: queue.name,
      });
    } finally {
      if (queue.depth > 0 || queue.counts.active > 0) {
        this.scheduleDelayedQueueRefresh();
      }
    }
  }

  private scheduleDelayedQueueRefresh(): void {
    if (
      !this.accepting ||
      this.delayedQueueRefresh ||
      this.pending.has("queue") ||
      !this.latestQueueRequest
    ) {
      return;
    }

    this.delayedQueueRefresh = setTimeout(() => {
      this.delayedQueueRefresh = null;
      const request = this.latestQueueRequest;
      if (request) this.schedule("queue", { kind: "queue", request });
    }, this.options.queueRefreshIntervalMs ?? dashboardQueueRefreshIntervalMs);
    this.delayedQueueRefresh.unref();
  }

  private cancelDelayedQueueRefresh(): void {
    if (!this.delayedQueueRefresh) return;
    clearTimeout(this.delayedQueueRefresh);
    this.delayedQueueRefresh = null;
  }
}

function latestInventoryObservationAt(inventory: InventoryStatus): string {
  const soldOutObservedAt = inventory.soldOutPressure.latestObservedAt;
  if (!soldOutObservedAt) return inventory.lastUpdatedAt;
  return Date.parse(soldOutObservedAt) > Date.parse(inventory.lastUpdatedAt)
    ? soldOutObservedAt
    : inventory.lastUpdatedAt;
}

function inventoryScopeKey(request: DashboardSnapshotPublicationRequest): string {
  return `inventory:${request.runId ?? "none"}:${request.saleOfferId}`;
}
