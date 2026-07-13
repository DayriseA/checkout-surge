import { randomUUID } from "node:crypto";
import type { DashboardEvent, InventoryStatus, QueueStatus } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

export const dashboardQueueRefreshIntervalMs = 2_000;

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

type PendingPublication =
  | { kind: "inventory"; request: DashboardSnapshotPublicationRequest }
  | { kind: "queue"; request: DashboardQueuePublicationRequest };

export class DashboardSnapshotPublicationScheduler
  implements DashboardSnapshotPublicationSchedulerPort
{
  private readonly pending = new Map<string, PendingPublication>();
  private scheduledDrain: NodeJS.Immediate | null = null;
  private delayedQueueRefresh: NodeJS.Timeout | null = null;
  private drainInFlight: Promise<void> | null = null;
  private latestQueueRequest: DashboardQueuePublicationRequest | null = null;
  private accepting = true;

  constructor(
    private readonly options: {
      readInventory(saleOfferId: string): Promise<InventoryStatus>;
      readQueue(): Promise<QueueStatus>;
      publish(event: DashboardEvent): Promise<unknown>;
      logger: CheckoutSurgeLogger;
      maxPendingScopes?: number;
      queueRefreshIntervalMs?: number;
    },
  ) {}

  scheduleInventory(request: DashboardSnapshotPublicationRequest): void {
    this.schedule(`inventory:${request.saleOfferId}`, { kind: "inventory", request });
  }

  scheduleQueue(request: DashboardQueuePublicationRequest): void {
    // The queue projection is global. Keep only the newest publication context while dirty.
    this.latestQueueRequest = request;
    this.cancelDelayedQueueRefresh();
    this.schedule("queue", { kind: "queue", request });
  }

  async flush(): Promise<void> {
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
    await this.flush();
  }

  private schedule(key: string, publication: PendingPublication): void {
    if (!this.accepting) return;

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
      await this.options.publish({
        type: "inventory.updated",
        eventId: randomUUID(),
        ...(publication.request.runId ? { runId: publication.request.runId } : {}),
        correlationId: publication.request.correlationId,
        // Source time prevents a slow read from masquerading as a newer observation.
        occurredAt: inventory.lastUpdatedAt,
        inventory,
      });
      return;
    }

    const queue = await this.options.readQueue();
    try {
      await this.options.publish({
        type: "queue.updated",
        eventId: randomUUID(),
        ...(publication.request.runId ? { runId: publication.request.runId } : {}),
        correlationId: publication.request.correlationId,
        occurredAt: queue.updatedAt,
        queue,
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
