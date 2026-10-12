import { type CheckoutSurgeDatabase, demoRuns, orders } from "@checkout-surge/db";
import { eq, inArray } from "drizzle-orm";

export interface OrderConfirmationState {
  orderId: string;
  confirmedAt: Date | null;
  /** False once the run is terminal (completed, failed, reset). */
  runOpen: boolean;
}

export interface OrderConfirmationReader {
  read(orderIds: readonly string[]): Promise<OrderConfirmationState[]>;
}

const openRunStatuses = new Set(["starting", "active", "draining"]);

export class PostgresOrderConfirmationReader implements OrderConfirmationReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(orderIds: readonly string[]): Promise<OrderConfirmationState[]> {
    const rows = await this.db
      .select({ orderId: orders.id, confirmedAt: orders.confirmedAt, runStatus: demoRuns.status })
      .from(orders)
      .innerJoin(demoRuns, eq(demoRuns.id, orders.runId))
      .where(inArray(orders.id, [...orderIds]));
    return rows.map((row) => ({
      orderId: row.orderId,
      confirmedAt: row.confirmedAt,
      runOpen: openRunStatuses.has(row.runStatus),
    }));
  }
}

interface Waiter {
  deadlineAt: number;
  resolve(confirmedAt: Date | null): void;
}

/**
 * Holds the requests that wait for their order's confirmation by the worker. One timer, running
 * only while requests wait, reads every waiting order in a single query per interval. A wait ends
 * with the confirmation time, or with null at its deadline, when the order is gone (purged) or
 * when its run is terminal (reset, automatic reset, failure).
 */
export class OrderConfirmationWaiter {
  private readonly waiters = new Map<string, Waiter[]>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(
    private readonly options: {
      reader: OrderConfirmationReader;
      intervalMs?: number;
      now?: () => number;
      onReadError?: (error: unknown) => void;
    },
  ) {}

  wait(orderId: string, deadlineAt: number): Promise<Date | null> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(orderId) ?? [];
      waiters.push({ deadlineAt, resolve });
      this.waiters.set(orderId, waiters);
      this.timer ??= setInterval(() => void this.tick(), this.options.intervalMs ?? 250);
    });
  }

  /** Ends every wait; each request then gets its accepted answer. */
  close(): void {
    for (const orderId of [...this.waiters.keys()]) this.settle(orderId, null);
    this.stopWhenIdle();
  }

  async tick(): Promise<void> {
    if (this.reading || this.waiters.size === 0) return;
    this.reading = true;
    try {
      const orderIds = [...this.waiters.keys()];
      let states: Map<string, OrderConfirmationState> | null = null;
      try {
        const rows = await this.options.reader.read(orderIds);
        states = new Map(rows.map((row) => [row.orderId, row]));
      } catch (error) {
        // Deadlines still apply; the next tick reads again.
        this.options.onReadError?.(error);
      }
      const now = this.now();
      for (const orderId of orderIds) {
        const state = states?.get(orderId);
        if (state?.confirmedAt) this.settle(orderId, state.confirmedAt);
        else if (states && !state?.runOpen) this.settle(orderId, null);
        else this.settleExpired(orderId, now);
      }
    } finally {
      this.reading = false;
      this.stopWhenIdle();
    }
  }

  private settle(orderId: string, confirmedAt: Date | null): void {
    for (const waiter of this.waiters.get(orderId) ?? []) waiter.resolve(confirmedAt);
    this.waiters.delete(orderId);
  }

  private settleExpired(orderId: string, now: number): void {
    const waiters = this.waiters.get(orderId) ?? [];
    const remaining = waiters.filter((waiter) => waiter.deadlineAt > now);
    for (const waiter of waiters) if (waiter.deadlineAt <= now) waiter.resolve(null);
    if (remaining.length > 0) this.waiters.set(orderId, remaining);
    else this.waiters.delete(orderId);
  }

  private stopWhenIdle(): void {
    if (this.waiters.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
