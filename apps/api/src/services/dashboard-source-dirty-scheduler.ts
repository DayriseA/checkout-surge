import {
  type DashboardProjectionDirtySignal,
  dashboardLiveUpdateExpectedIntervalMs,
  type QueueStatus,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

export const soldOutPublicationWindowMs = 500;

export interface DashboardInventoryDirtyRequest {
  saleOfferId: string;
  runId: string;
  correlationId: string;
}

export interface DashboardQueueDirtyRequest {
  runId: string;
  correlationId: string;
}

export interface DashboardSourceDirtySchedulerPort {
  scheduleInventory(request: DashboardInventoryDirtyRequest): void;
  scheduleQueue(request: DashboardQueueDirtyRequest): void;
}

export interface SoldOutObservationPort {
  observeSoldOut(request: DashboardInventoryDirtyRequest): void;
}

type PendingSignal =
  | { kind: "inventory"; request: DashboardInventoryDirtyRequest }
  | { kind: "queue"; request: DashboardQueueDirtyRequest };

/**
 * Coalesces API-owned inventory and queue work before emitting the internal
 * projection-dirty signal. Queue inspection is retained only to keep publishing
 * while work drains; projection assembly remains the sole source of UI values.
 */
export class DashboardSourceDirtyScheduler implements DashboardSourceDirtySchedulerPort {
  private readonly pending = new Map<string, PendingSignal>();
  private readonly pendingSoldOut = new Map<string, DashboardInventoryDirtyRequest>();
  private scheduledDrain: NodeJS.Immediate | null = null;
  private delayedQueueRefresh: NodeJS.Timeout | null = null;
  private soldOutTimer: NodeJS.Timeout | null = null;
  private drainInFlight: Promise<void> | null = null;
  private latestQueueRequest: DashboardQueueDirtyRequest | null = null;
  private accepting = true;
  private abandoned = false;

  constructor(
    private readonly options: {
      readQueue(): Promise<QueueStatus>;
      publish(signal: DashboardProjectionDirtySignal): Promise<unknown>;
      logger: CheckoutSurgeLogger;
      maxPendingScopes?: number;
      queueRefreshIntervalMs?: number;
      soldOutWindowMs?: number;
      closeTimeoutMs?: number;
    },
  ) {}

  scheduleInventory(request: DashboardInventoryDirtyRequest): void {
    this.schedule(inventoryScopeKey(request), { kind: "inventory", request });
  }

  scheduleQueue(request: DashboardQueueDirtyRequest): void {
    this.latestQueueRequest = request;
    this.cancelDelayedQueueRefresh();
    this.schedule("queue", { kind: "queue", request });
  }

  observeSoldOut(request: DashboardInventoryDirtyRequest): void {
    if (!this.accepting) return;
    const key = inventoryScopeKey(request);
    const maximum = this.options.maxPendingScopes ?? 64;
    if (!this.pendingSoldOut.has(key) && this.pendingSoldOut.size >= maximum) {
      const oldest = this.pendingSoldOut.keys().next().value as string | undefined;
      if (oldest) {
        this.pendingSoldOut.delete(oldest);
        this.options.logger.warn(
          { maxPendingScopes: maximum, droppedScope: oldest },
          "Sold-out projection dirty scope limit reached; dropped the oldest scope.",
        );
      }
    }
    this.pendingSoldOut.set(key, request);
    if (this.soldOutTimer) return;
    this.soldOutTimer = setTimeout(() => {
      this.soldOutTimer = null;
      this.releaseSoldOutScopes();
    }, this.options.soldOutWindowMs ?? soldOutPublicationWindowMs);
    this.soldOutTimer.unref();
  }

  clearRun(runId: string): void {
    for (const [key, request] of this.pendingSoldOut) {
      if (request.runId === runId) this.pendingSoldOut.delete(key);
    }
    for (const [key, signal] of this.pending) {
      if (signal.request.runId === runId) this.pending.delete(key);
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
      if (!this.drainInFlight) this.startDrain();
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

  private schedule(key: string, signal: PendingSignal, duringClose = false): void {
    if (!this.accepting && !duringClose) return;
    const maximum = this.options.maxPendingScopes ?? 64;
    if (!this.pending.has(key) && this.pending.size >= maximum) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest) this.pending.delete(oldest);
      this.options.logger.warn(
        { maxPendingScopes: maximum, droppedScope: oldest },
        "Dashboard dirty scope limit reached; dropped the oldest scope.",
      );
    }
    this.pending.set(key, signal);
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
      if (this.pending.size > 0 && this.accepting) this.scheduleNextDrain();
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

  private async publishBatch(batch: readonly PendingSignal[]): Promise<void> {
    for (const signal of batch) {
      if (this.abandoned) break;
      try {
        await this.publishSignal(signal);
      } catch (error) {
        this.options.logger.error(
          {
            err: error,
            signal: signal.kind,
            ...(signal.kind === "inventory" ? { saleOfferId: signal.request.saleOfferId } : {}),
            runId: signal.request.runId,
            correlationId: signal.request.correlationId,
          },
          "Dashboard projection dirty publication failed.",
        );
        if (signal.kind === "queue") this.scheduleDelayedQueueRefresh();
      }
    }
  }

  private async publishSignal(signal: PendingSignal): Promise<void> {
    if (signal.kind === "inventory") {
      await this.options.publish({
        type: "dashboard.projection.dirty",
        correlationId: signal.request.correlationId,
      });
      return;
    }

    const queue = await this.options.readQueue();
    try {
      await this.options.publish({
        type: "dashboard.projection.dirty",
        correlationId: signal.request.correlationId,
      });
    } finally {
      if (queue.depth > 0 || queue.counts.active > 0) this.scheduleDelayedQueueRefresh();
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
    }, this.options.queueRefreshIntervalMs ?? dashboardLiveUpdateExpectedIntervalMs);
    this.delayedQueueRefresh.unref();
  }

  private cancelDelayedQueueRefresh(): void {
    if (!this.delayedQueueRefresh) return;
    clearTimeout(this.delayedQueueRefresh);
    this.delayedQueueRefresh = null;
  }
}

function inventoryScopeKey(request: DashboardInventoryDirtyRequest): string {
  return `inventory:${request.runId}:${request.saleOfferId}`;
}
