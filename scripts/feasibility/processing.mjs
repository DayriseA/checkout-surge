import { HttpErpOrderConfirmation } from "../../apps/worker/dist/application/erp-confirmation-client.js";
import {
  ErpUnresolvedCallReconciler,
  ScheduledErpOrderConfirmation,
} from "../../apps/worker/dist/application/erp-reconciliation.js";
import { createNotificationRecordJobHandler } from "../../apps/worker/dist/application/notification-record-job-handler.js";
import { AdaptiveErpRuntimeAdmission } from "../../apps/worker/dist/application/order-process-admission.js";
import { createOrderProcessJobHandler } from "../../apps/worker/dist/application/order-process-job-handler.js";
import { createOrderRecoveryHandoff } from "../../apps/worker/dist/application/order-recovery-scanner.js";
import { PostgresErpAttemptPersistence } from "../../apps/worker/dist/persistence/postgres-erp-attempt-persistence.js";
import { PostgresErpScopeResiliencePersistence } from "../../apps/worker/dist/persistence/postgres-erp-scope-resilience-persistence.js";
import { PostgresNotificationRecordPersistence } from "../../apps/worker/dist/persistence/postgres-notification-record-persistence.js";
import { PostgresOrderRecoveryPersistence } from "../../apps/worker/dist/persistence/postgres-order-recovery-persistence.js";
import { PostgresOrderTransitionPersistence } from "../../apps/worker/dist/persistence/postgres-order-transition-persistence.js";
import { PostgresRunConfigReader } from "../../apps/worker/dist/persistence/postgres-run-config-reader.js";
import { contracts, db, logger, sleep, workerRequire } from "./common.mjs";

const { sql: drizzleSql } = workerRequire("drizzle-orm");

/** Guard every transactional business write without checking out a second connection. */
export function fencedDatabase(database, run) {
  return new Proxy(database, {
    get(target, property) {
      if (property === "transaction")
        return (operation) =>
          target.transaction(async (tx) => {
            await tx.execute(
              drizzleSql`select pg_advisory_xact_lock_shared(hashtext(${db.terminalDemoRunTransitionLockKey(run.runId)}))`,
            );
            const rows = await tx.execute(drizzleSql`select generation from proof_runs
          where run_id=${run.runId} and generation=${run.generation} and not closed`);
            if (rows.length !== 1) throw new Error("Experimental run generation is closed.");
            return operation(tx);
          });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** One shared, explicit pacing authority for every mode; no database connection is held. */
export class ErpPacer {
  constructor(rate, concurrency) {
    this.intervalMs = 1000 / (rate * (1 - contracts.erpDispatchSafetyMargin));
    this.concurrency = concurrency;
    this.active = 0;
    this.nextAt = 0;
  }
  async use(operation, signal) {
    while (this.active >= this.concurrency) await sleep(5, signal);
    signal?.throwIfAborted();
    this.active++;
    try {
      const at = Math.max(performance.now(), this.nextAt);
      this.nextAt = at + this.intervalMs;
      await sleep(Math.max(0, at - performance.now()), signal);
      return await operation();
    } finally {
      this.active--;
    }
  }
}

export async function createProcessing(connection, run, config, { fetchRequest = fetch } = {}) {
  const scopedDb = fencedDatabase(connection.db, run);
  const transitions = new PostgresOrderTransitionPersistence(scopedDb, undefined, 30_000);
  const recovery = new PostgresOrderRecoveryPersistence(connection.db);
  const runConfigReader = new PostgresRunConfigReader(connection.db);
  const attempts = new PostgresErpAttemptPersistence(scopedDb);
  const admission = await AdaptiveErpRuntimeAdmission.restore({
    pauseDelivery: async () => {},
    persistence: new PostgresErpScopeResiliencePersistence(connection.db),
    runConfigReader,
    reconciliationConcurrency: run.snapshot.backpressureConfig.orderProcessConcurrency,
  });
  const pacer = new ErpPacer(
    run.snapshot.erpConfig.maxTps,
    run.snapshot.backpressureConfig.orderProcessConcurrency,
  );
  const reset = new AbortController();
  const active = new Map();
  const notification = createNotificationRecordJobHandler({
    persistence: new PostgresNotificationRecordPersistence(scopedDb),
    logger,
    publishBusinessOutcomeUpdate: async () => {},
  });

  const execute = async (job, delivery, deadlineMs, lookupOnly) => {
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = AbortSignal.any([reset.signal, deadline]);
    let controlGeneration = delivery.processingGeneration ?? job.processingGeneration;
    const client = new HttpErpOrderConfirmation({
      baseUrl: config.erpUrl,
      lookupTimeoutMs: 2000,
      retryAfterPolicy: { fallbackDelayMs: 1000, maximumDelayMs: 30_000 },
      attemptPersistence: attempts,
      runConfigReader,
      logger,
      fetch: (url, options) =>
        fetchRequest(url, {
          ...options,
          signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
        }),
    });
    const reconciler = new ErpUnresolvedCallReconciler({
      client,
      callResolution: recovery,
      admission,
    });
    const scheduled = new ScheduledErpOrderConfirmation({
      client,
      reconciler,
      admission,
      control: recovery,
      allowDispatch: !lookupOnly,
    });
    const confirmation = {
      confirm: async (orderJob, metadata) => {
        controlGeneration = metadata.processingGeneration;
        for (;;) {
          signal.throwIfAborted();
          // A deferral released the lease. This request remains the sole execution owner;
          // no autonomous order-delivery scanner runs alongside this bounded loop.
          await connection.sql`update order_recovery_jobs set next_attempt_at=null,
            lease_expires_at=now()+interval '30 seconds' where order_id=${job.orderId}
            and processing_generation=${metadata.processingGeneration}
            and status in ('pending','enqueued')`;
          const result = await pacer.use(() => scheduled.confirm(orderJob, metadata), signal);
          if (lookupOnly && result.reason === "erp_result_unknown_lookup_only") {
            await recovery.markEscalated({
              recoveryKey: `order:${job.orderId}`,
              error: "Lookup still reports unknown; no post-deadline ERP dispatch is allowed.",
            });
            return result;
          }
          if (result.disposition !== "deferred") return result;
          const waitMs = Math.max(
            5,
            Math.min(1000, (result.nextEligibleAt?.getTime() ?? Date.now() + 100) - Date.now()),
          );
          await sleep(waitMs, signal);
        }
      },
    };
    const handler = createOrderProcessJobHandler({
      persistence: transitions,
      confirmation,
      recovery: createOrderRecoveryHandoff(recovery),
      notificationRecordPublisher: {
        publishForConfirmedOrder: (orderJob, confirmedAt) =>
          notification.handle({
            orderId: orderJob.orderId,
            saleOfferId: orderJob.saleOfferId,
            correlationId: orderJob.correlationId,
            runId: orderJob.runId,
            recipientPlaceholder: `simulated-buyer:${orderJob.publicOrderId}`,
            confirmedAt,
          }),
      },
      logger,
      publishBusinessOutcomeUpdate: async () => {},
    });
    const heartbeat = setInterval(() => {
      void connection.sql`update order_recovery_jobs set lease_expires_at=now()+interval '30 seconds'
        where order_id=${job.orderId} and processing_generation=${controlGeneration}
          and status in ('pending','enqueued')`.catch((error) =>
        logger.error({ error }, "Processing lease renewal failed."),
      );
    }, 5000);
    try {
      await handler.handle(job, delivery);
    } catch (error) {
      if (reset.signal.aborted) throw error;
      if (deadline.aborted) {
        const unresolved = await client.findUnresolvedCall(job.orderId);
        if (!unresolved) {
          const record = await recovery.readControlRecord({ orderId: job.orderId });
          if (record)
            await transitions.transitionToFailed(
              job,
              {
                code: "proof_inline_deadline",
                message: "The buyer's confirmation deadline elapsed before a confirmed ERP result.",
              },
              { ...delivery, processingGeneration: record.processingGeneration },
            );
        } else {
          // Preserve evidence rather than falsely reporting an unknown ERP result as failed.
          await recovery.recordRecoverable({
            job,
            delivery,
            reason: "proof_deadline_uncertain",
            error,
          });
          await recovery.markEscalated({
            recoveryKey: `order:${job.orderId}`,
            error:
              "Proof deadline reached with an unresolved ERP call; cell is invalid until reconciled.",
          });
        }
      } else throw error;
    } finally {
      clearInterval(heartbeat);
    }
    const [order] =
      await connection.sql`select status,confirmed_at as "confirmedAt",failure_code as code
      from orders where id=${job.orderId}`;
    if (order?.confirmedAt) order.confirmedAt = new Date(order.confirmedAt).toISOString();
    return order;
  };
  return {
    recovery,
    execute(job, delivery, deadlineMs = 600_000, { lookupOnly = false } = {}) {
      let promise = active.get(job.orderId);
      if (!promise) {
        promise = execute(job, delivery, deadlineMs, lookupOnly).finally(() =>
          active.delete(job.orderId),
        );
        active.set(job.orderId, promise);
      }
      return promise;
    },
    reset() {
      reset.abort(new Error("Experiment reset."));
    },
    async close() {
      reset.abort();
      await Promise.allSettled(active.values());
      await admission.close();
    },
    get activeCount() {
      return active.size;
    },
  };
}
