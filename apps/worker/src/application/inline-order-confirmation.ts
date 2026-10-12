import { setTimeout as delay } from "node:timers/promises";
import {
  type InlineConfirmationRequest,
  type InlineConfirmationResult,
  inlineConfirmationProcessingWindowMs,
  type OrderProcessJob,
} from "@checkout-surge/contracts";
import type { ErpProcessingBudget } from "./erp-confirmation-client.js";
import type { OrderProcessJobHandler } from "./order-process-job-handler.js";
import type { OrderRecoveryPersistence } from "./order-recovery-scanner.js";

export interface InlineOrderSnapshot {
  job: OrderProcessJob;
  securedAt: Date;
  runActive: boolean;
  result: InlineConfirmationResult;
}

export interface InlineOrderExpiry {
  expireUndispatched(job: OrderProcessJob): Promise<boolean>;
}

export interface InlineOrderReader {
  read(request: InlineConfirmationRequest): Promise<InlineOrderSnapshot | null>;
}

/** Owns the buyer wait; the existing handler and durable control record own processing. */
export class InlineOrderConfirmation {
  private readonly active = new Map<
    string,
    {
      runId: string;
      controller: AbortController;
      result: Promise<InlineConfirmationResult>;
      background: boolean;
    }
  >();
  private readonly cancelledRuns = new Set<string>();
  private closed = false;

  constructor(
    private readonly options: {
      reader: InlineOrderReader;
      expiry: InlineOrderExpiry;
      handler: OrderProcessJobHandler;
      control: Pick<OrderRecoveryPersistence, "readControlRecord" | "claimForPublication">;
      now?: () => Date;
    },
  ) {}

  async status(request: InlineConfirmationRequest): Promise<InlineConfirmationResult> {
    return (await this.options.reader.read(request))?.result ?? pending();
  }

  /** Background recovery consumes durable evidence only, never an ERP dispatch opportunity. */
  async recover(request: InlineConfirmationRequest): Promise<InlineConfirmationResult> {
    if (this.active.has(request.orderId)) return pending();
    const snapshot = await this.options.reader.read(request);
    if (!snapshot) return pending();
    if (
      terminal(snapshot.result) ||
      !snapshot.runActive ||
      this.closed ||
      this.cancelledRuns.has(request.runId) ||
      this.active.has(request.orderId)
    )
      return snapshot.result;
    // Persistence excludes dispatch history and active ownership atomically.
    // Dispatched uncertainty remains lookup-only after the original buyer window.
    if (
      this.now().getTime() >= snapshot.securedAt.getTime() + inlineConfirmationProcessingWindowMs &&
      (await this.options.expiry.expireUndispatched(snapshot.job))
    ) {
      return (await this.options.reader.read(request))?.result ?? snapshot.result;
    }
    const controller = new AbortController();
    const result = this.process(
      request,
      snapshot,
      {
        deadlineAt: new Date(this.now().getTime() + 2_000),
        signal: controller.signal,
      },
      controller,
      true,
    );
    const entry = { runId: request.runId, controller, result, background: true };
    this.active.set(request.orderId, entry);
    try {
      return await result;
    } finally {
      if (this.active.get(request.orderId) === entry) this.active.delete(request.orderId);
    }
  }

  async confirm(
    request: InlineConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<InlineConfirmationResult> {
    const snapshot = await this.options.reader.read(request);
    if (!snapshot) return pending();
    if (terminal(snapshot.result)) return snapshot.result;
    const deadlineAt = new Date(
      snapshot.securedAt.getTime() + inlineConfirmationProcessingWindowMs,
    );
    if (deadlineAt <= this.now()) return timedOut(snapshot.result);
    if (
      this.closed ||
      this.cancelledRuns.has(request.runId) ||
      !snapshot.runActive ||
      signal?.aborted
    ) {
      return snapshot.result;
    }
    let entry = this.active.get(request.orderId);
    if (!entry) {
      const controller = new AbortController();
      const result = this.process(
        request,
        snapshot,
        { deadlineAt, signal: controller.signal },
        controller,
      );
      entry = { runId: request.runId, controller, result, background: false };
      this.active.set(request.orderId, entry);
      const owned = entry;
      void result.finally(() => {
        if (this.active.get(request.orderId) === owned) this.active.delete(request.orderId);
      });
    }
    // A disconnected buyer cancels locally owned work immediately. A later explicit
    // buyer retry can resume only through the same durable claim and original window.
    const abort = () => entry.controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let handoffTimer: NodeJS.Timeout | undefined;
    try {
      const result = entry.background
        ? await Promise.race([
            entry.result,
            new Promise<InlineConfirmationResult>((resolve) => {
              handoffTimer = setTimeout(
                () => resolve(timedOut(snapshot.result)),
                Math.max(0, deadlineAt.getTime() - this.now().getTime()),
              );
            }),
          ])
        : await entry.result;
      // A short lookup must not consume the explicit buyer's remaining processing
      // opportunity. Resume from durable state under the same original deadline.
      if (entry.background && !terminal(result) && !signal?.aborted) {
        if (this.now() >= deadlineAt) return timedOut(result);
        if (this.closed || this.cancelledRuns.has(request.runId)) return result;
        return this.confirm(request, signal);
      }
      return result;
    } finally {
      clearTimeout(handoffTimer);
      signal?.removeEventListener("abort", abort);
    }
  }

  cancelRun(runId: string): void {
    this.cancelledRuns.add(runId);
    for (const entry of this.active.values()) {
      if (entry.runId === runId) entry.controller.abort();
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.active.values()) entry.controller.abort();
  }

  private async process(
    request: InlineConfirmationRequest,
    initial: InlineOrderSnapshot,
    budget: ErpProcessingBudget,
    controller: AbortController,
    lookupOnly = false,
  ): Promise<InlineConfirmationResult> {
    let snapshot = initial;
    const timeoutResult = lookupOnly ? initial.result : timedOut(initial.result);
    const controllerSignal = budget.signal;
    let timer: NodeJS.Timeout | undefined;
    let finish: () => void = () => {};
    const stopped = new Promise<InlineConfirmationResult>((resolve) => {
      finish = () => resolve(this.now() >= budget.deadlineAt ? timeoutResult : snapshot.result);
      controllerSignal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(
        () => controller.abort(),
        Math.max(0, budget.deadlineAt.getTime() - this.now().getTime()),
      );
    });
    // The HTTP client enforces the same deadline even if local persistence is slow.
    const work = (async () => {
      try {
        while (!controllerSignal.aborted && this.now() < budget.deadlineAt) {
          if (!snapshot.runActive || terminal(snapshot.result)) return snapshot.result;
          const control = await this.options.control.readControlRecord({
            orderId: request.orderId,
          });
          let job = snapshot.job;
          let delivery = {
            attemptNumber: 1,
            attemptsMade: 0,
            deliveryId: `inline:${job.orderId}`,
            processingGeneration: job.processingGeneration,
          };
          if (control) {
            const claim = await this.options.control.claimForPublication({
              recoveryKey: control.recoveryKey,
              now: this.now(),
              leaseMs: 30_000,
            });
            if (!claim) {
              if (lookupOnly) return snapshot.result;
              const nowMs = this.now().getTime();
              // An owner can settle or defer before its lease expires. Observe that
              // release promptly; a deferral without a live lease can sleep until due.
              const leaseAt = control.leaseExpiresAt?.getTime() ?? 0;
              const due =
                leaseAt > nowMs
                  ? Math.min(leaseAt, nowMs + 250)
                  : (control.nextAttemptAt?.getTime() ?? 0);
              const waitMs = Math.min(
                budget.deadlineAt.getTime() - nowMs,
                due > nowMs ? due - nowMs : 100,
              );
              await delay(Math.max(1, waitMs), undefined, {
                signal: controllerSignal,
              });
              snapshot = (await this.options.reader.read(request)) ?? snapshot;
              continue;
            }
            job = { ...job, processingGeneration: claim.processingGeneration };
            delivery = {
              attemptNumber: claim.attempt,
              attemptsMade: Math.max(0, claim.attempt - 1),
              deliveryId: claim.jobId,
              processingGeneration: claim.processingGeneration,
            };
          }
          if (controllerSignal.aborted || this.now() >= budget.deadlineAt) break;
          await this.options.handler.handle(job, delivery, {
            budget,
            replayUnknown: false,
            ...(lookupOnly ? { allowDispatch: false } : {}),
          });
          // Fulfilled void includes deferral and owner loss; only durable terminal
          // state can establish confirmation or failure.
          snapshot = (await this.options.reader.read(request)) ?? snapshot;
          if (lookupOnly) return snapshot.result;
          if (!terminal(snapshot.result)) await delay(1, undefined, { signal: controllerSignal });
        }
      } catch {
        // Existing handler recovery retains accepted evidence and persistence errors.
        // Transport failure never establishes a business failure.
        if (!controllerSignal.aborted && this.now() < budget.deadlineAt) {
          try {
            snapshot = (await this.options.reader.read(request)) ?? snapshot;
          } catch {
            /* Retain the last durable read. */
          }
        }
      }
      return this.now() >= budget.deadlineAt ? timeoutResult : snapshot.result;
    })();
    try {
      return await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
      controllerSignal.removeEventListener("abort", finish);
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function pending(): InlineConfirmationResult {
  return { outcome: "order_confirmation_pending", order: null };
}
function terminal(
  result: InlineConfirmationResult,
): result is Extract<
  InlineConfirmationResult,
  { outcome: "order_confirmed" | "order_confirmation_failed" }
> {
  return result.outcome === "order_confirmed" || result.outcome === "order_confirmation_failed";
}
function timedOut(result: InlineConfirmationResult): InlineConfirmationResult {
  return terminal(result)
    ? result
    : {
        outcome: "order_confirmation_timed_out",
        order: result.order,
      };
}
