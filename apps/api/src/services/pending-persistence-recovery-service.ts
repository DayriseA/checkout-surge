import {
  idempotencyKeySchema,
  type OrderProcessJob,
  type SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  deferPendingPersistenceRecord,
  type PendingPersistenceReadIssue,
  type PendingPersistenceRecord,
  readPendingPersistencePage,
  readPendingPersistenceRecord,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { pendingPersistenceRecoveryDefaults } from "../runtime/pending-persistence-recovery-policy.js";
import type { DashboardSourceDirtySchedulerPort } from "./dashboard-source-dirty-scheduler.js";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";
import type {
  BuyPersistence,
  BuyPersistenceOperations,
  PersistedBuyAcceptance,
  StockReservationGateway,
} from "./reserve-order-service.js";
import { isPersistedBuyForReservation } from "./reserve-order-service.js";

export interface PendingPersistenceRecoverySummary {
  discovered: number;
  attempted: number;
  materialized: number;
  resolved: number;
  deferred: number;
  exhausted: number;
}

export interface PendingPersistenceRecoveryAudit {
  recordAttempt(input: {
    reservation: SecuredReservationHold;
    attemptCount: number;
    attemptedAt: Date;
  }): Promise<void>;
  markResolved(input: { reservationId: string; resolvedAt: Date }): Promise<void>;
  markExhausted(input: {
    reservation: SecuredReservationHold;
    attemptCount: number;
    exhaustedAt: Date;
    error: string;
  }): Promise<void>;
}

export interface BusinessOutcomeDirtyMarker {
  markDirty(input: { saleOfferId: string; runId?: string; correlationId?: string }): void;
}

interface RunScope {
  runId?: string;
  saleOfferId: string;
}

export interface PendingPersistenceAttemptScope {
  persistence: BuyPersistence;
  audit: PendingPersistenceRecoveryAudit;
  stockReservations: Pick<StockReservationGateway, "promoteAccepted">;
  orderProcessJobPublisher: OrderProcessJobPublisher;
  close(): Promise<void>;
}

export interface PendingPersistenceDiscoveryScope {
  redis: CheckoutSurgeRedis;
  close(): Promise<void>;
}

export class PendingPersistenceRecoveryClosedError extends Error {
  constructor() {
    super("Pending-persistence recovery is closing.");
    this.name = "PendingPersistenceRecoveryClosedError";
  }
}

export class PendingPersistenceDiscoveryDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Pending-persistence discovery exceeded its ${timeoutMs}ms bound.`);
    this.name = "PendingPersistenceDiscoveryDeadlineError";
  }
}

/**
 * Sole owner of discovery, retry scheduling, and resolution for interrupted
 * Redis-to-PostgreSQL reservation persistence.
 */
export class PendingPersistenceRecoveryService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<PendingPersistenceRecoverySummary> | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly directRecoveries = new Set<Promise<PersistedBuyAcceptance | null>>();
  private readonly attemptsByReservation = new Map<
    string,
    Promise<{ persisted: PersistedBuyAcceptance; materialized: boolean } | null>
  >();
  private closed = false;
  private activeDirectAttemptCount = 0;
  private readonly activeAttemptControllers = new Set<AbortController>();

  constructor(
    private readonly options: {
      redis: CheckoutSurgeRedis;
      persistence: BuyPersistence;
      audit: PendingPersistenceRecoveryAudit;
      stockReservations: Pick<StockReservationGateway, "promoteAccepted">;
      orderProcessJobPublisher: OrderProcessJobPublisher;
      listRunScopes: (signal: AbortSignal) => Promise<RunScope[]>;
      openDiscoveryScope?: (signal: AbortSignal) => Promise<PendingPersistenceDiscoveryScope>;
      openAttemptScope?: (input: {
        signal: AbortSignal;
        timeoutMs: number;
      }) => Promise<PendingPersistenceAttemptScope>;
      closeDiscovery?: () => Promise<void>;
      idempotencyTtlSeconds: number;
      logger: CheckoutSurgeLogger;
      dashboardSourceDirtyScheduler?: Pick<DashboardSourceDirtySchedulerPort, "scheduleQueue">;
      businessOutcomeUpdates?: BusinessOutcomeDirtyMarker;
      recoveryWindowSeconds?: number;
      maxAttempts?: number;
      initialBackoffMs?: number;
      maxBackoffMs?: number;
      pollIntervalMs?: number;
      discoveryTimeoutMs?: number;
      maxConcurrentDirectAttempts?: number;
      batchSize?: number;
      now?: () => Date;
      schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
      cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
    },
  ) {
    for (const [name, value] of Object.entries(this.policy())) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer.`);
      }
    }
    if (this.policy().initialBackoffMs > this.policy().maxBackoffMs) {
      throw new RangeError("initialBackoffMs must not exceed maxBackoffMs.");
    }
  }

  start(): void {
    this.scheduleNext(0);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.timer) {
      (this.options.cancelSchedule ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    for (const controller of this.activeAttemptControllers) {
      controller.abort(new PendingPersistenceRecoveryClosedError());
    }
    this.closePromise = (async () => {
      const [discoveryCleanup, ...workCleanup] = await Promise.allSettled([
        this.options.closeDiscovery?.(),
        this.inFlight,
        ...this.directRecoveries,
      ]);
      const errors: unknown[] = [];
      if (discoveryCleanup.status === "rejected") errors.push(discoveryCleanup.reason);
      errors.push(
        ...workCleanup.flatMap((result) =>
          result.status === "rejected" && !isCloseTriggeredCancellation(result.reason)
            ? [result.reason]
            : [],
        ),
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Pending-persistence recovery cleanup failed.");
      }
    })();
    return this.closePromise;
  }

  async runOnce(): Promise<PendingPersistenceRecoverySummary> {
    if (this.closed) return emptySummary();
    const controller = new AbortController();
    this.activeAttemptControllers.add(controller);
    const discoveryTimeoutMs = this.policy().discoveryTimeoutMs;
    const discoveryTimer = setTimeout(() => {
      controller.abort(new PendingPersistenceDiscoveryDeadlineError(discoveryTimeoutMs));
    }, discoveryTimeoutMs);
    discoveryTimer.unref();
    this.inFlight = this.runPass(controller, discoveryTimer)
      .catch((error: unknown) => {
        if (isCloseTriggeredCancellation(error, controller.signal)) return emptySummary();
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  recoverReservation(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<PersistedBuyAcceptance | null> {
    if (this.closed) return Promise.resolve(null);
    const recovery = this.recoverReservationExclusive(input)
      .catch((error: unknown) => {
        if (this.closed && isCloseTriggeredCancellation(error)) return null;
        throw error;
      })
      .finally(() => {
        this.directRecoveries.delete(recovery);
      });
    this.directRecoveries.add(recovery);
    return recovery;
  }

  private async recoverReservationExclusive(input: {
    reservation: SecuredReservationHold;
    idempotencyKey: string;
  }): Promise<PersistedBuyAcceptance | null> {
    const read = await readPendingPersistenceRecord(this.options.redis, {
      saleOfferId: input.reservation.saleOfferId,
      reservationId: input.reservation.id,
    });
    if (read.issue) this.logReadIssue(read.issue, input.reservation.saleOfferId);
    if (this.closed) return null;
    const record = read.record;
    if (!record || record.recoveryStatus === "exhausted") return null;
    const now = this.now();
    if (Date.parse(record.nextRecoveryAt) > now.getTime()) return null;
    if (record.idempotencyKey !== input.idempotencyKey) return null;
    return (await this.attemptRecord(record, now, "direct"))?.persisted ?? null;
  }

  private async runPass(
    discoveryController: AbortController,
    discoveryTimer: ReturnType<typeof setTimeout>,
  ): Promise<PendingPersistenceRecoverySummary> {
    let records: PendingPersistenceRecord[];
    let discoveryScope: PendingPersistenceDiscoveryScope | undefined;
    try {
      discoveryScope = await this.options.openDiscoveryScope?.(discoveryController.signal);
      records = await this.discover(
        discoveryController.signal,
        discoveryScope?.redis ?? this.options.redis,
      );
    } finally {
      clearTimeout(discoveryTimer);
      this.activeAttemptControllers.delete(discoveryController);
      await discoveryScope?.close();
    }

    const summary = emptySummary();
    summary.discovered = records.length;
    for (const record of records) {
      if (this.closed) break;
      const recordNow = this.now();
      if (
        recordNow.getTime() < this.recoveryDeadline(record).getTime() &&
        record.recoveryAttemptCount < this.policy().maxAttempts
      ) {
        summary.attempted += 1;
      }
      const result = await this.attemptRecord(record, recordNow, "scheduler");
      if (result) {
        summary.resolved += 1;
        if (result.materialized) summary.materialized += 1;
      } else {
        if (this.closed) break;
        const refreshed = await this.readRecord(record);
        if (refreshed?.recoveryStatus === "exhausted") summary.exhausted += 1;
        else summary.deferred += 1;
      }
    }
    if (summary.discovered > 0) {
      this.options.logger.info(summary, "Pending-persistence recovery pass completed.");
    }
    return summary;
  }

  private async discover(
    signal: AbortSignal,
    redis: CheckoutSurgeRedis,
  ): Promise<PendingPersistenceRecord[]> {
    const records: PendingPersistenceRecord[] = [];
    const scopes = await this.options.listRunScopes(signal);
    for (const scope of scopes) {
      if (signal.aborted || this.closed) break;
      const pageNow = this.now();
      const page = await readPendingPersistencePage(redis, {
        saleOfferId: scope.saleOfferId,
        limit: this.policy().batchSize,
        dueAt: pageNow,
      });
      for (const issue of page.issues) this.logReadIssue(issue, scope.saleOfferId);
      const candidates = page.records.filter((record) =>
        scope.runId ? record.runId === scope.runId : record.runId === undefined,
      );
      records.push(...candidates);
    }
    return records;
  }

  private async attemptRecord(
    record: PendingPersistenceRecord,
    now: Date,
    admission: "scheduler" | "direct",
  ): Promise<{ persisted: PersistedBuyAcceptance; materialized: boolean } | null> {
    if (this.closed) return null;
    const attemptKey = `${record.saleOfferId}:${record.id}`;
    const activeAttempt = this.attemptsByReservation.get(attemptKey);
    if (activeAttempt) return activeAttempt;
    if (
      admission === "direct" &&
      this.activeDirectAttemptCount >= this.policy().maxConcurrentDirectAttempts
    ) {
      return null;
    }
    if (admission === "direct") this.activeDirectAttemptCount += 1;

    const attempt = this.attemptRecordExclusive(record, now).finally(() => {
      if (this.attemptsByReservation.get(attemptKey) === attempt) {
        this.attemptsByReservation.delete(attemptKey);
      }
      if (admission === "direct") this.activeDirectAttemptCount -= 1;
    });
    this.attemptsByReservation.set(attemptKey, attempt);
    return attempt;
  }

  private async attemptRecordExclusive(
    record: PendingPersistenceRecord,
    now: Date,
  ): Promise<{ persisted: PersistedBuyAcceptance; materialized: boolean } | null> {
    const reservation = toReservation(record);
    const idempotencyKey = idempotencyKeySchema.parse(record.idempotencyKey);
    const deadline = this.recoveryDeadline(record);
    if (
      now.getTime() >= deadline.getTime() ||
      record.recoveryAttemptCount >= this.policy().maxAttempts
    ) {
      const reason =
        now.getTime() >= deadline.getTime()
          ? "Recovery window elapsed."
          : "Recovery attempt limit reached.";
      await this.tryExhaust(record, record.recoveryAttemptCount, deadline, reason, now);
      return null;
    }

    const controller = new AbortController();
    this.activeAttemptControllers.add(controller);
    const timeoutMs = Math.max(1, deadline.getTime() - now.getTime());
    const deadlineTimer = setTimeout(() => {
      controller.abort(new Error(`Pending-persistence attempt exceeded its ${timeoutMs}ms bound.`));
    }, timeoutMs);
    deadlineTimer.unref();
    let scope: PendingPersistenceAttemptScope;
    try {
      scope = this.options.openAttemptScope
        ? await this.options.openAttemptScope({ signal: controller.signal, timeoutMs })
        : this.defaultAttemptScope();
    } catch (error) {
      clearTimeout(deadlineTimer);
      this.activeAttemptControllers.delete(controller);
      if (controller.signal.reason instanceof PendingPersistenceRecoveryClosedError) return null;
      await this.handlePreAttemptFailure(record, deadline, error);
      return null;
    }
    const attemptCount = record.recoveryAttemptCount + 1;
    try {
      await scope.audit.recordAttempt({ reservation, attemptCount, attemptedAt: now });
    } catch (error) {
      clearTimeout(deadlineTimer);
      this.activeAttemptControllers.delete(controller);
      try {
        await scope.close();
      } catch (closeError) {
        this.options.logger.warn(
          { err: closeError, reservationId: reservation.id },
          "Pending-persistence attempt cleanup failed after audit rejection.",
        );
      }
      if (controller.signal.reason instanceof PendingPersistenceRecoveryClosedError) return null;
      await this.handlePreAttemptFailure(record, deadline, error);
      return null;
    }
    let auditResolved = false;
    let recoveryResult: { persisted: PersistedBuyAcceptance; materialized: boolean } | undefined;
    try {
      recoveryResult = await this.withPendingPersistenceLock(
        reservation,
        scope.persistence,
        (persistence, runDisposition) =>
          this.materializeAndEnqueue(
            reservation,
            persistence,
            runDisposition,
            scope.orderProcessJobPublisher,
          ),
      );
      this.scheduleQueueSnapshot(reservation);
      this.markBusinessOutcomeDirty(reservation);
      await scope.audit.markResolved({ reservationId: reservation.id, resolvedAt: this.now() });
      auditResolved = true;
      await scope.stockReservations.promoteAccepted({
        idempotencyKey,
        idempotencyTtlSeconds: this.options.idempotencyTtlSeconds,
        reservation,
      });
      return recoveryResult;
    } catch (error) {
      if (controller.signal.reason instanceof PendingPersistenceRecoveryClosedError) return null;
      const message = errorMessage(error);
      const decisionNow = this.now();
      const backoffMs = this.backoffMs(attemptCount);
      const nextRecoveryAt = new Date(decisionNow.getTime() + backoffMs);
      let redisDisposition: "deferred" | "exhausted" | "removed";
      if (
        attemptCount >= this.policy().maxAttempts ||
        decisionNow.getTime() >= deadline.getTime() ||
        nextRecoveryAt.getTime() >= deadline.getTime()
      ) {
        redisDisposition = await this.tryExhaust(
          record,
          attemptCount,
          deadline,
          message,
          decisionNow,
        );
      } else {
        redisDisposition = await deferPendingPersistenceRecord(this.options.redis, {
          saleOfferId: record.saleOfferId,
          reservationId: record.id,
          attemptCount,
          status: "pending",
          nextRecoveryAt,
          recoveryDeadlineAt: deadline,
          lastError: message,
        });
        if (redisDisposition === "deferred") {
          this.options.logger.warn(
            {
              err: error,
              runId: record.runId,
              saleOfferId: record.saleOfferId,
              reservationId: record.id,
              attemptCount,
              nextRecoveryAt: nextRecoveryAt.toISOString(),
            },
            "Pending-persistence recovery attempt will retry.",
          );
        }
      }
      if (auditResolved && redisDisposition === "removed" && recoveryResult) {
        this.options.logger.info(
          {
            runId: record.runId,
            saleOfferId: record.saleOfferId,
            reservationId: record.id,
            attemptCount,
          },
          "Pending-persistence Redis cursor was already resolved after promotion response loss.",
        );
        return recoveryResult;
      }
      if (auditResolved && redisDisposition === "deferred") {
        try {
          await scope.audit.recordAttempt({
            reservation,
            attemptCount,
            attemptedAt: decisionNow,
          });
        } catch (auditError) {
          this.options.logger.warn(
            { err: auditError, reservationId: reservation.id, attemptCount },
            "Could not restore retryable pending-persistence audit after promotion failed.",
          );
        }
      }
      return null;
    } finally {
      clearTimeout(deadlineTimer);
      this.activeAttemptControllers.delete(controller);
      await scope.close();
    }
  }

  private async tryExhaust(
    record: PendingPersistenceRecord,
    attemptCount: number,
    deadline: Date,
    error: string,
    exhaustedAt: Date,
  ): Promise<"exhausted" | "removed"> {
    const redisDisposition = await deferPendingPersistenceRecord(this.options.redis, {
      saleOfferId: record.saleOfferId,
      reservationId: record.id,
      attemptCount,
      status: "exhausted",
      nextRecoveryAt: deadline,
      recoveryDeadlineAt: deadline,
      lastError: error,
    });
    if (redisDisposition === "removed") return "removed";
    const auditRecorded = await this.recordExhaustionAudit({
      reservation: toReservation(record),
      attemptCount,
      exhaustedAt,
      error,
    });
    this.options.logger.error(
      {
        runId: record.runId,
        saleOfferId: record.saleOfferId,
        reservationId: record.id,
        correlationId: record.correlationId,
        attemptCount,
        recoveryDeadlineAt: deadline.toISOString(),
        error,
        auditRecorded,
      },
      "Pending-persistence recovery exhausted; the Redis hold remains unresolved.",
    );
    return "exhausted";
  }

  private async recordExhaustionAudit(
    input: Parameters<PendingPersistenceRecoveryAudit["markExhausted"]>[0],
  ): Promise<boolean> {
    const controller = new AbortController();
    this.activeAttemptControllers.add(controller);
    const timeoutMs = this.policy().pollIntervalMs;
    const timer = setTimeout(() => {
      controller.abort(
        new Error(`Pending-persistence exhaustion audit exceeded its ${timeoutMs}ms bound.`),
      );
    }, timeoutMs);
    timer.unref();
    let scope: PendingPersistenceAttemptScope | undefined;
    try {
      scope = this.options.openAttemptScope
        ? await this.options.openAttemptScope({ signal: controller.signal, timeoutMs })
        : this.defaultAttemptScope();
      await scope.audit.markExhausted(input);
      return true;
    } catch (auditError) {
      this.options.logger.error(
        {
          err: auditError,
          runId: input.reservation.runId,
          saleOfferId: input.reservation.saleOfferId,
          reservationId: input.reservation.id,
          attemptCount: input.attemptCount,
        },
        "Could not persist pending-persistence exhaustion audit; Redis will retain authoritative exhausted state.",
      );
      return false;
    } finally {
      clearTimeout(timer);
      this.activeAttemptControllers.delete(controller);
      await scope?.close();
    }
  }

  private async materializeAndEnqueue(
    reservation: SecuredReservationHold,
    persistence: BuyPersistenceOperations,
    runDisposition: "admissible" | "terminal" | "invalid",
    orderProcessJobPublisher: OrderProcessJobPublisher,
  ): Promise<{ persisted: PersistedBuyAcceptance; materialized: boolean }> {
    let persisted = await persistence.getPersistedBuyByReservationId(reservation.id);
    let materialized = false;
    if (persisted && !isPersistedBuyForReservation(persisted, reservation)) {
      throw new Error("Durable reservation/order attribution does not match the Redis hold.");
    }
    if (!persisted) {
      if (runDisposition !== "admissible") {
        throw new Error(`Run disposition ${runDisposition} prevents durable materialization.`);
      }
      try {
        persisted = await persistence.persistSecuredReservation({ reservation });
        materialized = true;
      } catch (error) {
        persisted = await persistence.getPersistedBuyByReservationId(reservation.id);
        if (!persisted) throw error;
        if (!isPersistedBuyForReservation(persisted, reservation)) {
          throw new Error("Concurrent durable buy does not match the Redis hold.");
        }
      }
    }
    if (runDisposition === "invalid") {
      throw new Error("Durable buy exists, but its run/sale ownership is invalid.");
    }
    const job = toOrderProcessJob(persisted);
    await orderProcessJobPublisher.enqueue(job);
    return { persisted, materialized };
  }

  private async withPendingPersistenceLock<T>(
    reservation: SecuredReservationHold,
    ownerPersistence: BuyPersistence,
    operation: (
      persistence: BuyPersistenceOperations,
      runDisposition: "admissible" | "terminal" | "invalid",
    ) => Promise<T>,
  ): Promise<T> {
    if (reservation.runId && ownerPersistence.withRunPendingPersistenceLock) {
      return ownerPersistence.withRunPendingPersistenceLock({ reservation, operation });
    }
    if (reservation.runId && ownerPersistence.withRunAdmissionLock) {
      return ownerPersistence.withRunAdmissionLock({
        reservation,
        operation: (persistence) => operation(persistence, "admissible"),
      });
    }
    return operation(ownerPersistence, "admissible");
  }

  private async readRecord(record: PendingPersistenceRecord) {
    const read = await readPendingPersistenceRecord(this.options.redis, {
      saleOfferId: record.saleOfferId,
      reservationId: record.id,
    });
    if (read.issue) this.logReadIssue(read.issue, record.saleOfferId);
    return read.record;
  }

  private backoffMs(attemptCount: number): number {
    const exponentToCap = Math.ceil(
      Math.log2(this.policy().maxBackoffMs / this.policy().initialBackoffMs),
    );
    const exponent = Math.min(Math.max(0, attemptCount - 1), Math.max(0, exponentToCap));
    return Math.min(this.policy().initialBackoffMs * 2 ** exponent, this.policy().maxBackoffMs);
  }

  private recoveryDeadline(record: PendingPersistenceRecord): Date {
    if (record.recoveryDeadlineAt) return new Date(record.recoveryDeadlineAt);
    return new Date(
      new Date(record.securedAt).getTime() + this.policy().recoveryWindowSeconds * 1_000,
    );
  }

  private async deferAfterAuditFailure(
    record: PendingPersistenceRecord,
    deadline: Date,
    now: Date,
    error: unknown,
  ): Promise<"deferred" | "removed"> {
    const nextRecoveryAt = new Date(
      Math.min(now.getTime() + this.policy().initialBackoffMs, deadline.getTime()),
    );
    const redisDisposition = await deferPendingPersistenceRecord(this.options.redis, {
      saleOfferId: record.saleOfferId,
      reservationId: record.id,
      attemptCount: record.recoveryAttemptCount,
      status: "pending",
      nextRecoveryAt,
      recoveryDeadlineAt: deadline,
      lastError: errorMessage(error),
    });
    if (redisDisposition === "exhausted") {
      throw new Error("Pending recovery deferral returned an exhausted disposition.");
    }
    if (redisDisposition === "deferred") {
      this.options.logger.error(
        {
          err: error,
          runId: record.runId,
          saleOfferId: record.saleOfferId,
          reservationId: record.id,
          attemptCount: record.recoveryAttemptCount,
          nextRecoveryAt: nextRecoveryAt.toISOString(),
        },
        "Could not persist pending-persistence attempt audit; Redis remains retryable.",
      );
    }
    return redisDisposition;
  }

  private async handlePreAttemptFailure(
    record: PendingPersistenceRecord,
    deadline: Date,
    error: unknown,
  ): Promise<void> {
    const decisionNow = this.now();
    if (decisionNow.getTime() >= deadline.getTime()) {
      await this.tryExhaust(
        record,
        record.recoveryAttemptCount,
        deadline,
        errorMessage(error),
        decisionNow,
      );
      return;
    }
    await this.deferAfterAuditFailure(record, deadline, decisionNow, error);
  }

  private logReadIssue(issue: PendingPersistenceReadIssue, saleOfferId: string): void {
    this.options.logger.error(
      { saleOfferId, reservationId: issue.reservationId, reason: issue.reason },
      "Pending-persistence metadata is invalid; its cursor was quarantined for operator action.",
    );
  }

  private defaultAttemptScope(): PendingPersistenceAttemptScope {
    return {
      persistence: this.options.persistence,
      audit: this.options.audit,
      stockReservations: this.options.stockReservations,
      orderProcessJobPublisher: this.options.orderProcessJobPublisher,
      close: async () => undefined,
    };
  }

  private scheduleNext(delayMs: number): void {
    const schedule = this.options.schedule ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error: unknown) => {
          this.options.logger.error({ err: error }, "Pending-persistence recovery pass failed.");
        })
        .finally(() => {
          if (!this.closed) this.scheduleNext(this.policy().pollIntervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private scheduleQueueSnapshot(reservation: SecuredReservationHold): void {
    try {
      this.options.dashboardSourceDirtyScheduler?.scheduleQueue({
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
      });
    } catch {}
  }

  private markBusinessOutcomeDirty(reservation: SecuredReservationHold): void {
    try {
      this.options.businessOutcomeUpdates?.markDirty({
        saleOfferId: reservation.saleOfferId,
        ...(reservation.runId ? { runId: reservation.runId } : {}),
        correlationId: reservation.correlationId,
      });
    } catch {}
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private policy() {
    return {
      recoveryWindowSeconds:
        this.options.recoveryWindowSeconds ??
        pendingPersistenceRecoveryDefaults.recoveryWindowSeconds,
      maxAttempts: this.options.maxAttempts ?? pendingPersistenceRecoveryDefaults.maxAttempts,
      initialBackoffMs:
        this.options.initialBackoffMs ?? pendingPersistenceRecoveryDefaults.initialBackoffMs,
      maxBackoffMs: this.options.maxBackoffMs ?? pendingPersistenceRecoveryDefaults.maxBackoffMs,
      pollIntervalMs:
        this.options.pollIntervalMs ?? pendingPersistenceRecoveryDefaults.pollIntervalMs,
      discoveryTimeoutMs:
        this.options.discoveryTimeoutMs ?? pendingPersistenceRecoveryDefaults.discoveryTimeoutMs,
      maxConcurrentDirectAttempts:
        this.options.maxConcurrentDirectAttempts ??
        pendingPersistenceRecoveryDefaults.maxConcurrentDirectAttempts,
      batchSize: this.options.batchSize ?? pendingPersistenceRecoveryDefaults.batchSize,
    };
  }
}

function emptySummary(): PendingPersistenceRecoverySummary {
  return { discovered: 0, attempted: 0, materialized: 0, resolved: 0, deferred: 0, exhausted: 0 };
}

function toReservation(record: PendingPersistenceRecord): SecuredReservationHold {
  return {
    id: record.id,
    saleOfferId: record.saleOfferId,
    correlationId: record.correlationId,
    ...(record.runId ? { runId: record.runId } : {}),
    quantity: record.quantity,
    reservationToken: record.reservationToken,
    securedAt: record.securedAt,
    expiresAt: record.expiresAt,
  };
}

function toOrderProcessJob(persisted: PersistedBuyAcceptance): OrderProcessJob {
  return {
    orderId: persisted.order.id,
    publicOrderId: persisted.order.publicOrderId,
    reservationId: persisted.order.reservationId,
    saleOfferId: persisted.order.saleOfferId,
    correlationId: persisted.order.correlationId,
    ...(persisted.order.runId ? { runId: persisted.order.runId } : {}),
    quantity: persisted.order.quantity,
    queuedAt: persisted.order.queuedAt,
    processingGeneration: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCloseTriggeredCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (
    signal &&
    !(signal.aborted && signal.reason instanceof PendingPersistenceRecoveryClosedError)
  ) {
    return false;
  }
  if (error instanceof AggregateError) {
    return (
      error.errors.length > 0 && error.errors.every((cause) => isCloseTriggeredCancellation(cause))
    );
  }
  if (error instanceof PendingPersistenceRecoveryClosedError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "57014" || code === "CONNECTION_CLOSED" || code === "CONNECTION_DESTROYED")
    return true;
  return (
    error.message === "Connection is closed." ||
    error.message === "Connection is closed" ||
    (error.cause !== undefined && isCloseTriggeredCancellation(error.cause))
  );
}
