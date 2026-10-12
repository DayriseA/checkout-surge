import type { InventoryCountBatch } from "@checkout-surge/db";

export const inventoryCountFlushIntervalMs = 100;

/**
 * When PostgreSQL decides the stock, a buyer turned away writes nothing: this process counts the
 * answers in memory and adds them to the run's live counters in one batch per interval.
 */
export class BatchedInventoryCounts {
  private readonly pending = new Map<string, InventoryCountBatch>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      apply(batch: InventoryCountBatch): Promise<unknown>;
      onError(error: unknown, batch: InventoryCountBatch): void;
      flushIntervalMs?: number;
    },
  ) {}

  recordSoldOut(input: { runId: string; saleOfferId: string; observedAt: Date }): void {
    const batch = this.batchFor(input);
    batch.soldOut += 1;
    batch.latestSoldOutAt = input.observedAt.toISOString();
  }

  recordReserved(input: {
    runId: string;
    saleOfferId: string;
    quantity: number;
    reservedAt: Date;
  }): void {
    const batch = this.batchFor(input);
    batch.reservedUnits += input.quantity;
    batch.latestReservedAt = input.reservedAt.toISOString();
    const second = Math.floor(input.reservedAt.getTime() / 1000);
    const slot = batch.reservationsPerSecond.find(([observed]) => observed === second);
    if (slot) slot[1] += 1;
    else batch.reservationsPerSecond.push([second, 1]);
  }

  async flush(): Promise<void> {
    const batches = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(
      batches.map((batch) =>
        this.options.apply(batch).catch((error: unknown) => this.options.onError(error, batch)),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
  }

  private batchFor(input: { runId: string; saleOfferId: string }): InventoryCountBatch {
    let batch = this.pending.get(input.runId);
    if (!batch) {
      batch = {
        runId: input.runId,
        saleOfferId: input.saleOfferId,
        reservedUnits: 0,
        latestReservedAt: null,
        soldOut: 0,
        latestSoldOutAt: null,
        reservationsPerSecond: [],
      };
      this.pending.set(input.runId, batch);
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.flushIntervalMs ?? inventoryCountFlushIntervalMs);
    this.timer.unref();
    return batch;
  }
}
