import type {
  ErpCircuitBreakerSnapshot,
  ErpCircuitState,
  OrderProcessJob,
} from "@checkout-surge/contracts";
import type {
  OrderConfirmation,
  OrderProcessDeliveryMetadata,
} from "./order-process-job-handler.js";

export type { ErpCircuitBreakerSnapshot, ErpCircuitState };

export class ErpCircuitOpenError extends Error {
  override readonly name = "ErpCircuitOpenError";

  constructor(readonly retryAfterMs: number) {
    super(`ERP circuit is open; retry after ${retryAfterMs}ms.`);
  }
}

export function isTemporaryErpCircuitError(error: unknown): boolean {
  return error instanceof ErpCircuitOpenError;
}

export interface ErpCircuitBreakerOptions {
  confirmation: OrderConfirmation;
  failureThreshold: number;
  resetTimeoutMs: number;
  isCountedFailure: (error: unknown) => boolean;
  onStateChange?: (snapshot: ErpCircuitBreakerSnapshot) => void | Promise<void>;
  now?: () => Date;
}

export class ErpCircuitBreaker implements OrderConfirmation {
  private readonly confirmation: OrderConfirmation;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly isCountedFailure: (error: unknown) => boolean;
  private readonly onStateChange:
    | ((snapshot: ErpCircuitBreakerSnapshot) => void | Promise<void>)
    | undefined;
  private readonly now: () => Date;
  private state: ErpCircuitState = "closed";
  private consecutiveFailureCount = 0;
  private openedAt: Date | null = null;
  private halfOpenProbeInFlight = false;
  private updatedAt: Date;

  constructor(options: ErpCircuitBreakerOptions) {
    this.confirmation = options.confirmation;
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs;
    this.isCountedFailure = options.isCountedFailure;
    this.onStateChange = options.onStateChange;
    this.now = options.now ?? (() => new Date());
    this.updatedAt = this.now();
    this.reportStateChange();
  }

  async confirm(job: OrderProcessJob, delivery: OrderProcessDeliveryMetadata): Promise<void> {
    this.enterHalfOpenIfReady();

    if (this.state === "open") {
      throw new ErpCircuitOpenError(this.retryAfterMs());
    }

    if (this.state === "half_open" && this.halfOpenProbeInFlight) {
      throw new ErpCircuitOpenError(this.resetTimeoutMs);
    }

    const isHalfOpenProbe = this.state === "half_open";
    if (isHalfOpenProbe) {
      this.halfOpenProbeInFlight = true;
      this.touch();
    }

    try {
      await this.confirmation.confirm(job, delivery);
      this.close();
    } catch (error) {
      if (this.isCountedFailure(error)) {
        this.recordFailure();
      }
      throw error;
    } finally {
      if (isHalfOpenProbe) {
        this.halfOpenProbeInFlight = false;
        this.touch();
      }
    }
  }

  snapshot(): ErpCircuitBreakerSnapshot {
    const openedAt = this.openedAt;
    const nextAttemptAt =
      openedAt && this.state === "open" ? new Date(openedAt.getTime() + this.resetTimeoutMs) : null;

    return {
      state: this.state,
      consecutiveFailureCount: this.consecutiveFailureCount,
      failureThreshold: this.failureThreshold,
      resetTimeoutMs: this.resetTimeoutMs,
      openedAt: openedAt ? openedAt.toISOString() : null,
      nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
      halfOpenProbeInFlight: this.halfOpenProbeInFlight,
      updatedAt: this.updatedAt.toISOString(),
    };
  }

  private enterHalfOpenIfReady(): void {
    if (this.state !== "open" || !this.openedAt) {
      return;
    }

    if (this.now().getTime() - this.openedAt.getTime() >= this.resetTimeoutMs) {
      this.state = "half_open";
      this.touch();
    }
  }

  private recordFailure(): void {
    if (this.state === "half_open") {
      this.open();
      return;
    }

    this.consecutiveFailureCount += 1;
    this.touch();

    if (this.consecutiveFailureCount >= this.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.halfOpenProbeInFlight = false;
    this.touch();
  }

  private close(): void {
    this.state = "closed";
    this.consecutiveFailureCount = 0;
    this.openedAt = null;
    this.halfOpenProbeInFlight = false;
    this.touch();
  }

  private retryAfterMs(): number {
    if (!this.openedAt) {
      return this.resetTimeoutMs;
    }

    const nextAttemptAt = this.openedAt.getTime() + this.resetTimeoutMs;
    return Math.max(0, nextAttemptAt - this.now().getTime());
  }

  private touch(): void {
    this.updatedAt = this.now();
    this.reportStateChange();
  }

  private reportStateChange(): void {
    if (!this.onStateChange) {
      return;
    }

    try {
      void Promise.resolve(this.onStateChange(this.snapshot())).catch(() => undefined);
    } catch {
      // State reporting is best-effort and must not break order processing.
    }
  }
}
