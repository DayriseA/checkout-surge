import type { TrafficCompletionReport } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import {
  isRetryableCompletionLoadApiError,
  LoadApiHttpError,
  type LoadApiClient,
} from "./api-client.js";
import type { ExecutionStore } from "./execution-store.js";

export const defaultCompletionDeliveryRetryIntervalMs = 5_000;
export const maxCompletionDeliveryRetryIntervalMs = 60_000;

export interface CompletionDelivery {
  start(): Promise<void>;
  persist(report: TrafficCompletionReport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Sole owner of a completion from durable publication through matching API acknowledgement.
 * The single-slot journal makes a queue or lease unnecessary.
 */
export class CompletionDeliveryCoordinator implements CompletionDelivery {
  private started = false;
  private stopping = false;
  private deliveryRequested = false;
  private activeDelivery: Promise<void> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      executionStore: ExecutionStore;
      apiClient: Pick<LoadApiClient, "sendCompletion">;
      logger: CheckoutSurgeLogger;
      retryIntervalMs?: number;
    },
  ) {
    if (
      options.retryIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.retryIntervalMs) ||
        options.retryIntervalMs <= 0 ||
        options.retryIntervalMs > maxCompletionDeliveryRetryIntervalMs)
    ) {
      throw new Error(
        `Completion delivery retry interval must be a positive integer no greater than ${maxCompletionDeliveryRetryIntervalMs}.`,
      );
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopping) throw new Error("Completion delivery coordinator is stopping.");
    this.started = true;
    await this.requestDelivery();
  }

  async persist(report: TrafficCompletionReport): Promise<void> {
    const outcome = await this.options.executionStore.publishCompletion(report);
    if (outcome === "execution_mismatch") {
      throw new CompletionPersistenceError(
        "The durable execution journal no longer matches the produced completion.",
      );
    }
    if (outcome === "completion_conflict") {
      throw new CompletionPersistenceError(
        "The durable execution journal already contains a different completion.",
      );
    }

    if (this.started && !this.stopping) void this.requestDelivery();
  }

  async close(): Promise<void> {
    if (this.stopping) {
      await this.activeDelivery;
      return;
    }
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deliveryRequested = false;
    await this.activeDelivery;
  }

  private requestDelivery(): Promise<void> {
    if (!this.started || this.stopping) return Promise.resolve();
    this.deliveryRequested = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.activeDelivery ??= this.drainRequestedDelivery().finally(() => {
      this.activeDelivery = null;
    });
    return this.activeDelivery;
  }

  private async drainRequestedDelivery(): Promise<void> {
    while (this.deliveryRequested && !this.stopping) {
      this.deliveryRequested = false;
      const delivered = await this.deliverOnce();
      if (!delivered) {
        this.scheduleRetry();
        return;
      }
    }
  }

  private async deliverOnce(): Promise<boolean> {
    let pendingCompletion: TrafficCompletionReport | null = null;
    try {
      const execution = await this.options.executionStore.read();
      if (execution?.state !== "completion_pending") return true;
      pendingCompletion = execution.completion;

      await this.options.apiClient.sendCompletion(pendingCompletion);
      if (!(await this.options.executionStore.acknowledgeCompletion(pendingCompletion))) {
        throw new Error("The durable completion changed before acknowledgement was recorded.");
      }
      return true;
    } catch (error) {
      if (
        !isRetryableCompletionLoadApiError(error) &&
        error instanceof LoadApiHttpError &&
        error.status !== undefined &&
        pendingCompletion
      ) {
        const rejection = {
          reason: error.message,
          httpStatus: error.status,
          rejectedAt: new Date().toISOString(),
        };
        try {
          if (!(await this.options.executionStore.rejectCompletion(pendingCompletion, rejection))) {
            throw new Error("The durable completion changed before rejection was recorded.");
          }
          this.options.logger.error(
            { err: error, rejection },
            "Traffic completion delivery is permanently abandoned and the report is parked.",
          );
          return true;
        } catch (parkingError) {
          this.options.logger.warn(
            { err: parkingError, rejection },
            "Pending traffic completion remains durable and will be retried.",
          );
          return false;
        }
      }
      this.options.logger.warn(
        { err: error },
        "Pending traffic completion remains durable and will be retried.",
      );
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestDelivery();
    }, this.options.retryIntervalMs ?? defaultCompletionDeliveryRetryIntervalMs);
    this.retryTimer.unref();
  }
}

export class CompletionPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompletionPersistenceError";
  }
}
